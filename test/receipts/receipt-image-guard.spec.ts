import { describe, expect, it } from 'vitest';
import {
  validateReceiptImage,
  ReceiptDimensionsExceededError,
  ReceiptFileSizeExceededError,
  ReceiptAnimatedImageError,
  ReceiptCorruptImageError,
  RECEIPT_IMAGE_MAX_BYTES,
  RECEIPT_IMAGE_MAX_DIMENSION,
  RECEIPT_IMAGE_MAX_PIXELS,
} from '../../src/receipts/receipt-image-guard.js';
import {
  classifyJobError,
  JOB_ERROR_CLASSIFICATIONS,
} from '../../src/platform/job-retry-policy.js';
import { UUID_PATTERN } from '../../src/platform/uuid.js';

// Helpers to build byte buffers in code (no committed binaries)
function buildPngBuffer(width: number, height: number): Buffer {
  // 8-byte signature + 25-byte IHDR chunk (4 length + 4 type + 13 data + 4 crc)
  const buf = Buffer.alloc(33);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR length: 13
  buf.writeUInt32BE(13, 8);
  // Chunk type: 'IHDR'
  buf.write('IHDR', 12, 'ascii');
  // Dimensions
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth 8, color type 2 (truecolor), compression 0, filter 0, interlace 0
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  // CRC (dummy value)
  buf.writeUInt32BE(0x12345678, 29);
  return buf;
}

function buildJpegBuffer(options: {
  sofMarker?: number;
  width?: number;
  height?: number;
  precedingSegments?: Array<{ marker: number; payload: Buffer }>;
  includeSos?: boolean;
}): Buffer {
  const parts: Buffer[] = [];
  // SOI: FF D8
  parts.push(Buffer.from([0xff, 0xd8]));

  // Preceding segments (e.g. APP0, DHT)
  if (options.precedingSegments) {
    for (const seg of options.precedingSegments) {
      const len = seg.payload.length + 2;
      const header = Buffer.alloc(4);
      header[0] = 0xff;
      header[1] = seg.marker;
      header.writeUInt16BE(len, 2);
      parts.push(header, seg.payload);
    }
  }

  // SOF marker if specified
  if (options.sofMarker !== undefined) {
    const sof = Buffer.alloc(10);
    sof[0] = 0xff;
    sof[1] = options.sofMarker;
    sof.writeUInt16BE(8, 2); // length: 8 (2 len + 1 prec + 2 h + 2 w + 1 comp)
    sof[4] = 8; // precision
    sof.writeUInt16BE(options.height ?? 600, 5);
    sof.writeUInt16BE(options.width ?? 800, 7);
    sof[9] = 3; // components
    parts.push(sof);
  }

  // SOS if requested: FF DA
  if (options.includeSos) {
    parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));
  }

  // EOI: FF D9
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function buildWebpRiff(
  chunks: Array<{ fourCC: string; payload: Buffer }>,
): Buffer {
  let riffPayloadLength = 4; // 'WEBP'
  const chunkBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    const header = Buffer.alloc(8);
    header.write(chunk.fourCC, 0, 4, 'ascii');
    header.writeUInt32LE(chunk.payload.length, 4);
    chunkBuffers.push(header, chunk.payload);
    riffPayloadLength += 8 + chunk.payload.length;
    if (chunk.payload.length % 2 !== 0) {
      chunkBuffers.push(Buffer.from([0x00])); // padding byte
      riffPayloadLength += 1;
    }
  }

  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(riffPayloadLength, 4);
  riffHeader.write('WEBP', 8, 4, 'ascii');

  return Buffer.concat([riffHeader, ...chunkBuffers]);
}

function buildVp8Payload(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  // 3-byte frame tag: bit 0 is keyframe flag (0 = keyframe)
  buf[0] = 0x00;
  buf[1] = 0x00;
  buf[2] = 0x00;
  // Start code: 9D 01 2A
  buf[3] = 0x9d;
  buf[4] = 0x01;
  buf[5] = 0x2a;
  // Width (16-bit LE, lower 14 bits)
  buf.writeUInt16LE(width & 0x3fff, 6);
  // Height (16-bit LE, lower 14 bits)
  buf.writeUInt16LE(height & 0x3fff, 8);
  return buf;
}

function buildVp8LPayload(width: number, height: number): Buffer {
  const buf = Buffer.alloc(5);
  // Signature byte: 0x2F
  buf[0] = 0x2f;
  // Bit-packed 14-bit width - 1 and 14-bit height - 1
  const wMinusOne = (width - 1) & 0x3fff;
  const hMinusOne = (height - 1) & 0x3fff;

  buf[1] = wMinusOne & 0xff;
  buf[2] = ((wMinusOne >> 8) & 0x3f) | ((hMinusOne & 0x03) << 6);
  buf[3] = (hMinusOne >> 2) & 0xff;
  buf[4] = (hMinusOne >> 10) & 0x0f;
  return buf;
}

