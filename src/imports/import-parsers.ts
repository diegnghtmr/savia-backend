import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import type { ImportFormat, ParsedImportRow } from './import.port.js';

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_XLSX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_XLSX_SHARED_STRINGS = 100_000;
export const MAX_XLSX_SHARED_STRING_LENGTH = 100_000;
export const MAX_XLSX_WORKSHEETS = 1;
export const MAX_XLSX_CELLS_PER_ROW = 100;
export const MAX_XLSX_CELL_TEXT_LENGTH = 100_000;
export function normalizeImportDescription(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}
function fieldIndex(
  headers: readonly string[],
  names: readonly string[],
): number {
  return headers.findIndex((h) => names.includes(h.toLowerCase().trim()));
}
function parseRows(
  values: readonly (readonly unknown[])[],
): readonly ParsedImportRow[] {
  const headers = (values[0] ?? []).map((v) => String(v ?? ''));
  const dateAt = fieldIndex(headers, ['date', 'fecha', 'occurred_at']);
  const amountAt = fieldIndex(headers, [
    'amount',
    'amount_minor',
    'importe',
    'value',
  ]);
  const descriptionAt = fieldIndex(headers, [
    'description',
    'descripcion',
    'memo',
    'payee',
  ]);
  return values.slice(1).map((raw, index) => {
    const widthError = raw.length !== headers.length;
    const date = dateAt < 0 ? '' : String(raw[dateAt] ?? '').trim();
    const amountText =
      amountAt < 0
        ? ''
        : String(raw[amountAt] ?? '')
            .trim()
            .replace(',', '.');
    const description =
      descriptionAt < 0 ? '' : String(raw[descriptionAt] ?? '').trim();
    const amount = Number(amountText);
    const errors: string[] = [];
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())
    )
      errors.push('date must be YYYY-MM-DD');
    if (!Number.isSafeInteger(amount) || !Number.isFinite(amount))
      errors.push('amount must be a safe integer minor-unit amount');
    if (!description) errors.push('description is required');
    if (widthError)
      errors.push(
        `row has ${raw.length} fields; expected ${headers.length} fields from the header`,
      );
    return {
      rowNumber: index + 2,
      rawValues: raw,
      parsedDate: errors.length ? null : date,
      parsedAmountMinor: errors.length ? null : amount,
      parsedDescription: errors.length ? null : description,
      classification: errors.length ? 'error' : 'valid',
      error: errors.length
        ? {
            type: 'https://savia.app/problems/import-row-invalid',
            title: 'Import row is invalid',
            status: 422,
            code: 'import-row-invalid',
            traceId: 'import',
            detail: errors.join('; '),
          }
        : null,
      sourceColumns: headers,
    };
  });
}
export function parseCsv(bytes: Buffer): readonly ParsedImportRow[] {
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const rows: string[][] = [[]];
  let value = '';
  let quoted = false;
  let endedWithRecordBreak = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"' && value === '') quoted = true;
    else if (c === ',') {
      rows.at(-1)!.push(value);
      if (rows.at(-1)!.length > MAX_XLSX_CELLS_PER_ROW)
        throw new Error(
          `Import rows may contain at most ${MAX_XLSX_CELLS_PER_ROW} cells.`,
        );
      value = '';
      endedWithRecordBreak = false;
    } else if (c === '\n' || c === '\r') {
      rows.at(-1)!.push(value);
      if (rows.at(-1)!.length > MAX_XLSX_CELLS_PER_ROW)
        throw new Error(
          `Import rows may contain at most ${MAX_XLSX_CELLS_PER_ROW} cells.`,
        );
      value = '';
      endedWithRecordBreak = true;
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (i + 1 < text.length) {
        rows.push([]);
        if (rows.length > MAX_IMPORT_ROWS + 1)
          throw new Error(
            `The import exceeds the maximum of ${MAX_IMPORT_ROWS} rows.`,
          );
      }
    } else {
      value += c;
      endedWithRecordBreak = false;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (!endedWithRecordBreak && (value || rows.at(-1)!.length))
    rows.at(-1)!.push(value);
  if (rows.at(-1)!.length > MAX_XLSX_CELLS_PER_ROW)
    throw new Error(
      `Import rows may contain at most ${MAX_XLSX_CELLS_PER_ROW} cells.`,
    );
  return parseRows(rows.filter((r) => r.some((v) => v !== '')));
}
export async function parseXlsx(
  bytes: Buffer,
): Promise<readonly ParsedImportRow[]> {
  validateXlsxBounds(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('XLSX contains no worksheets.');
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return parseRows(rows);
}

interface ZipEntry {
  readonly compressedSize: number;
  readonly compressionMethod: number;
  readonly flags: number;
  readonly name: string;
  readonly offset: number;
  readonly uncompressedSize: number;
}

function validateXlsxBounds(bytes: Buffer): void {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length)
    throw new Error('XLSX archive is invalid or unsupported.');
  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > bytes.length
  )
    throw new Error('XLSX archive is invalid or unsupported.');
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('XLSX archive is invalid or unsupported.');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      offset === 0xffffffff
    )
      throw new Error('XLSX archive is invalid or unsupported.');
    entries.push({
      compressedSize,
      compressionMethod: bytes.readUInt16LE(cursor + 10),
      flags: bytes.readUInt16LE(cursor + 8),
      name: bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      offset,
      uncompressedSize,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor > directoryOffset + directorySize)
    throw new Error('XLSX archive is invalid or unsupported.');
  const worksheets = entries.filter((entry) =>
    /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name),
  );
  if (worksheets.length > MAX_XLSX_WORKSHEETS)
    throw new Error(
      `XLSX contains more than ${MAX_XLSX_WORKSHEETS} worksheet.`,
    );
  let decompressedBytes = 0;
  for (const entry of entries) {
    if (entry.flags & 1)
      throw new Error('Encrypted XLSX archives are not supported.');
    const localOffset = entry.offset;
    if (
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error('XLSX archive is invalid or unsupported.');
    const nameLength = bytes.readUInt16LE(localOffset + 26);
    const extraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLength + extraLength;
    const endOffset = start + entry.compressedSize;
    if (endOffset > bytes.length)
      throw new Error('XLSX archive is invalid or unsupported.');
    let content: Buffer;
    try {
      content =
        entry.compressionMethod === 0
          ? bytes.subarray(start, endOffset)
          : entry.compressionMethod === 8
            ? inflateRawSync(bytes.subarray(start, endOffset), {
                maxOutputLength: Math.min(
                  entry.uncompressedSize,
                  MAX_XLSX_DECOMPRESSED_BYTES - decompressedBytes,
                ),
              })
            : (() => {
                throw new Error(
                  'XLSX archive uses an unsupported compression method.',
                );
              })();
    } catch {
      throw new Error(
        'XLSX archive is invalid, encrypted, or exceeds its safety limits.',
      );
    }
    decompressedBytes += content.length;
    if (
      decompressedBytes > MAX_XLSX_DECOMPRESSED_BYTES ||
      content.length !== entry.uncompressedSize
    )
      throw new Error('XLSX archive exceeds its decompressed size limit.');
    if (entry.name === 'xl/sharedStrings.xml') validateSharedStrings(content);
    if (/^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name))
      validateWorksheet(content);
  }
}

