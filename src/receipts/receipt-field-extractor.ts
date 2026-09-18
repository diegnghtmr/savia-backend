import type { ExtractedReceiptFields, ReceiptField } from './receipt.port.js';
import type {
  OcrEngineLine,
  OcrEngineResult,
  OcrEngineToken,
} from '../platform/ocr-engine.port.js';

export interface FieldExtractorOptions {
  /** Injected clock function for deterministic testing (never uses new Date() for resolution). */
  readonly clock?: () => Date;
}

const SPANISH_MONTH_MAP: Record<string, number> = {
  ene: 1,
  enero: 1,
  jan: 1,
  january: 1,
  feb: 2,
  febrero: 2,
  february: 2,
  mar: 3,
  marzo: 3,
  march: 3,
  abr: 4,
  abril: 4,
  apr: 4,
  april: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  june: 6,
  jul: 7,
  julio: 7,
  july: 7,
  ago: 8,
  agosto: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  setiembre: 9,
  september: 9,
  oct: 10,
  octubre: 10,
  october: 10,
  nov: 11,
  noviembre: 11,
  november: 11,
  dic: 12,
  diciembre: 12,
  dec: 12,
  december: 12,
};

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeapYear ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month)) {
    return 30;
  }
  return 31;
}

function formatCanonicalDate(
  year: number,
  month: number,
  day: number,
): string | null {
  if (year < 1970 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  const yStr = String(year);
  const mStr = String(month).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Parses a Tesseract TSV output string into structured word tokens.
 * Expected columns: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
 */
export function parseTsvTokens(tsv: string): OcrEngineToken[] {
  if (!tsv || typeof tsv !== 'string') return [];

  const rawLines = tsv.split(/\r?\n/);
  const tokens: OcrEngineToken[] = [];

  for (const rawLine of rawLines) {
    const cols = rawLine.split('\t');
    if (cols.length < 11) continue;

    const level = Number(cols[0]);
    if (level !== 5) continue; // Only word tokens

    const text = cols.slice(11).join('\t').trim();
    if (!text) continue;

    const rawConf = Number(cols[10]);
    if (Number.isNaN(rawConf) || rawConf < 0) continue;

    const token: OcrEngineToken = {
      level: 5,
      pageNum: Number(cols[1]) || 1,
      blockNum: Number(cols[2]) || 1,
      parNum: Number(cols[3]) || 1,
      lineNum: Number(cols[4]) || 1,
      wordNum: Number(cols[5]) || 1,
      left: Number(cols[6]) || 0,
      top: Number(cols[7]) || 0,
      width: Number(cols[8]) || 0,
      height: Number(cols[9]) || 0,
      confidence: Math.max(0, Math.min(1, rawConf / 100)),
      text,
    };

    tokens.push(token);
  }

  return tokens;
}

/**
 * Groups word tokens into lines ordered by vertical position.
 */
export function groupTokensIntoLines(
  tokens: readonly OcrEngineToken[],
): OcrEngineLine[] {
  const lineMap = new Map<string, OcrEngineToken[]>();

  for (const token of tokens) {
    const key = `${token.pageNum}_${token.blockNum}_${token.parNum}_${token.lineNum}`;
    const existing = lineMap.get(key);
    if (existing) {
      existing.push(token);
    } else {
      lineMap.set(key, [token]);
    }
  }

  const lines: OcrEngineLine[] = [];

  for (const lineTokens of lineMap.values()) {
    if (lineTokens.length === 0) continue;

    lineTokens.sort((a, b) => a.left - b.left);
    const first = lineTokens[0]!;
    const text = lineTokens.map((t) => t.text).join(' ');
    const confidence =
      lineTokens.reduce((sum, t) => sum + t.confidence, 0) / lineTokens.length;

    lines.push({
      pageNum: first.pageNum,
      blockNum: first.blockNum,
      parNum: first.parNum,
      lineNum: first.lineNum,
      text,
      confidence,
      tokens: lineTokens,
    });
  }

  lines.sort((a, b) => {
    const aFirst = a.tokens[0];
    const bFirst = b.tokens[0];
    return (aFirst?.top ?? 0) - (bFirst?.top ?? 0);
  });

  return lines;
}

const NOISE_MERCHANT_PATTERNS = [
  /^[=\-_*#\s.:]+$/,
  /\b(FACTURA|RECIBO|RECEIPT|TICKET|COMPROBANTE|VENTA|SIMPLIFICADA|ELECTRONICA)\b/i,
  /\b(BIENVENIDO|BIENVENIDOS|WELCOME|GRACIAS)\b/i,
  /\b(NIT|RUT|RUC|CIF|NIF|RFC)\b[:\s]*/i,
  /\b(TEL|TELEFONO|PHONE|DIR|DIRECCION|ADDRESS)\b[:\s]*/i,
  /\b(CAJA|CAJERO|POS|TERMINAL|REG)\b[:\s]*/i,
  /^[\d\s.,\-/#:]+$/,
];

function extractMerchant(lines: readonly OcrEngineLine[]): ReceiptField | null {
  // Search the top lines for merchant candidate
  const topLines = lines.slice(0, 10);

  for (const line of topLines) {
    const trimmed = line.text.trim();
    if (trimmed.length < 3) continue;

    const letters = trimmed.match(/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/g) ?? [];
    if (letters.length < 3) continue;

    const isNoise = NOISE_MERCHANT_PATTERNS.some((pattern) =>
      pattern.test(trimmed),
    );
    if (isNoise) continue;

    // Found merchant candidate
    const conf = Math.min(1, Math.max(0.8, line.confidence));
    return {
      value: trimmed,
      confidence: conf,
    };
  }

  return null;
}

function extractDate(
  lines: readonly OcrEngineLine[],
  options?: FieldExtractorOptions,
): ReceiptField | null {
  // Reference injected clock if provided for deterministic year boundary resolution
  const referenceYear = options?.clock
    ? options.clock().getUTCFullYear()
    : 2026;
  const currentCentury = Math.floor(referenceYear / 100) * 100;
  // Check lines containing explicit date label first
  const dateLabelRegex = /\b(FECHA|DATE|EMISION|EXPEDICION|F\.\s*EMISION)\b/i;

  let bestDate: { value: string; confidence: number } | null = null;

  for (const line of lines) {
    const hasLabel = dateLabelRegex.test(line.text);

    // 1. Check ISO pattern: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
    const isoMatch = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(line.text);
    if (isoMatch) {
      const canonical = formatCanonicalDate(
        Number(isoMatch[1]),
        Number(isoMatch[2]),
        Number(isoMatch[3]),
      );
      if (canonical) {
        const conf = hasLabel
          ? Math.max(0.85, line.confidence)
          : line.confidence;
        if (hasLabel) {
          return { value: canonical, confidence: conf };
        }
        if (!bestDate) {
          bestDate = { value: canonical, confidence: conf };
        }
      }
    }

    // 2. Check Latin DD/MM/YYYY pattern: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
    const latinMatch = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(
      line.text,
    );
    if (latinMatch) {
      const canonical = formatCanonicalDate(
        Number(latinMatch[3]),
        Number(latinMatch[2]),
        Number(latinMatch[1]),
      );
      if (canonical) {
        const conf = hasLabel
          ? Math.max(0.85, line.confidence)
          : line.confidence;
        if (hasLabel) {
          return { value: canonical, confidence: conf };
        }
        if (!bestDate) {
          bestDate = { value: canonical, confidence: conf };
        }
      }
    }

    // 3. Check textual month: "15 de Septiembre de 2026" or "15 Sep 2026"
    const textMonthMatch =
      /\b(\d{1,2})\s*(?:de|\/|-|\s)\s*([a-zA-Z]{3,12})\s*(?:de|\/|-|\s)\s*(\d{4})\b/i.exec(
        line.text,
      );
    if (textMonthMatch) {
      const day = Number(textMonthMatch[1]);
      const monthPrefix = textMonthMatch[2]?.toLowerCase().slice(0, 3) ?? '';
      const month = SPANISH_MONTH_MAP[monthPrefix];
      const year = Number(textMonthMatch[3]);

      if (month) {
        const canonical = formatCanonicalDate(year, month, day);
        if (canonical) {
          const conf = hasLabel
            ? Math.max(0.85, line.confidence)
            : line.confidence;
          if (hasLabel) {
            return { value: canonical, confidence: conf };
          }
          if (!bestDate) {
            bestDate = { value: canonical, confidence: conf };
          }
        }
      }
    }

    // 4. Check 2-digit year pattern: DD/MM/YY
    const twoDigitMatch = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(
      line.text,
    );
    if (twoDigitMatch) {
      const year = currentCentury + Number(twoDigitMatch[3]);
      const canonical = formatCanonicalDate(
        year,
        Number(twoDigitMatch[2]),
        Number(twoDigitMatch[1]),
      );
      if (canonical) {
        const conf = hasLabel
          ? Math.max(0.85, line.confidence)
          : line.confidence;
        if (hasLabel) {
          return { value: canonical, confidence: conf };
        }
        if (!bestDate) {
          bestDate = { value: canonical, confidence: conf };
        }
      }
    }
  }

  return bestDate;
}

function extractCurrency(lines: readonly OcrEngineLine[]): ReceiptField | null {
  // Look for currency code or symbol across lines, prioritizing lines with TOTAL
  const isoCodeRegex = /\b(COP|USD|EUR|MXN|GBP|CAD|BRL|CLP|PEN)\b/i;

  // First pass: look on lines that have TOTAL
  for (const line of lines) {
    if (!/TOTAL/i.test(line.text)) continue;

    const isoMatch = isoCodeRegex.exec(line.text);
    if (isoMatch) {
      return {
        value: isoMatch[1]!.toUpperCase(),
        confidence: Math.max(0.9, line.confidence),
      };
    }

    if (line.text.includes('€')) {
      return {
        value: 'EUR',
        confidence: Math.max(0.85, line.confidence),
      };
    }

    if (line.text.includes('$')) {
      return {
        value: '$',
        confidence: Math.max(0.85, line.confidence),
      };
    }
  }

  // Second pass: look on any line
  for (const line of lines) {
    const isoMatch = isoCodeRegex.exec(line.text);
    if (isoMatch) {
      return {
        value: isoMatch[1]!.toUpperCase(),
        confidence: Math.max(0.85, line.confidence),
      };
    }

    if (line.text.includes('€')) {
      return {
        value: 'EUR',
        confidence: Math.max(0.8, line.confidence),
      };
    }

    if (line.text.includes('$')) {
      return {
        value: '$',
        confidence: Math.max(0.8, line.confidence),
      };
    }
  }

  return null;
}

function parseAmountNumber(text: string): number | null {
  // Find numeric candidates: e.g. "45,000.00", "45.000,50", "45.000", "12.50", "45000"
  const candidateMatch =
    /(?:^|\s|\$|COP|USD|EUR)([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)(?:\s|$|€)/i.exec(
      text,
    );
  if (!candidateMatch || !candidateMatch[1]) return null;

  const raw = candidateMatch[1].trim();

  // Both dot and comma present: last one is decimal separator
  if (raw.includes('.') && raw.includes(',')) {
    const lastDot = raw.lastIndexOf('.');
    const lastComma = raw.lastIndexOf(',');
    if (lastDot > lastComma) {
      // 45,000.00 -> comma thousands, dot decimal
      const normalized = raw.replace(/,/g, '');
      const num = Number(normalized);
      return Number.isFinite(num) && num > 0 ? num : null;
    } else {
      // 45.000,00 -> dot thousands, comma decimal
      const normalized = raw.replace(/\./g, '').replace(',', '.');
      const num = Number(normalized);
      return Number.isFinite(num) && num > 0 ? num : null;
    }
  }

  // Only comma present
  if (raw.includes(',')) {
    // If exactly 3 digits after comma at end (e.g. 45,000): thousands separator
    if (/^\d{1,3},\d{3}$/.test(raw)) {
      const num = Number(raw.replace(',', ''));
      return Number.isFinite(num) && num > 0 ? num : null;
    }
    // Otherwise comma decimal (e.g. 45,50 or 45000,50)
    const normalized = raw.replace(',', '.');
    const num = Number(normalized);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  // Only dot present
  if (raw.includes('.')) {
    // If exactly 3 digits after dot at end (e.g. 45.000): thousands separator
    if (/^\d{1,3}\.\d{3}$/.test(raw)) {
      const num = Number(raw.replace('.', ''));
      return Number.isFinite(num) && num > 0 ? num : null;
    }
    // Otherwise dot decimal (e.g. 12.50)
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  // Plain integer (e.g. 45000)
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function extractTotal(lines: readonly OcrEngineLine[]): ReceiptField | null {
  const totalLabelRegex =
    /\b(TOTAL|TOTAL\s+A\s+PAGAR|VALOR\s+TOTAL|IMPORTE\s+TOTAL|NETO\s+A\s+PAGAR|PAGO\s+TOTAL)\b/i;
  const subtotalRegex =
    /\b(SUBTOTAL|SUB-TOTAL|BASE|IVA|PROPINA|IMPUESTO|DESCUENTO|CAMBIO|VUELTAS)\b/i;

  // Search from bottom up for lines matching TOTAL
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (subtotalRegex.test(line.text)) continue;
    if (!totalLabelRegex.test(line.text)) continue;

    const amount = parseAmountNumber(line.text);
    if (amount !== null) {
      return {
        value: amount,
        confidence: Math.max(0.85, line.confidence),
      };
    }
  }

  // Fallback: look for amount on line immediately following a line with TOTAL
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (totalLabelRegex.test(line.text) && !subtotalRegex.test(line.text)) {
      const nextLine = lines[i + 1]!;
      const amount = parseAmountNumber(nextLine.text);
      if (amount !== null) {
        return {
          value: amount,
          confidence: Math.max(0.8, nextLine.confidence),
        };
      }
    }
  }

  return null;
}

/**
 * Pure, deterministic extractor converting Tesseract TSV output into advisory receipt fields.
 * Derives merchant, date (canonical YYYY-MM-DD), currency, and total.
 * Missing fields are null and never throw.
 */
export function extractReceiptFields(
  tsvOrResult: string | OcrEngineResult,
  options?: FieldExtractorOptions,
): ExtractedReceiptFields {
  try {
    let lines: OcrEngineLine[];

    if (typeof tsvOrResult === 'string') {
      const tokens = parseTsvTokens(tsvOrResult);
      lines = groupTokensIntoLines(tokens);
    } else if (
      tsvOrResult &&
      typeof tsvOrResult === 'object' &&
      Array.isArray(tsvOrResult.lines)
    ) {
      lines = [...tsvOrResult.lines];
    } else {
      return {
        merchant: null,
        date: null,
        currency: null,
        total: null,
      };
    }

    if (lines.length === 0) {
      return {
        merchant: null,
        date: null,
        currency: null,
        total: null,
      };
    }

    const merchant = extractMerchant(lines);
    const date = extractDate(lines, options);
    const currency = extractCurrency(lines);
    const total = extractTotal(lines);

    return {
      merchant,
      date,
      currency,
      total,
    };
  } catch {
    // Pure extractor: missing/corrupt fields return null and never throw
    return {
      merchant: null,
      date: null,
      currency: null,
      total: null,
    };
  }
}
