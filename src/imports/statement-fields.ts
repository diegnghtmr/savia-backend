export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
const MAX_STATEMENT_LINE_LENGTH = 100_000;

export const STATEMENT_COLUMNS = ['date', 'amount', 'description', 'reference'];
export const OFX_COLUMNS = [...STATEMENT_COLUMNS, 'currency', 'fitid'];
export const QIF_CURRENCY_DIGITS = 2;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export function statementCurrencyDigits(currency: string): number | undefined {
  if (!CURRENCIES.has(currency)) return undefined;
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
  }).resolvedOptions().maximumFractionDigits;
}

export type StatementRow = readonly [
  date: string,
  amount: number | null,
  description: string,
  reference: string,
  currency?: string,
  fitid?: string,
];

export function invalidStatement(format: 'QIF' | 'OFX'): never {
  throw new Error(`${format} statement is invalid or unsupported.`);
}

/** C0 controls other than TAB, LF and CR are never valid in a statement. */
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      return true;
  }
  return false;
}

export function statementText(
  bytes: Buffer,
  format: 'QIF' | 'OFX',
  encoding = 'utf-8',
): string {
  if (bytes.length > MAX_IMPORT_FILE_BYTES)
    throw new Error('The uploaded file exceeds the maximum size.');
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return invalidStatement(format);
  }
  if (hasForbiddenControl(text)) invalidStatement(format);
  for (const [line] of text.matchAll(/[^\r\n]+/gu))
    if (line.length > MAX_STATEMENT_LINE_LENGTH)
      throw new Error(
        `Import lines may contain at most ${MAX_STATEMENT_LINE_LENGTH} characters.`,
      );
  return text;
}

export function appendStatementRow(rows: StatementRow[], row: StatementRow) {
  if (rows.length >= MAX_IMPORT_ROWS)
    throw new Error(
      `The import exceeds the maximum of ${MAX_IMPORT_ROWS} rows.`,
    );
  rows.push(row);
}

export function statementDate(
  year: string,
  month: string,
  day: string,
): string {
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const value = new Date(`${date}T00:00:00Z`);
  if (
    year === '0000' ||
    Number.isNaN(value.getTime()) ||
    value.toISOString().slice(0, 10) !== date
  )
    return '';
  return date;
}

export function statementAmount(value: string, digits: number): number | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? '';
  if (/[^0]/u.test(fraction.slice(digits))) return null;
  const minor = Number(
    `${match[1]}${match[2]}${fraction.slice(0, digits).padEnd(digits, '0')}`,
  );
  return Number.isSafeInteger(minor) ? minor || 0 : null;
}
