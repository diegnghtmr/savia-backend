import { describe, expect, it } from 'vitest';
import {
  extractReceiptFields,
  parseTsvTokens,
} from '../../src/receipts/receipt-field-extractor.js';

// Helper to build TSV strings deterministically
function buildTsv(
  lines: Array<{
    text: string;
    conf?: number;
    top?: number;
    left?: number;
  }>,
): string {
  const header =
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const rows: string[] = [header];

  let currentTop = 10;
  lines.forEach((line, lineIdx) => {
    const lineNum = lineIdx + 1;
    const top = line.top ?? currentTop;
    currentTop = top + 25;

    const words = line.text.split(/\s+/).filter((w) => w.length > 0);
    let left = line.left ?? 10;
    const conf = line.conf ?? 95;

    words.forEach((word, wordIdx) => {
      const width = word.length * 10;
      rows.push(
        `5\t1\t1\t1\t${lineNum}\t${wordIdx + 1}\t${left}\t${top}\t${width}\t20\t${conf}\t${word}`,
      );
      left += width + 5;
    });
  });

  return rows.join('\n');
}

describe('ReceiptFieldExtractor', () => {
  describe('High-confidence scenario (from spec)', () => {
    it('extracts merchant, date, currency, and total from clean receipt text', () => {
      const tsv = buildTsv([
        { text: 'SUPERMERCADO CENTRAL', conf: 92, top: 10 },
        { text: 'FECHA: 2026-09-15', conf: 90, top: 35 },
        { text: 'TOTAL: COP 45,000.00', conf: 94, top: 60 },
      ]);

      const fields = extractReceiptFields(tsv);

      expect(fields.merchant).not.toBeNull();
      expect(fields.merchant?.value).toBe('SUPERMERCADO CENTRAL');
      expect(fields.merchant?.confidence).toBeGreaterThanOrEqual(0.8);

      expect(fields.date).not.toBeNull();
      expect(fields.date?.value).toBe('2026-09-15');
      expect(fields.date?.confidence).toBeGreaterThanOrEqual(0.85);

      expect(fields.currency).not.toBeNull();
      expect(fields.currency?.value).toBe('COP');
      expect(fields.currency?.confidence).toBeGreaterThanOrEqual(0.9);

      expect(fields.total).not.toBeNull();
      expect(fields.total?.value).toBe(45000);
      expect(fields.total?.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('Merchant extraction', () => {
    it('filters out generic receipt headers and dividers to find merchant', () => {
      const tsv = buildTsv([
        { text: '================================', conf: 95 },
        { text: 'FACTURA ELECTRONICA DE VENTA', conf: 95 },
        { text: 'NIT: 900.123.456-7', conf: 90 },
        { text: 'FARMACIA SAN RAFAEL', conf: 91 },
        { text: 'DIR: CALLE 10 # 5-20', conf: 85 },
        { text: 'FECHA: 2026-09-15', conf: 90 },
        { text: 'TOTAL: $ 25.000', conf: 95 },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.merchant).toEqual({
        value: 'FARMACIA SAN RAFAEL',
        confidence: expect.any(Number),
      });
      expect(fields.merchant!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('returns null when no merchant candidate is found', () => {
      const tsv = buildTsv([
        { text: '-------------------' },
        { text: '123456789' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.merchant).toBeNull();
    });
  });

  describe('Date normalization', () => {
    it('normalizes Latin DD/MM/YYYY date to canonical YYYY-MM-DD', () => {
      const tsv = buildTsv([
        { text: 'TIENDA DON PEDRO' },
        { text: 'FECHA: 15/09/2026' },
        { text: 'TOTAL: 15.000' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.date).toEqual({
        value: '2026-09-15',
        confidence: expect.any(Number),
      });
    });

    it('normalizes dash-separated DD-MM-YYYY date to canonical YYYY-MM-DD', () => {
      const tsv = buildTsv([
        { text: 'CAFE COLOMBIA' },
        { text: 'FECHA DE EMISION: 07-03-2026' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.date?.value).toBe('2026-03-07');
    });

    it('normalizes Spanish month name (15 Sep 2026) to canonical YYYY-MM-DD', () => {
      const tsv = buildTsv([
        { text: 'RESTAURANTE EL CHE' },
        { text: 'Fecha: 15 de Septiembre de 2026' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.date?.value).toBe('2026-09-15');
    });

    it('returns null for impossible dates like month 13 or day 32', () => {
      const tsv = buildTsv([
        { text: 'RESTAURANTE' },
        { text: 'FECHA: 32/13/2026' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.date).toBeNull();
    });

    it('returns null when no date is present', () => {
      const tsv = buildTsv([{ text: 'TIENDA' }, { text: 'TOTAL: 100' }]);

      const fields = extractReceiptFields(tsv);
      expect(fields.date).toBeNull();
    });
  });

  describe('Currency extraction', () => {
    it('extracts ISO currency codes (COP, USD, EUR)', () => {
      const tsvCop = buildTsv([{ text: 'TOTAL: COP 50.000' }]);
      expect(extractReceiptFields(tsvCop).currency?.value).toBe('COP');

      const tsvUsd = buildTsv([{ text: 'TOTAL: USD 120.50' }]);
      expect(extractReceiptFields(tsvUsd).currency?.value).toBe('USD');

      const tsvEur = buildTsv([{ text: 'TOTAL: EUR 45.00' }]);
      expect(extractReceiptFields(tsvEur).currency?.value).toBe('EUR');
    });

    it('extracts currency symbols ($, €)', () => {
      const tsvEuro = buildTsv([{ text: 'TOTAL: 50,00 €' }]);
      expect(extractReceiptFields(tsvEuro).currency?.value).toBe('EUR');

      const tsvDollar = buildTsv([{ text: 'TOTAL: $ 10.00' }]);
      expect(extractReceiptFields(tsvDollar).currency?.value).toBe('$');
    });

    it('returns null when no currency is present', () => {
      const tsv = buildTsv([{ text: 'TOTAL 1000' }]);
      expect(extractReceiptFields(tsv).currency).toBeNull();
    });
  });

  describe('Total extraction', () => {
    it('extracts integer total with dot thousands separator', () => {
      const tsv = buildTsv([
        { text: 'SUPERMERCADO' },
        { text: 'SUBTOTAL: 40.000' },
        { text: 'IVA: 5.000' },
        { text: 'TOTAL: 45.000' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.total).toEqual({
        value: 45000,
        confidence: expect.any(Number),
      });
    });

    it('extracts decimal total with comma decimal separator (European / Latin format)', () => {
      const tsv = buildTsv([
        { text: 'PANADERIA' },
        { text: 'TOTAL A PAGAR: 45.000,50' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.total?.value).toBe(45000.5);
    });

    it('extracts decimal total with dot decimal separator (US format)', () => {
      const tsv = buildTsv([
        { text: 'BOOKSTORE' },
        { text: 'TOTAL: 1,250.75' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.total?.value).toBe(1250.75);
    });

    it('prefers line with TOTAL label over earlier amounts', () => {
      const tsv = buildTsv([
        { text: 'ITEM 1: 15.00' },
        { text: 'ITEM 2: 25.00' },
        { text: 'SUBTOTAL: 40.00' },
        { text: 'VALOR TOTAL: 40.00' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.total?.value).toBe(40);
    });

    it('returns null when no total amount is present', () => {
      const tsv = buildTsv([
        { text: 'SUPERMERCADO' },
        { text: 'GRACIAS POR SU COMPRA' },
      ]);

      const fields = extractReceiptFields(tsv);
      expect(fields.total).toBeNull();
    });
  });

  describe('Pure and deterministic behavior / Error handling', () => {
    it('returns all null fields for empty TSV without throwing', () => {
      expect(() => extractReceiptFields('')).not.toThrow();
      expect(extractReceiptFields('')).toEqual({
        merchant: null,
        date: null,
        currency: null,
        total: null,
      });
    });

    it('returns all null fields for header-only TSV without throwing', () => {
      const headerOnly =
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
      expect(() => extractReceiptFields(headerOnly)).not.toThrow();
      expect(extractReceiptFields(headerOnly)).toEqual({
        merchant: null,
        date: null,
        currency: null,
        total: null,
      });
    });

    it('handles malformed TSV rows gracefully without throwing', () => {
      const malformed = 'not\ta\tvalid\ttsv\nrow\n1\t2\n';
      expect(() => extractReceiptFields(malformed)).not.toThrow();
      expect(extractReceiptFields(malformed)).toEqual({
        merchant: null,
        date: null,
        currency: null,
        total: null,
      });
    });

    it('does not depend on the system wall clock', () => {
      const fixedClock = () => new Date('2026-09-17T12:00:00.000Z');
      const tsv = buildTsv([
        { text: 'SUPERMERCADO' },
        { text: 'FECHA: 2026-09-15' },
        { text: 'TOTAL: COP 50000' },
      ]);

      const res1 = extractReceiptFields(tsv, { clock: fixedClock });
      const res2 = extractReceiptFields(tsv, { clock: fixedClock });
      expect(res1).toEqual(res2);
    });
  });

  describe('parseTsvTokens parser', () => {
    it('parses Tesseract TSV columns into structured tokens', () => {
      const tsv =
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
        '5\t1\t2\t3\t4\t1\t10\t20\t30\t40\t95\tHELLO';

      const tokens = parseTsvTokens(tsv);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toEqual({
        level: 5,
        pageNum: 1,
        blockNum: 2,
        parNum: 3,
        lineNum: 4,
        wordNum: 1,
        left: 10,
        top: 20,
        width: 30,
        height: 40,
        confidence: 0.95,
        text: 'HELLO',
      });
    });
  });
});
