import {
  appendStatementRow,
  invalidStatement,
  statementAmount,
  statementCurrencyDigits,
  statementDate,
  statementText,
  type StatementRow,
} from './statement-fields.js';

const STATEMENT_TAGS = new Set(['STMTRS', 'CCSTMTRS']);
const TRANSACTION_FIELDS = new Set([
  'DTPOSTED',
  'TRNAMT',
  'FITID',
  'REFNUM',
  'CHECKNUM',
  'NAME',
  'MEMO',
]);
const CONTAINERS = new Set([
  'OFX',
  ...STATEMENT_TAGS,
  'BANKTRANLIST',
  'STMTTRN',
  'ORIGCURRENCY',
]);
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);
const LEGACY_CHARSET =
  /(?:^|[\r\n])CHARSET:[ \t]*(?:1252|CP1252|WINDOWS-1252|ISO-8859-1)[ \t]*(?=[\r\n])/iu;
const OFX_DATE =
  /^(\d{4})(\d{2})(\d{2})(?:(?:[01]\d|2[0-3])[0-5]\d[0-5]\d(?:\.\d{1,3})?(?:\[[+-]?\d{1,2}(?:\.\d{1,3})?(?::[a-z0-9]{1,8})?\])?)?$/iu;

function invalid(): never {
  return invalidStatement('OFX');
}

function ofxBody(bytes: Buffer): { body: string; sgml: boolean } {
  const prefix = bytes.subarray(0, 2048).toString('latin1');
  const legacy = LEGACY_CHARSET.test(prefix.split('<', 1)[0] ?? '');
  const encoding = legacy ? 'windows-1252' : 'utf-8';
  let body = statementText(bytes, 'OFX', encoding).trimStart();
  const sgml = body.startsWith('OFXHEADER:');
  if (sgml) {
    const markupAt = body.indexOf('<');
    if (markupAt < 0 || markupAt > 2048) invalid();
    const header = body
      .slice(0, markupAt)
      .trim()
      .split(/\r\n|\n|\r/u);
    if (
      header[0] !== 'OFXHEADER:100' ||
      !header.includes('DATA:OFXSGML') ||
      !header.some((line) => /^VERSION:1\d{2}$/u.test(line)) ||
      header.some((line) => !/^[A-Z]+:[^:]*$/u.test(line))
    )
      invalid();
    body = body.slice(markupAt);
  } else {
    body = body.replace(
      /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>\s*/iu,
      '',
    );
    body = body.replace(/^<\?OFX\s+[^<>?]*\?>\s*/u, '');
  }
  return { body, sgml };
}

function ofxDate(value: string): string {
  const match = OFX_DATE.exec(value);
  return match ? statementDate(match[1], match[2], match[3]) : '';
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#(?:\d{1,7}|x[\da-fA-F]{1,6})|amp|lt|gt|quot|apos);|&/gu,
    (_, entity?: string) => {
      if (!entity) return invalid();
      if (!entity.startsWith('#')) return NAMED_ENTITIES.get(entity)!;
      const hex = entity.startsWith('#x');
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )
        return String.fromCodePoint(code);
      return invalid();
    },
  );
}

interface Element {
  readonly name: string;
  readonly fields?: Map<string, string>;
  value: string;
  hasChildren: boolean;
  currency?: string;
  digits?: number;
}

export function parseOfx(bytes: Buffer): StatementRow[] {
  const { body, sgml } = ofxBody(bytes);
  const rows: StatementRow[] = [];
  const stack: Element[] = [];
  const token =
    /<(\/?)([A-Za-z][A-Za-z0-9]{0,63})[\t\r\n ]*(\/?)>|([^<]+)|<!--/uy;
  let hasRoot = false;
  let hasList = false;
  function close() {
    const node = stack.pop()!;
    const parent = stack.at(-1);
    const value = node.value.trim();
    if (node.name === 'CURDEF' && parent && STATEMENT_TAGS.has(parent.name)) {
      const currency = value.toUpperCase();
      const digits = statementCurrencyDigits(currency);
      if (node.hasChildren || parent.currency || digits === undefined)
        return invalid();
      parent.currency = currency;
      parent.digits = digits;
    }
    if (parent?.fields && TRANSACTION_FIELDS.has(node.name)) {
      if (node.hasChildren || parent.fields.has(node.name)) invalid();
      parent.fields.set(node.name, value);
    }
    if (node.fields) {
      const statement = stack.at(-2)!;
      const field = (name: string) => node.fields?.get(name) ?? '';
      const fitid = field('FITID');
      appendStatementRow(rows, [
        ofxDate(field('DTPOSTED')),
        statementAmount(field('TRNAMT'), statement.digits!),
        field('NAME') || field('MEMO'),
        fitid || field('REFNUM') || field('CHECKNUM'),
        statement.currency!,
        fitid,
      ]);
    }
  }

  while (token.lastIndex < body.length) {
    const item = token.exec(body) ?? invalid();
    if (item[0] === '<!--') {
      const end = body.indexOf('--', token.lastIndex);
      if (end < 0 || body[end + 2] !== '>') invalid();
      token.lastIndex = end + 3;
      continue;
    }
    const [, closing, tag, selfClosing, content] = item;
    let top = stack.at(-1);
    if (content !== undefined) {
      if (!content.trim()) continue;
      if (!top || top.hasChildren || CONTAINERS.has(top.name)) invalid();
      top.value += decodeEntities(content);
      continue;
    }
    const name = sgml ? tag.toUpperCase() : tag;
    // SGML permits omitted scalar end tags, never omitted aggregate end tags.
    if (
      sgml &&
      top &&
      (top.value ||
        (stack.at(-2)?.fields && TRANSACTION_FIELDS.has(top.name))) &&
      !(closing && top.name === name)
    ) {
      close();
      top = stack.at(-1);
    }
    if (closing) {
      if (selfClosing || top?.name !== name) invalid();
      close();
      continue;
    }
    if (!top) {
      if (hasRoot || name !== 'OFX') invalid();
      hasRoot = true;
    } else {
      if (top.value || stack.length >= 32 || name === 'OFX') invalid();
      top.hasChildren = true;
    }
    if (name === 'BANKTRANLIST') {
      if (hasList || !top?.currency) invalid();
      hasList = true;
    }
    if (name === 'STMTTRN' && top?.name !== 'BANKTRANLIST') invalid();
    // Avoid booking foreign-currency amounts as if they were in CURDEF.
    if (name === 'CURRENCY' && top?.fields) invalid();
    stack.push({
      name,
      value: '',
      hasChildren: false,
      fields: name === 'STMTTRN' ? new Map() : undefined,
    });
    if (selfClosing) close();
  }
  if (stack.length || !hasList || !rows.length) invalid();
  return rows;
}
