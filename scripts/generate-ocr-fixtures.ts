/**
 * scripts/generate-ocr-fixtures.ts
 *
 * Reproducible receipt fixture generator for Server-Side Receipt OCR (Phase 5).
 *
 * Exact Invocation:
 *   mise exec node@24.18.0 -- node scripts/generate-ocr-fixtures.ts
 *
 * Chromium Provisioning Command:
 *   pnpm exec playwright-core install chromium
 *
 * Environment & Provenance:
 *   - Playwright-core: 1.61.1
 *   - Chromium Version: 149.0.7827.55
 *   - Executable: /home/diegnghtmr/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
 *   - Viewport: 800x600, deviceScaleFactor: 1
 *   - Font Family: 'DejaVu Sans', 'Liberation Sans', sans-serif
 *   - Font Package: ttf-liberation 2.1.5-2 (Arch Linux / Omarchy 4.0.3)
 *     (/usr/share/fonts/liberation/LiberationSans-Regular.ttf)
 *     (Debian/Ubuntu equivalent: fonts-liberation / fonts-dejavu-core)
 *
 * Generated Artifacts:
 *   - test/fixtures/receipt-simple.png (English receipt with TOTAL and $12.50)
 *   - test/fixtures/receipt-spanish.png (Spanish receipt with TOTAL, $33.000, JARDÍN, CAFÉ, TÍPICO)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const RECEIPT_SIMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #ffffff;
    font-family: "DejaVu Sans", "Liberation Sans", sans-serif;
    color: #000000;
  }
  .receipt {
    width: 340px;
    padding: 24px;
    background: #ffffff;
    border: 1px solid #000000;
    font-size: 16px;
    line-height: 1.6;
  }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; margin-bottom: 12px; }
  td { padding: 4px 0; }
  .right { text-align: right; }
  .separator { border-top: 1px solid #000000; margin: 8px 0; }
</style>
</head>
<body>
<div class="receipt">
  <div class="center bold">CORNER GROCERY STORE</div>
  <div class="center">123 MAIN STREET</div>
  <div class="center">DATE: 2026-09-18</div>
  <div class="separator"></div>
  <table>
    <tr><td>COFFEE</td><td class="right">$4.50</td></tr>
    <tr><td>SANDWICH</td><td class="right">$8.00</td></tr>
    <tr><td class="bold">TOTAL</td><td class="right bold">$12.50</td></tr>
  </table>
  <div class="separator"></div>
  <div class="center">THANK YOU FOR YOUR VISIT</div>
</div>
</body>
</html>`;

export const RECEIPT_SPANISH_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #ffffff;
    font-family: "DejaVu Sans", "Liberation Sans", sans-serif;
    color: #000000;
  }
  .receipt {
    width: 340px;
    padding: 24px;
    background: #ffffff;
    border: 1px solid #000000;
    font-size: 16px;
    line-height: 1.6;
  }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; margin-bottom: 12px; }
  td { padding: 4px 0; }
  .right { text-align: right; }
  .separator { border-top: 1px solid #000000; margin: 8px 0; }
</style>
</head>
<body>
<div class="receipt">
  <div class="center bold">RESTAURANTE EL JARDÍN</div>
  <div class="center">CALLE PRINCIPAL 45</div>
  <div class="center">FECHA: 2026-09-18</div>
  <div class="separator"></div>
  <table>
    <tr><td>CAFÉ CON LECHE</td><td class="right">$5.000</td></tr>
    <tr><td>DESAYUNO TÍPICO</td><td class="right">$25.000</td></tr>
    <tr><td>PROPINA</td><td class="right">$3.000</td></tr>
    <tr><td class="bold">TOTAL</td><td class="right bold">$33.000</td></tr>
  </table>
  <div class="separator"></div>
  <div class="center">GRACIAS POR SU COMPRA</div>
</div>
</body>
</html>`;

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function generateReceiptFixture(
  html: string,
): Promise<{ buffer: Buffer; hash: string }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const clip = await page.locator('.receipt').boundingBox();
    if (!clip) {
      throw new Error('Failed to locate .receipt bounding box');
    }
    const buffer = await page.screenshot({ clip });
    const hash = sha256(buffer);
    return { buffer, hash };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixturesDir = path.resolve('test/fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  console.log('Generating receipt fixtures...');

  // Simple English receipt
  const simple1 = await generateReceiptFixture(RECEIPT_SIMPLE_HTML);
  const simple2 = await generateReceiptFixture(RECEIPT_SIMPLE_HTML);
  if (simple1.hash !== simple2.hash) {
    throw new Error(
      `Non-reproducible generation for simple receipt! Hash 1: ${simple1.hash}, Hash 2: ${simple2.hash}`,
    );
  }
  const simplePath = path.join(fixturesDir, 'receipt-simple.png');
  fs.writeFileSync(simplePath, simple1.buffer);
  console.log(
    `Wrote ${simplePath} (${simple1.buffer.length} bytes, SHA-256: ${simple1.hash})`,
  );

  // Spanish receipt
  const spanish1 = await generateReceiptFixture(RECEIPT_SPANISH_HTML);
  const spanish2 = await generateReceiptFixture(RECEIPT_SPANISH_HTML);
  if (spanish1.hash !== spanish2.hash) {
    throw new Error(
      `Non-reproducible generation for Spanish receipt! Hash 1: ${spanish1.hash}, Hash 2: ${spanish2.hash}`,
    );
  }
  const spanishPath = path.join(fixturesDir, 'receipt-spanish.png');
  fs.writeFileSync(spanishPath, spanish1.buffer);
  console.log(
    `Wrote ${spanishPath} (${spanish1.buffer.length} bytes, SHA-256: ${spanish1.hash})`,
  );

  console.log('Receipt fixtures successfully generated and verified.');
}

if (process.argv[1] && process.argv[1].endsWith('generate-ocr-fixtures.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
