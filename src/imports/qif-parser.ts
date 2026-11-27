import {
  appendStatementRow,
  invalidStatement,
  qifDecimalAmount,
  statementDate,
  statementText,
  type StatementRow,
} from './statement-fields.js';

export function parseQifDate(value: string, dayFirst = false): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (iso) return statementDate(iso[1], iso[2], iso[3]);
  const match = /^(\d{1,2})([/-])\s*(\d{1,2})\s*(\2|')\s*(\d{2}|\d{4})$/u.exec(
    value,
  );
  if (!match) return '';
  const [, first, , second, separator, year] = match;
  return statementDate(
    year.length === 4
      ? year
      : `${separator === "'" || Number(year) < 70 ? '20' : '19'}${year}`,
    dayFirst ? second : first,
    dayFirst ? first : second,
  );
}

export function previewQifDate(value: string): string {
  return parseQifDate(value) || parseQifDate(value, true);
}

export function parseQif(bytes: Buffer): StatementRow[] {
  const rows: StatementRow[] = [];
  const fields = new Map<string, string>();
  let hasHeader = false;
  let hasRecord = false;
  for (const [raw] of statementText(bytes, 'QIF').matchAll(/[^\r\n]+/gu)) {
    const line = raw.trim();
    if (!line) continue;
    if (!hasHeader) {
      if (!/^!Type:(?:Bank|Cash|CCard|Oth A|Oth L)$/iu.test(line))
        invalidStatement('QIF');
      hasHeader = true;
    } else if (line === '^') {
      if (!hasRecord) invalidStatement('QIF');
      const amount = (fields.get('T') || fields.get('U') || '').replace(
        /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u,
        (grouped) => grouped.replaceAll(',', ''),
      );
      appendStatementRow(rows, [
        fields.get('D') ?? '',
        qifDecimalAmount(amount),
        fields.get('P') || fields.get('M') || '',
        fields.get('N') ?? '',
      ]);
      fields.clear();
      hasRecord = false;
    } else {
      const field = line[0]!;
      if (!/^[A-Z$%]$/u.test(field)) invalidStatement('QIF');
      hasRecord = true;
      if (!'DTUPMN'.includes(field)) continue;
      if (fields.has(field)) invalidStatement('QIF');
      fields.set(field, line.slice(1).trim());
    }
  }
  if (!hasHeader || hasRecord || !rows.length) invalidStatement('QIF');
  return rows;
}
