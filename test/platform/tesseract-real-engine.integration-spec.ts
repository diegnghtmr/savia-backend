import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OcrCapabilityProbeResult } from '../../src/platform/tesseract-capability-probe.js';
import {
  assertOcrCapabilityForCi,
  evaluateOcrCapability,
  probeOcrCapabilities,
} from '../../src/platform/tesseract-capability-probe.js';
import {
  runOcrStartupPreflight,
  SystemTesseractAdapter,
} from '../../src/platform/system-tesseract.adapter.js';

describe('Real Tesseract Engine Suite', () => {
  const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
  let probe: OcrCapabilityProbeResult;

  beforeAll(async () => {
    probe = await probeOcrCapabilities();
    // In CI, capabilities MUST be present. If packages were not installed, fail loudly.
    assertOcrCapabilityForCi(probe);
  });

  describe('Capability probe decision logic (unit verification)', () => {
    it('proves host status: detects spa is missing on this host and provides explicit reason', () => {
      // On this host, spa is not installed. Prove probe detects this fact accurately.
      if (!probe.availableLanguages.includes('spa')) {
        expect(probe.supported).toBe(false);
        expect(probe.missingLanguages).toContain('spa');
        expect(probe.skipReason).toBeDefined();
        expect(probe.skipReason).toContain('spa');
      } else {
        expect(probe.supported).toBe(true);
      }
    });

    it('proves skip decision when spa is missing', () => {
      const simulatedWithoutSpa = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'osd'],
      });
      expect(simulatedWithoutSpa.supported).toBe(false);
      expect(simulatedWithoutSpa.missingLanguages).toEqual(['spa']);
      expect(simulatedWithoutSpa.skipReason).toContain(
        'Required Tesseract language(s) missing: spa',
      );
    });

    it('proves run decision when both eng and spa are present', () => {
      const simulatedWithAll = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng', 'spa', 'osd'],
      });
      expect(simulatedWithAll.supported).toBe(true);
      expect(simulatedWithAll.missingLanguages).toEqual([]);
      expect(simulatedWithAll.skipReason).toBeUndefined();
    });

    it('proves CI failure when capabilities are missing in CI', () => {
      const simulatedMissing = evaluateOcrCapability({
        platform: 'linux',
        tesseractAvailable: true,
        prlimitAvailable: true,
        availableLanguages: ['eng'],
      });
      expect(() =>
        assertOcrCapabilityForCi(simulatedMissing, { CI: 'true' }),
      ).toThrow(/In CI, OCR capabilities must be present/);
    });

    it('proves real host preflight fails on missing spa (pinned exit-0 + stderr marker with real /usr/bin/tesseract)', async () => {
      // On this host, spa is missing from /usr/share/tessdata.
      // Prove that running the real preflight with real /usr/bin/tesseract and /usr/bin/prlimit
      // encounters tesseract exiting 0 with 'Failed loading language spa' on stderr,
      // and runOcrStartupPreflight catches it and rejects with OcrPreflightError.
      if (!probe.availableLanguages.includes('spa')) {
        await expect(runOcrStartupPreflight()).rejects.toThrow(
          /required language pack missing \(eng\+spa\)/i,
        );
      }
    });
  });

  describe('Real /usr/bin/tesseract execution under prlimit with eng+spa', () => {
    it('executes real engine on simple receipt when capabilities are present, or skips explicitly', async () => {
      if (!probe.supported) {
        console.warn(
          `\n[tesseract-real-engine] SKIPPED: ${probe.skipReason}\n(Host does not have tesseract-ocr-spa installed; CI step installs distro packages).\n`,
        );
        return;
      }

      const simplePath = path.join(fixturesDir, 'receipt-simple.png');
      const simpleBuffer = fs.readFileSync(simplePath);
      const adapter = new SystemTesseractAdapter();

      const result = await adapter.recognize(simpleBuffer, {
        timeoutMs: 30_000,
      });

      expect(result.tokens.length).toBeGreaterThan(0);
      const hasTotal = result.tokens.some(
        (t) => t.text.trim().toUpperCase() === 'TOTAL',
      );
      expect(hasTotal).toBe(true);

      const hasAmount = result.tokens.some((t) => t.text.includes('12.50'));
      expect(hasAmount).toBe(true);

      const avgConfidence =
        result.tokens.reduce((sum, t) => sum + t.confidence, 0) /
        result.tokens.length;
      expect(avgConfidence).toBeGreaterThanOrEqual(0.6);
    });

    it('executes real engine on Spanish receipt when capabilities are present, or skips explicitly', async () => {
      if (!probe.supported) {
        console.warn(
          `\n[tesseract-real-engine] SKIPPED: ${probe.skipReason}\n(Host does not have tesseract-ocr-spa installed; CI step installs distro packages).\n`,
        );
        return;
      }

      const spanishPath = path.join(fixturesDir, 'receipt-spanish.png');
      const spanishBuffer = fs.readFileSync(spanishPath);
      const adapter = new SystemTesseractAdapter();

      const result = await adapter.recognize(spanishBuffer, {
        timeoutMs: 30_000,
      });

      expect(result.tokens.length).toBeGreaterThan(0);
      const hasTotal = result.tokens.some(
        (t) => t.text.trim().toUpperCase() === 'TOTAL',
      );
      expect(hasTotal).toBe(true);

      const hasAmount = result.tokens.some((t) => t.text.includes('33.000'));
      expect(hasAmount).toBe(true);

      const hasSpanishWord = result.tokens.some(
        (t) =>
          t.text.toUpperCase().includes('JARD') ||
          t.text.toUpperCase().includes('PROPINA') ||
          t.text.toUpperCase().includes('COMPRA'),
      );
      expect(hasSpanishWord).toBe(true);

      const avgConfidence =
        result.tokens.reduce((sum, t) => sum + t.confidence, 0) /
        result.tokens.length;
      expect(avgConfidence).toBeGreaterThanOrEqual(0.6);
    });
  });
});
