import { describe, expect, it } from 'vitest';
import {
  RECEIPT_PROCESSING_PREFERENCES,
  type ReceiptField,
} from '../../src/receipts/receipt.port.js';
import {
  parseDeviceOcrResult,
  parseProcessingPreference,
  ReceiptCommandValidationError,
  toReceiptFields,
} from '../../src/receipts/receipt-command.js';

describe('receipt-command', () => {
  describe('parseProcessingPreference', () => {
    it('defaults undefined to savia', () => {
      expect(parseProcessingPreference(undefined)).toBe(
        RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      );
    });

    it('defaults empty string to savia', () => {
      expect(parseProcessingPreference('')).toBe(
        RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      );
    });

    it('accepts savia', () => {
      expect(
        parseProcessingPreference(RECEIPT_PROCESSING_PREFERENCES.SAVIA),
      ).toBe(RECEIPT_PROCESSING_PREFERENCES.SAVIA);
    });

    it('accepts device_result', () => {
      expect(
        parseProcessingPreference(RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT),
      ).toBe(RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT);
    });

    it('accepts external_provider', () => {
      expect(
        parseProcessingPreference(
          RECEIPT_PROCESSING_PREFERENCES.EXTERNAL_PROVIDER,
        ),
      ).toBe(RECEIPT_PROCESSING_PREFERENCES.EXTERNAL_PROVIDER);
    });

    it('rejects unsupported processing preference asserting field name', () => {
      expect.assertions(3);
      try {
        parseProcessingPreference('unsupported_preference');
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('processingPreference');
        expect(err.violations[0].code).toBe('invalid-value');
      }
    });
  });

  describe('parseDeviceOcrResult', () => {
    it('returns null for undefined, null, and empty string', () => {
      expect(parseDeviceOcrResult(undefined)).toBeNull();
      expect(parseDeviceOcrResult(null)).toBeNull();
      expect(parseDeviceOcrResult('')).toBeNull();
    });

    it('rejects non-string input asserting field name', () => {
      expect.assertions(3);
      try {
        parseDeviceOcrResult(12345);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult');
        expect(err.violations[0].code).toBe('invalid-type');
      }
    });

    it('rejects malformed JSON string asserting field name', () => {
      expect.assertions(3);
      try {
        parseDeviceOcrResult('{not valid json}');
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult');
        expect(err.violations[0].code).toBe('invalid-type');
      }
    });

    it('rejects non-object parsed JSON asserting field name', () => {
      for (const payload of ['"a string"', '123', 'true', 'null', '[1, 2]']) {
        try {
          parseDeviceOcrResult(payload);
          expect.unreachable('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(ReceiptCommandValidationError);
          const err = error as ReceiptCommandValidationError;
          expect(err.violations[0].field).toBe('deviceOcrResult');
          expect(err.violations[0].code).toBe('invalid-type');
        }
      }
    });

    it('accepts valid empty object', () => {
      expect(parseDeviceOcrResult('{}')).toEqual({});
    });

    it('accepts all four fields present with valid confidence and value', () => {
      const input = JSON.stringify({
        merchant: { value: 'Supermarket', confidence: 0.95 },
        date: { value: '2026-09-07', confidence: 0.8 },
        currency: { value: 'USD', confidence: 1 },
        total: { value: '54.20', confidence: 0 },
      });
      const parsed = parseDeviceOcrResult(input);
      expect(parsed).toEqual({
        merchant: { value: 'Supermarket', confidence: 0.95 },
        date: { value: '2026-09-07', confidence: 0.8 },
        currency: { value: 'USD', confidence: 1 },
        total: { value: '54.20', confidence: 0 },
      });
    });

    it('accepts each of the four fields present individually when others are absent', () => {
      const cases = [
        { merchant: { value: 'Store', confidence: 0.5 } },
        { date: { value: '2026-01-01', confidence: 0.5 } },
        { currency: { value: 'EUR', confidence: 0.5 } },
        { total: { value: 100, confidence: 0.5 } },
      ];
      for (const c of cases) {
        const parsed = parseDeviceOcrResult(JSON.stringify(c));
        expect(parsed).toEqual(c);
      }
    });

    it('accepts value as null or any type without alteration', () => {
      const input = JSON.stringify({
        merchant: { value: null, confidence: 0.5 },
        total: { value: { raw: '10.00' }, confidence: 0.5 },
      });
      const parsed = parseDeviceOcrResult(input);
      expect(parsed).toEqual({
        merchant: { value: null, confidence: 0.5 },
        total: { value: { raw: '10.00' }, confidence: 0.5 },
      });
    });

    it('accepts confidence at lower boundary 0', () => {
      const input = JSON.stringify({
        merchant: { value: 'Acme', confidence: 0 },
      });
      const parsed = parseDeviceOcrResult(input);
      expect(parsed?.merchant).toEqual({ value: 'Acme', confidence: 0 });
    });

    it('accepts confidence at upper boundary 1', () => {
      const input = JSON.stringify({
        merchant: { value: 'Acme', confidence: 1 },
      });
      const parsed = parseDeviceOcrResult(input);
      expect(parsed?.merchant).toEqual({ value: 'Acme', confidence: 1 });
    });

    it('rejects confidence below boundary at -0.0001 asserting field name', () => {
      const input = JSON.stringify({
        merchant: { value: 'Acme', confidence: -0.0001 },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe(
          'deviceOcrResult.merchant.confidence',
        );
        expect(err.violations[0].code).toBe('invalid-range');
      }
    });

    it('rejects confidence above boundary at 1.0001 asserting field name', () => {
      const input = JSON.stringify({
        merchant: { value: 'Acme', confidence: 1.0001 },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe(
          'deviceOcrResult.merchant.confidence',
        );
        expect(err.violations[0].code).toBe('invalid-range');
      }
    });

    it('rejects confidence as NaN asserting field name', () => {
      const input = '{"merchant":{"value":"Acme","confidence":"NaN"}}';
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe(
          'deviceOcrResult.merchant.confidence',
        );
        expect(err.violations[0].code).toBe('invalid-range');
      }
    });

    it('rejects confidence as a numeric string asserting field name', () => {
      const input = JSON.stringify({
        currency: { value: 'USD', confidence: '0.8' },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe(
          'deviceOcrResult.currency.confidence',
        );
        expect(err.violations[0].code).toBe('invalid-range');
      }
    });

    it('rejects confidence as null asserting field name', () => {
      const input = JSON.stringify({
        total: { value: 100, confidence: null },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe(
          'deviceOcrResult.total.confidence',
        );
        expect(err.violations[0].code).toBe('invalid-range');
      }
    });

    it('rejects field that is not an object asserting field name', () => {
      const input = JSON.stringify({
        date: '2026-09-07',
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult.date');
        expect(err.violations[0].code).toBe('invalid-type');
      }
    });

    it('rejects field missing value asserting field name', () => {
      const input = JSON.stringify({
        merchant: { confidence: 0.9 },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult.merchant');
        expect(err.violations[0].code).toBe('invalid-properties');
      }
    });

    it('rejects field missing confidence asserting field name', () => {
      const input = JSON.stringify({
        merchant: { value: 'Acme' },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult.merchant');
        expect(err.violations[0].code).toBe('invalid-properties');
      }
    });

    it('rejects ReceiptField carrying an extra key asserting field name', () => {
      const input = JSON.stringify({
        total: { value: 50, confidence: 0.9, extraKey: 'forbidden' },
      });
      expect.assertions(3);
      try {
        parseDeviceOcrResult(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptCommandValidationError);
        const err = error as ReceiptCommandValidationError;
        expect(err.violations[0].field).toBe('deviceOcrResult.total');
        expect(err.violations[0].code).toBe('invalid-properties');
      }
    });

    it('accepts and preserves unknown top-level keys for later dropping', () => {
      const input = JSON.stringify({
        unknownField: { value: 'test', confidence: 0.5 },
      });
      expect(parseDeviceOcrResult(input)).toEqual({
        unknownField: { value: 'test', confidence: 0.5 },
      });
      expect(toReceiptFields(parseDeviceOcrResult(input))).toEqual({
        merchant: null,
        date: null,
        currency: null,
        total: null,
      });
    });
  });

  describe('toReceiptFields', () => {
    it('maps null input to all four fields as null', () => {
      const fields = toReceiptFields(null);
      expect(fields).toEqual({
        merchant: null,
        date: null,
        currency: null,
        total: null,
      });
    });

    it('maps partial fields retaining null for absent fields', () => {
      const merchantField: ReceiptField = { value: 'Shop', confidence: 0.9 };
      const fields = toReceiptFields({ merchant: merchantField });
      expect(fields).toEqual({
        merchant: merchantField,
        date: null,
        currency: null,
        total: null,
      });
    });

    it('maps all present fields', () => {
      const input = {
        merchant: { value: 'Shop', confidence: 0.9 },
        date: { value: '2026-09-07', confidence: 0.8 },
        currency: { value: 'EUR', confidence: 1 },
        total: { value: 100, confidence: 0.99 },
      };
      const fields = toReceiptFields(input);
      expect(fields).toEqual(input);
    });
  });
});
