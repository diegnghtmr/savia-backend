import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

export const EXPECTED_FIXTURE_HASHES = {
  RECEIPT_SIMPLE_SHA256:
    'f8383156459f1659ebdf7031308fff17187ad117114324238bc5e325ff8df295',
  RECEIPT_SPANISH_SHA256:
    '5c904b8cac0ac871ae325b661a9ef9001fc5e1ca50987554a11d6332f2c47284',
} as const;

function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('Receipt Fixtures Integrity', () => {
  const fixturesDir = path.resolve(__dirname, '../../test/fixtures');

  it('matches expected SHA-256 for receipt-simple.png', () => {
    const fixturePath = path.join(fixturesDir, 'receipt-simple.png');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const actualHash = computeSha256(fixturePath);
    expect(actualHash).toBe(EXPECTED_FIXTURE_HASHES.RECEIPT_SIMPLE_SHA256);
  });

  it('matches expected SHA-256 for receipt-spanish.png', () => {
    const fixturePath = path.join(fixturesDir, 'receipt-spanish.png');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const actualHash = computeSha256(fixturePath);
    expect(actualHash).toBe(EXPECTED_FIXTURE_HASHES.RECEIPT_SPANISH_SHA256);
  });
});