function buildVp8XPayload(options: {
  width: number;
  height: number;
  animated?: boolean;
}): Buffer {
  const buf = Buffer.alloc(10);
  // Flags: bit 1 is animation flag (0x02)
  buf[0] = options.animated ? 0x02 : 0x00;
  // 3 reserved bytes: [1..3]
  // Canvas width - 1 (24-bit LE)
  const w = options.width - 1;
  buf[4] = w & 0xff;
  buf[5] = (w >> 8) & 0xff;
  buf[6] = (w >> 16) & 0xff;
  // Canvas height - 1 (24-bit LE)
  const h = options.height - 1;
  buf[7] = h & 0xff;
  buf[8] = (h >> 8) & 0xff;
  buf[9] = (h >> 16) & 0xff;
  return buf;
}

describe('ReceiptImageGuard', () => {
  describe('Constants and configuration contracts', () => {
    it('enforces 5 MiB ingress byte cap', () => {
      expect(RECEIPT_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it('enforces dimension and pixel caps', () => {
      expect(RECEIPT_IMAGE_MAX_DIMENSION).toBe(10_000);
      expect(RECEIPT_IMAGE_MAX_PIXELS).toBe(25_000_000);
    });
  });

  describe('PNG header validation', () => {
    it('validates a valid PNG and returns declared dimensions', () => {
      const buffer = buildPngBuffer(800, 600);
      const info = validateReceiptImage(buffer);
      expect(info).toEqual({
        format: 'png',
        width: 800,
        height: 600,
        totalPixels: 480_000,
        byteLength: buffer.length,
      });
    });

    it('refuses truncated PNG header with ReceiptCorruptImageError', () => {
      const truncated = buildPngBuffer(800, 600).subarray(0, 20);
      expect(() => validateReceiptImage(truncated)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses PNG with zero width or height with ReceiptCorruptImageError', () => {
      const zeroWidth = buildPngBuffer(0, 600);
      expect(() => validateReceiptImage(zeroWidth)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses PNG exceeding max dimension with ReceiptDimensionsExceededError', () => {
      const hugePng = buildPngBuffer(10_001, 100);
      expect(() => validateReceiptImage(hugePng)).toThrow(
        ReceiptDimensionsExceededError,
      );
    });

    it('refuses PNG exceeding max pixel cap with ReceiptDimensionsExceededError', () => {
      // 6000 * 5000 = 30,000,000 pixels > 25,000,000
      const hugePixelPng = buildPngBuffer(6000, 5000);
      expect(() => validateReceiptImage(hugePixelPng)).toThrow(
        ReceiptDimensionsExceededError,
      );
    });
  });

  describe('JPEG header and SOF marker validation', () => {
    it('validates a baseline JPEG SOF0 (0xC0) image', () => {
      const buffer = buildJpegBuffer({
        sofMarker: 0xc0,
        width: 1024,
        height: 768,
      });
      const info = validateReceiptImage(buffer);
      expect(info).toEqual({
        format: 'jpeg',
        width: 1024,
        height: 768,
        totalPixels: 786_432,
        byteLength: buffer.length,
      });
    });

    it('skips preceding APP0 and DHT markers and extracts SOF', () => {
      const app0Payload = Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
      const dhtPayload = Buffer.alloc(16); // dummy DHT table
      const buffer = buildJpegBuffer({
        sofMarker: 0xc2, // progressive SOF2
        width: 800,
        height: 600,
        precedingSegments: [
          { marker: 0xe0, payload: app0Payload },
          { marker: 0xc4, payload: dhtPayload }, // DHT 0xC4 must be skipped as a segment!
        ],
      });

      const info = validateReceiptImage(buffer);
      expect(info.format).toBe('jpeg');
      expect(info.width).toBe(800);
      expect(info.height).toBe(600);
    });

    it('treats only allowed SOF markers as Start-of-Frame', () => {
      const validMarkers = [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ];
      for (const marker of validMarkers) {
        const buffer = buildJpegBuffer({
          sofMarker: marker,
          width: 500,
          height: 400,
        });
        const info = validateReceiptImage(buffer);
        expect(info.width).toBe(500);
        expect(info.height).toBe(400);
      }
    });

    it('fails if excluded marker DHT 0xC4 is treated as SOF (does not parse as SOF)', () => {
      const payload = Buffer.alloc(8);
      payload[2] = 8;
      payload.writeUInt16BE(600, 3);
      payload.writeUInt16BE(800, 5);
      payload[7] = 3;
      const buffer = buildJpegBuffer({
        precedingSegments: [{ marker: 0xc4, payload }],
        includeSos: true,
      });
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('fails if excluded marker JPG 0xC8 is treated as SOF', () => {
      const payload = Buffer.alloc(8);
      payload[2] = 8;
      payload.writeUInt16BE(600, 3);
      payload.writeUInt16BE(800, 5);
      payload[7] = 3;
      const buffer = buildJpegBuffer({
        precedingSegments: [{ marker: 0xc8, payload }],
        includeSos: true,
      });
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('fails if excluded marker DAC 0xCC is treated as SOF', () => {
      const payload = Buffer.alloc(8);
      payload[2] = 8;
      payload.writeUInt16BE(600, 3);
      payload.writeUInt16BE(800, 5);
      payload[7] = 3;
      const buffer = buildJpegBuffer({
        precedingSegments: [{ marker: 0xcc, payload }],
        includeSos: true,
      });
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses JPEG with truncated segment length with ReceiptCorruptImageError', () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00]); // truncated length
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses JPEG where segment length extends past buffer with ReceiptCorruptImageError', () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0xff, 0x08]); // length declares 255 bytes, buffer has 7
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses JPEG missing SOF marker with ReceiptCorruptImageError', () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI directly
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses JPEG with dimension exceeding cap with ReceiptDimensionsExceededError', () => {
      const buffer = buildJpegBuffer({
        sofMarker: 0xc0,
        width: 10_001,
        height: 500,
      });
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptDimensionsExceededError,
      );
    });
  });

  describe('WebP RIFF container and chunk walking', () => {
    it('validates simple lossy VP8 WebP', () => {
      const vp8 = buildVp8Payload(800, 600);
      const buffer = buildWebpRiff([{ fourCC: 'VP8 ', payload: vp8 }]);
      const info = validateReceiptImage(buffer);
      expect(info).toEqual({
        format: 'webp',
        width: 800,
        height: 600,
        totalPixels: 480_000,
        byteLength: buffer.length,
      });
    });

    it('validates lossless VP8L WebP', () => {
      const vp8l = buildVp8LPayload(1200, 800);
      const buffer = buildWebpRiff([{ fourCC: 'VP8L', payload: vp8l }]);
      const info = validateReceiptImage(buffer);
      expect(info).toEqual({
        format: 'webp',
        width: 1200,
        height: 800,
        totalPixels: 960_000,
        byteLength: buffer.length,
      });
    });

    it('validates extended VP8X WebP and checks +1 dimension calculation', () => {
      const vp8x = buildVp8XPayload({
        width: 1920,
        height: 1080,
        animated: false,
      });
      const buffer = buildWebpRiff([{ fourCC: 'VP8X', payload: vp8x }]);
      const info = validateReceiptImage(buffer);
      expect(info).toEqual({
        format: 'webp',
        width: 1920,
        height: 1080,
        totalPixels: 2_073_600,
        byteLength: buffer.length,
      });
    });

    it('refuses animated WebP with VP8X animation flag with ReceiptAnimatedImageError', () => {
      const vp8xAnimated = buildVp8XPayload({
        width: 800,
        height: 600,
        animated: true,
      });
      const buffer = buildWebpRiff([{ fourCC: 'VP8X', payload: vp8xAnimated }]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptAnimatedImageError,
      );
    });

    it('refuses WebP containing ANIM chunk with ReceiptAnimatedImageError', () => {
      const animChunk = Buffer.alloc(6);
      const vp8x = buildVp8XPayload({
        width: 800,
        height: 600,
        animated: false,
      });
      const buffer = buildWebpRiff([
        { fourCC: 'VP8X', payload: vp8x },
        { fourCC: 'ANIM', payload: animChunk },
      ]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptAnimatedImageError,
      );
    });

    it('refuses WebP containing ANMF chunk with ReceiptAnimatedImageError', () => {
      const anmfChunk = Buffer.alloc(16);
      const vp8x = buildVp8XPayload({
        width: 800,
        height: 600,
        animated: false,
      });
      const buffer = buildWebpRiff([
        { fourCC: 'VP8X', payload: vp8x },
        { fourCC: 'ANMF', payload: anmfChunk },
      ]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptAnimatedImageError,
      );
    });

    it('refuses WebP with truncated chunk with ReceiptCorruptImageError', () => {
      const vp8 = buildVp8Payload(800, 600);
      const valid = buildWebpRiff([{ fourCC: 'VP8 ', payload: vp8 }]);
      // Alter chunk length (offset 16) to extend beyond buffer while RIFF size remains consistent
      valid.writeUInt32LE(1000, 16);
      expect(() => validateReceiptImage(valid)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses WebP with inconsistent RIFF header size with ReceiptCorruptImageError', () => {
      const vp8 = buildVp8Payload(800, 600);
      const buffer = buildWebpRiff([{ fourCC: 'VP8 ', payload: vp8 }]);
      // Alter the declared RIFF size to exceed buffer length
      buffer.writeUInt32LE(100_000, 4);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses WebP VP8 non-keyframe with ReceiptCorruptImageError', () => {
      const vp8 = buildVp8Payload(800, 600);
      vp8[0] = 0x01; // interframe flag (bit 0 = 1)
      const buffer = buildWebpRiff([{ fourCC: 'VP8 ', payload: vp8 }]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses WebP VP8 invalid start code with ReceiptCorruptImageError', () => {
      const vp8 = buildVp8Payload(800, 600);
      vp8[3] = 0x00; // invalid start code
      const buffer = buildWebpRiff([{ fourCC: 'VP8 ', payload: vp8 }]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses WebP VP8L invalid signature with ReceiptCorruptImageError', () => {
      const vp8l = buildVp8LPayload(800, 600);
      vp8l[0] = 0x00; // not 0x2F
      const buffer = buildWebpRiff([{ fourCC: 'VP8L', payload: vp8l }]);
      expect(() => validateReceiptImage(buffer)).toThrow(
        ReceiptCorruptImageError,
      );
    });
  });

  describe('File size cap, overflow safety, and corrupt formats', () => {
    it('refuses buffer exceeding 5 MiB with ReceiptFileSizeExceededError', () => {
      // 5 MiB + 1 byte
      const largeBuffer = Buffer.alloc(RECEIPT_IMAGE_MAX_BYTES + 1);
      // Valid PNG signature so format check passes to size check
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
        largeBuffer,
        0,
      );
      expect(() => validateReceiptImage(largeBuffer)).toThrow(
        ReceiptFileSizeExceededError,
      );
    });

    it('enforces pixel cap with overflow-safe multiplication', () => {
      // Dimensions 6000 x 5000 = 30,000,000 > 25,000,000
      const jpeg = buildJpegBuffer({
        sofMarker: 0xc0,
        width: 6000,
        height: 5000,
      });
      expect(() => validateReceiptImage(jpeg)).toThrow(
        ReceiptDimensionsExceededError,
      );
    });

    it('refuses unknown binary / text bytes with ReceiptCorruptImageError', () => {
      const randomBytes = Buffer.from('NOT_AN_IMAGE_OR_PDF_OR_ANYTHING');
      expect(() => validateReceiptImage(randomBytes)).toThrow(
        ReceiptCorruptImageError,
      );
    });

    it('refuses short buffer with ReceiptCorruptImageError', () => {
      const short = Buffer.from([0x01, 0x02]);
      expect(() => validateReceiptImage(short)).toThrow(
        ReceiptCorruptImageError,
      );
    });
  });

  describe('Typed domain errors and classifyJobError classification', () => {
    const errorCases = [
      {
        name: 'ReceiptDimensionsExceededError',
        error: new ReceiptDimensionsExceededError('Dimensions too large'),
        expectedCode: 'receipt_dimensions_exceeded',
      },
      {
        name: 'ReceiptFileSizeExceededError',
        error: new ReceiptFileSizeExceededError('File too large'),
        expectedCode: 'receipt_file_size_exceeded',
      },
      {
        name: 'ReceiptAnimatedImageError',
        error: new ReceiptAnimatedImageError('Animated image not allowed'),
        expectedCode: 'receipt_animated_image',
      },
      {
        name: 'ReceiptCorruptImageError',
        error: new ReceiptCorruptImageError('Corrupt bitstream'),
        expectedCode: 'receipt_corrupt_image',
      },
    ];

    for (const c of errorCases) {
      it(`${c.name} satisfies domain error problem details and classifies as permanent`, () => {
        expect(c.error.isDomainError).toBe(true);
        expect(c.error.status).toBe(422);
        expect(c.error.code).toBe(c.expectedCode);
        expect(c.error.type).toContain('https://savia.app/problems/');
        expect(typeof c.error.title).toBe('string');
        expect(typeof c.error.detail).toBe('string');
        expect(UUID_PATTERN.test(c.error.traceId)).toBe(true);

        const classification = classifyJobError(c.error);
        expect(classification).toBe(JOB_ERROR_CLASSIFICATIONS.PERMANENT);
      });
    }
  });
});
