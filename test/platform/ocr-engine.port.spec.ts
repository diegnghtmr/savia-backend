import { describe, expect, it } from 'vitest';
import { FakeOcrEngine } from '../support/fake-ocr-engine.js';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import { OCR_ENGINE } from '../../src/platform/ocr-engine.port.js';

describe('OcrEnginePort and FakeOcrEngine', () => {
  it('exposes OCR_ENGINE injection symbol', () => {
    expect(typeof OCR_ENGINE).toBe('symbol');
  });

  it('records calls and returns default empty result', async () => {
    const fake = new FakeOcrEngine();
    const image = Buffer.from('test-image-bytes');
    const result = await fake.recognize(image, { timeoutMs: 5000 });

    expect(result).toEqual({ lines: [], tokens: [], rawTsv: '' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.image).toBe(image);
    expect(fake.calls[0]?.options.timeoutMs).toBe(5000);
  });

  it('returns configured custom result', async () => {
    const fake = new FakeOcrEngine();
    fake.result = {
      lines: [
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 1,
          text: 'TOTAL 100',
          confidence: 0.95,
          tokens: [
            {
              level: 5,
              pageNum: 1,
              blockNum: 1,
              parNum: 1,
              lineNum: 1,
              wordNum: 1,
              left: 10,
              top: 10,
              width: 50,
              height: 20,
              confidence: 0.95,
              text: 'TOTAL',
            },
            {
              level: 5,
              pageNum: 1,
              blockNum: 1,
              parNum: 1,
              lineNum: 1,
              wordNum: 2,
              left: 70,
              top: 10,
              width: 40,
              height: 20,
              confidence: 0.95,
              text: '100',
            },
          ],
        },
      ],
      tokens: [],
      rawTsv:
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n',
    };

    const res = await fake.recognize(Buffer.from('bytes'), { timeoutMs: 1000 });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]?.text).toBe('TOTAL 100');
  });

  it('throws configured error', async () => {
    const fake = new FakeOcrEngine();
    fake.error = new Error('Subprocess crash');

    await expect(
      fake.recognize(Buffer.from('bytes'), { timeoutMs: 1000 }),
    ).rejects.toThrow('Subprocess crash');
  });

  it('throws DeliveryDeadlineExceededError when timeoutMs is <= 0', async () => {
    const fake = new FakeOcrEngine();
    await expect(
      fake.recognize(Buffer.from('bytes'), { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('throws DeliveryDeadlineExceededError when signal is already aborted', async () => {
    const fake = new FakeOcrEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fake.recognize(Buffer.from('bytes'), {
        timeoutMs: 5000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('resets calls, error, and result state', async () => {
    const fake = new FakeOcrEngine();
    fake.error = new Error('failed');
    await fake
      .recognize(Buffer.from('bytes'), { timeoutMs: 1000 })
      .catch(() => undefined);
    expect(fake.calls).toHaveLength(1);

    fake.reset();
    expect(fake.calls).toHaveLength(0);
    expect(fake.error).toBeUndefined();
    expect(fake.result).toEqual({ lines: [], tokens: [], rawTsv: '' });
  });
});
