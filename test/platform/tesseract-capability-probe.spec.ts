import { describe, expect, it } from 'vitest';
import {
  assertOcrCapabilityForCi,
  evaluateOcrCapability,
  parseTesseractLanguagesOutput,
  probeOcrCapabilities,
} from '../../src/platform/tesseract-capability-probe.js';

describe('Tesseract Capability Probe', () => {
  describe('parseTesseractLanguagesOutput', () => {
    it('parses standard tesseract --list-langs output', () => {
      const output = `List of available languages in "/usr/share/tessdata/" (2):
eng
osd`;
      expect(parseTesseractLanguagesOutput(output)).toEqual(['eng', 'osd']);
    });

    it('parses output containing eng and spa', () => {
      const output = `List of available languages in "/usr/share/tessdata/" (3):
eng
osd
spa`;
      expect(parseTesseractLanguagesOutput(output)).toEqual([
        'eng',
        'osd',
        'spa',
      ]);
    });

    it('handles empty or malformed output gracefully', () => {
      expect(parseTesseractLanguagesOutput('')).toEqual([]);
      expect(
        parseTesseractLanguagesOutput('Error opening tessdata directory'),
      ).toEqual([]);
    });
  });

  describe('evaluateOcrCapability', () => {
    it('reports supported: true when linux, binaries present, and eng+spa installed', () => {
      const result = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'spa', 'osd'],
      });

      expect(result.supported).toBe(true);
      expect(result.missingLanguages).toEqual([]);
      expect(result.skipReason).toBeUndefined();
    });

    it('reports supported: false with loud skip reason when spa language is missing', () => {
      const result = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'osd'],
      });

      expect(result.supported).toBe(false);
      expect(result.missingLanguages).toEqual(['spa']);
      expect(result.skipReason).toContain(
        'Required Tesseract language(s) missing: spa',
      );
      expect(result.skipReason).toContain('available: eng, osd');
    });

    it('reports supported: false when eng is missing', () => {
      const result = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['spa'],
      });

      expect(result.supported).toBe(false);
      expect(result.missingLanguages).toEqual(['eng']);
      expect(result.skipReason).toContain(
        'Required Tesseract language(s) missing: eng',
      );
    });

    it('reports supported: false when non-linux platform', () => {
      const result = evaluateOcrCapability({
        platform: 'darwin',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'spa'],
      });

      expect(result.supported).toBe(false);
      expect(result.skipReason).toContain('requires Linux with prlimit');
    });

    it('reports supported: false when tesseract binary is missing', () => {
      const result = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: false,
        prlimitAvailable: true,
        availableLanguages: [],
      });

      expect(result.supported).toBe(false);
      expect(result.tesseractAvailable).toBe(false);
      expect(result.skipReason).toContain('tesseract binary not found');
    });

    it('reports supported: false when prlimit binary is missing', () => {
      const result = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: false,
        availableLanguages: ['eng', 'spa'],
      });

      expect(result.supported).toBe(false);
      expect(result.prlimitAvailable).toBe(false);
      expect(result.skipReason).toContain('prlimit binary not found');
    });
  });

  describe('assertOcrCapabilityForCi', () => {
    it('throws in CI environment when capabilities are not supported', () => {
      const unsupported = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng'],
      });

      expect(() =>
        assertOcrCapabilityForCi(unsupported, { CI: 'true' }),
      ).toThrowError(/In CI, OCR capabilities must be present/);
    });

    it('does not throw in CI when capabilities are supported', () => {
      const supported = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'spa'],
      });

      expect(() =>
        assertOcrCapabilityForCi(supported, { CI: 'true' }),
      ).not.toThrow();
    });

    it('does not throw outside CI even when capabilities are unsupported', () => {
      const unsupported = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng'],
      });

      expect(() => assertOcrCapabilityForCi(unsupported, {})).not.toThrow();
    });
  });

  describe('probeOcrCapabilities (system execution)', () => {
    it('probes system environment and returns structured capability result', async () => {
      const result = await probeOcrCapabilities();
      expect(result).toBeDefined();
      expect(typeof result.supported).toBe('boolean');
      expect(typeof result.tesseractAvailable).toBe('boolean');
      expect(typeof result.prlimitAvailable).toBe('boolean');
      expect(Array.isArray(result.availableLanguages)).toBe(true);
      expect(Array.isArray(result.missingLanguages)).toBe(true);

      // On this host, spa is known to be missing:
      if (!result.availableLanguages.includes('spa')) {
        expect(result.supported).toBe(false);
        expect(result.missingLanguages).toContain('spa');
        expect(result.skipReason).toBeDefined();
      }
    });
  });
});