function validateSharedStrings(content: Buffer): void {
  const xml = content.toString('utf8');
  const strings = [...xml.matchAll(/<si\b[\s\S]*?<\/si>/gu)];
  if (strings.length > MAX_XLSX_SHARED_STRINGS)
    throw new Error(
      `XLSX contains more than ${MAX_XLSX_SHARED_STRINGS} shared strings.`,
    );
  for (const string of strings) {
    const text = [...string[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map((match) => match[1] ?? '')
      .join('');
    if (text.length > MAX_XLSX_SHARED_STRING_LENGTH)
      throw new Error(
        `XLSX shared strings exceed ${MAX_XLSX_SHARED_STRING_LENGTH} characters.`,
      );
  }
}

function validateWorksheet(content: Buffer): void {
  const xml = content.toString('utf8');
  const rows = [...xml.matchAll(/<row\b[\s\S]*?<\/row>/gu)];
  if (rows.length > MAX_IMPORT_ROWS + 1)
    throw new Error(
      `The import exceeds the maximum of ${MAX_IMPORT_ROWS} rows.`,
    );
  for (const row of rows) {
    const cells = [...(row[0].matchAll(/<c\b/gu) ?? [])];
    if (cells.length > MAX_XLSX_CELLS_PER_ROW)
      throw new Error(
        `XLSX rows may contain at most ${MAX_XLSX_CELLS_PER_ROW} cells.`,
      );
    const text = [
      ...row[0].matchAll(/<(?:v|t)\b[^>]*>([\s\S]*?)<\/(?:v|t)>/gu),
    ].map((match) => match[1] ?? '');
    if (text.some((value) => value.length > MAX_XLSX_CELL_TEXT_LENGTH))
      throw new Error(
        `XLSX cells may contain at most ${MAX_XLSX_CELL_TEXT_LENGTH} characters.`,
      );
  }
}
export async function parseImport(
  format: ImportFormat,
  bytes: Buffer,
): Promise<readonly ParsedImportRow[]> {
  if (format === 'csv') return parseCsv(bytes);
  if (format === 'xlsx') return parseXlsx(bytes);
  throw new Error(
    `The declared ${format.toUpperCase()} format is not yet supported.`,
  );
}
