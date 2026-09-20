import { randomUUID } from 'node:crypto';

export const RECEIPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB (matches IMPORT_MULTIPART_LIMITS.fileSize)
export const RECEIPT_IMAGE_MAX_DIMENSION = 10_000; // 10,000 px
export const RECEIPT_IMAGE_MAX_PIXELS = 25_000_000; // 25,000,000 px
const MAX_ITERATIONS = 1_000;

export class ReceiptDimensionsExceededError extends Error {
  public readonly isDomainError = true;
  public readonly type =
    'https://savia.app/problems/receipt-dimensions-exceeded';
  public readonly title = 'Receipt Dimensions Exceeded';
  public readonly status = 422;
  public readonly code = 'receipt_dimensions_exceeded';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(message: string, traceId?: string) {
    super(message);
    this.name = 'ReceiptDimensionsExceededError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

export class ReceiptFileSizeExceededError extends Error {
  public readonly isDomainError = true;
  public readonly type =
    'https://savia.app/problems/receipt-file-size-exceeded';
  public readonly title = 'Receipt File Size Exceeded';
  public readonly status = 422;
  public readonly code = 'receipt_file_size_exceeded';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(message: string, traceId?: string) {
    super(message);
    this.name = 'ReceiptFileSizeExceededError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

export class ReceiptAnimatedImageError extends Error {
  public readonly isDomainError = true;
  public readonly type = 'https://savia.app/problems/receipt-animated-image';
  public readonly title = 'Receipt Animated Image Unsupported';
  public readonly status = 422;
  public readonly code = 'receipt_animated_image';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(message: string, traceId?: string) {
    super(message);
    this.name = 'ReceiptAnimatedImageError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

export class ReceiptCorruptImageError extends Error {
  public readonly isDomainError = true;
  public readonly type = 'https://savia.app/problems/receipt-corrupt-image';
  public readonly title = 'Receipt Corrupt Image';
  public readonly status = 422;
  public readonly code = 'receipt_corrupt_image';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(message: string, traceId?: string) {
    super(message);
    this.name = 'ReceiptCorruptImageError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

export class ReceiptUnsupportedImageError extends Error {
  public readonly isDomainError = true;
  public readonly type = 'https://savia.app/problems/receipt-unsupported-image';
  public readonly title = 'Receipt Unsupported Image Format';
  public readonly status = 422;
  public readonly code = 'receipt_unsupported_image';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(message: string, traceId?: string) {
    super(message);
    this.name = 'ReceiptUnsupportedImageError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

export interface ValidatedImageInfo {
  readonly format: 'jpeg' | 'png' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly byteLength: number;
}

interface ParsedDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Enforces byte size, positive dimension integers, maximum edge dimension,
 * and overflow-safe total pixel capacity.
 */
function enforceCaps(
  format: 'jpeg' | 'png' | 'webp',
  width: number,
  height: number,
  byteLength: number,
): ValidatedImageInfo {
  if (byteLength > RECEIPT_IMAGE_MAX_BYTES) {
    throw new ReceiptFileSizeExceededError(
      `Receipt image byte length (${byteLength} bytes) exceeds the maximum allowed ingress cap of ${RECEIPT_IMAGE_MAX_BYTES} bytes (5 MiB).`,
    );
  }

  if (
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    throw new ReceiptCorruptImageError(
      'Declared image dimensions must be positive integers.',
    );
  }

  if (
    width > RECEIPT_IMAGE_MAX_DIMENSION ||
    height > RECEIPT_IMAGE_MAX_DIMENSION
  ) {
    throw new ReceiptDimensionsExceededError(
      `Receipt image declared dimensions (${width}x${height}) exceed the maximum allowed edge dimension of ${RECEIPT_IMAGE_MAX_DIMENSION}px.`,
    );
  }

  // Overflow-safe total pixels calculation via BigInt
  const totalPixelsBigInt = BigInt(width) * BigInt(height);
  if (totalPixelsBigInt > BigInt(RECEIPT_IMAGE_MAX_PIXELS)) {
    throw new ReceiptDimensionsExceededError(
      `Receipt image declared pixel count (${totalPixelsBigInt.toString()}) exceeds the maximum allowed pixel cap of ${RECEIPT_IMAGE_MAX_PIXELS}px.`,
    );
  }

  return {
    format,
    width,
    height,
    totalPixels: Number(totalPixelsBigInt),
    byteLength,
  };
}

// Primary Source: W3C Portable Network Graphics (PNG) Specification (Second Edition) / ISO/IEC 15948:2004, Section 5.2 (PNG signature) and Section 11.2.2 (IHDR Image header).
function parsePngDimensions(buffer: Buffer): ParsedDimensions {
  // Signature (8 bytes) + IHDR length (4 bytes) + chunk type (4 bytes) + IHDR data (13 bytes)
  if (buffer.length < 29) {
    throw new ReceiptCorruptImageError(
      'PNG buffer too short to contain a valid IHDR chunk.',
    );
  }

  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new ReceiptCorruptImageError('First PNG chunk is not IHDR.');
  }

  const ihdrLength = buffer.readUInt32BE(8);
  if (ihdrLength < 13 || buffer.length < 16 + ihdrLength) {
    throw new ReceiptCorruptImageError(
      'PNG IHDR chunk truncated or invalid length.',
    );
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}

// Primary Source: ITU-T Recommendation T.81 (1992) / ISO/IEC 10918-1:1994, Section B.1.1.2 (Markers) and Section B.2.2 (Frame header syntax).
// Valid Start-of-Frame markers: 0xC0..0xCF except DHT 0xC4, JPG 0xC8, DAC 0xCC
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_EXCLUDED_SOF_MARKERS = new Set([0xc4, 0xc8, 0xcc]);

function parseJpegDimensions(buffer: Buffer): ParsedDimensions {
  let offset = 2; // Skip SOI (FF D8)
  let iterations = 0;

  while (offset < buffer.length) {
    if (iterations++ > MAX_ITERATIONS) {
      throw new ReceiptCorruptImageError(
        'JPEG exceeded maximum marker iteration bound.',
      );
    }

    // Skip fill bytes (FF)
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset++;
    }

    if (offset >= buffer.length) {
      throw new ReceiptCorruptImageError('JPEG truncated after marker prefix.');
    }

    const marker = buffer[offset++];

    // Standalone markers without payload
    if (marker === 0xd8) {
      // Additional SOI
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // EOI or SOS reached before valid SOF marker found
      throw new ReceiptCorruptImageError(
        'JPEG reached SOS/EOI without a valid Start-of-Frame marker.',
      );
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      // Restart markers (RST0..RST7) or TEM have no length
      continue;
    }

    // Marker carries a 2-byte segment length
    if (offset + 2 > buffer.length) {
      throw new ReceiptCorruptImageError('JPEG truncated segment length.');
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) {
      throw new ReceiptCorruptImageError('JPEG invalid segment length (< 2).');
    }

    if (offset + segmentLength > buffer.length) {
      throw new ReceiptCorruptImageError(
        'JPEG segment length extends beyond buffer length.',
      );
    }

    // Check if marker is an explicitly excluded non-SOF marker
    if (JPEG_EXCLUDED_SOF_MARKERS.has(marker)) {
      offset += segmentLength;
      continue;
    }

    // Check if marker is a valid SOF marker
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        throw new ReceiptCorruptImageError('JPEG SOF segment too short.');
      }
      // SOF payload:
      // offset + 0..1: segmentLength
      // offset + 2: precision
      // offset + 3..4: height (16-bit BE)
      // offset + 5..6: width (16-bit BE)
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return { width, height };
    }

    // Other non-SOF segment: advance past payload
    offset += segmentLength;
  }

  throw new ReceiptCorruptImageError('JPEG missing Start-of-Frame marker.');
}

// Primary Source: WebP Container Specification (Google Developers) / RFC 6386 (VP8 Data Format and Decoding Guide) / WebP Lossless Bitstream Specification (VP8L).
function parseWebpDimensions(buffer: Buffer): ParsedDimensions {
  if (buffer.length < 12) {
    throw new ReceiptCorruptImageError(
      'WebP buffer too short for RIFF header.',
    );
  }

  const riffMagic = buffer.subarray(0, 4).toString('ascii');
  const webpMagic = buffer.subarray(8, 12).toString('ascii');
  if (riffMagic !== 'RIFF' || webpMagic !== 'WEBP') {
    throw new ReceiptCorruptImageError('Invalid WebP RIFF/WEBP container.');
  }

  const declaredRiffSize = buffer.readUInt32LE(4);
  // RIFF size is file size minus 8 (riffMagic + size field)
  if (buffer.length < declaredRiffSize + 8) {
    throw new ReceiptCorruptImageError(
      'WebP buffer length is shorter than declared RIFF size.',
    );
  }

  let offset = 12;
  let iterations = 0;
  let dimensions: ParsedDimensions | undefined;

  while (offset + 8 <= buffer.length) {
    if (iterations++ > MAX_ITERATIONS) {
      throw new ReceiptCorruptImageError(
        'WebP exceeded maximum chunk iteration bound.',
      );
    }

    const fourCC = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;

    if (chunkDataEnd > buffer.length) {
      throw new ReceiptCorruptImageError(
        'WebP chunk length extends beyond buffer length.',
      );
    }

    // Reject animation chunks immediately
    if (fourCC === 'ANIM' || fourCC === 'ANMF') {
      throw new ReceiptAnimatedImageError(
        'Animated WebP images (ANIM/ANMF chunks) are not supported for receipt OCR.',
      );
    }

    if (fourCC === 'VP8X') {
      if (chunkLength < 10) {
        throw new ReceiptCorruptImageError(
          'WebP VP8X chunk payload too short.',
        );
      }
      const flags = buffer[chunkDataStart];
      // Bit 1: Animation flag
      if ((flags & 0x02) !== 0) {
        throw new ReceiptAnimatedImageError(
          'Animated WebP (VP8X animation flag set) is not supported for receipt OCR.',
        );
      }
      // 24-bit Canvas Width (-1)
      const widthMinusOne =
        buffer[chunkDataStart + 4] |
        (buffer[chunkDataStart + 5] << 8) |
        (buffer[chunkDataStart + 6] << 16);
      // 24-bit Canvas Height (-1)
      const heightMinusOne =
        buffer[chunkDataStart + 7] |
        (buffer[chunkDataStart + 8] << 8) |
        (buffer[chunkDataStart + 9] << 16);

      dimensions = {
        width: widthMinusOne + 1,
        height: heightMinusOne + 1,
      };
    } else if (fourCC === 'VP8 ') {
      if (chunkLength < 10) {
        throw new ReceiptCorruptImageError('WebP VP8 chunk payload too short.');
      }
      // Frame tag bit 0: keyframe flag (0 = keyframe, 1 = interframe)
      const frameTag = buffer[chunkDataStart];
      if ((frameTag & 0x01) !== 0) {
        throw new ReceiptCorruptImageError('WebP VP8 frame is not a keyframe.');
      }
      // Start code: 9D 01 2A
      if (
        buffer[chunkDataStart + 3] !== 0x9d ||
        buffer[chunkDataStart + 4] !== 0x01 ||
        buffer[chunkDataStart + 5] !== 0x2a
      ) {
        throw new ReceiptCorruptImageError('WebP VP8 invalid start code.');
      }
      // 16-bit LE: lower 14 bits are dimension
      const rawWidth = buffer.readUInt16LE(chunkDataStart + 6);
      const rawHeight = buffer.readUInt16LE(chunkDataStart + 8);
      if (!dimensions) {
        dimensions = {
          width: rawWidth & 0x3fff,
          height: rawHeight & 0x3fff,
        };
      }
    } else if (fourCC === 'VP8L') {
      if (chunkLength < 5) {
        throw new ReceiptCorruptImageError(
          'WebP VP8L chunk payload too short.',
        );
      }
      // Signature: 0x2F
      if (buffer[chunkDataStart] !== 0x2f) {
        throw new ReceiptCorruptImageError('WebP VP8L signature mismatch.');
      }
      const b1 = buffer[chunkDataStart + 1];
      const b2 = buffer[chunkDataStart + 2];
      const b3 = buffer[chunkDataStart + 3];
      const b4 = buffer[chunkDataStart + 4];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      if (!dimensions) {
        dimensions = { width, height };
      }
    }

    // RIFF chunk payload is padded to even byte boundary
    const paddedLength = chunkLength + (chunkLength % 2);
    offset = chunkDataStart + paddedLength;
  }

  if (!dimensions) {
    throw new ReceiptCorruptImageError(
      'WebP bitstream missing image dimensions chunk.',
    );
  }

  return dimensions;
}

/**
 * Decode-free header validator for receipt image uploads.
 * Reads declared dimensions from PNG IHDR, exact JPEG SOFn markers, or WebP VP8/VP8L/VP8X chunks
 * without decompressing pixel data. Enforces byte, dimension, and pixel caps.
 */
export function validateReceiptImage(buffer: Buffer): ValidatedImageInfo {
  // First check total byte length against ingress cap
  if (buffer.length > RECEIPT_IMAGE_MAX_BYTES) {
    throw new ReceiptFileSizeExceededError(
      `Receipt image byte length (${buffer.length} bytes) exceeds the maximum allowed ingress cap of ${RECEIPT_IMAGE_MAX_BYTES} bytes (5 MiB).`,
    );
  }

  if (buffer.length < 8) {
    throw new ReceiptCorruptImageError(
      'Image buffer too short to identify format.',
    );
  }

  // 1. PNG check: 8-byte signature
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const { width, height } = parsePngDimensions(buffer);
    return enforceCaps('png', width, height, buffer.length);
  }

  // 2. JPEG check: SOI 0xFF 0xD8
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const { width, height } = parseJpegDimensions(buffer);
    return enforceCaps('jpeg', width, height, buffer.length);
  }

  // 3. WebP check: RIFF container with WEBP form type
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    const { width, height } = parseWebpDimensions(buffer);
    return enforceCaps('webp', width, height, buffer.length);
  }

  throw new ReceiptCorruptImageError(
    'Unrecognized or corrupt image format. Supported formats are PNG, JPEG, and WebP.',
  );
}
