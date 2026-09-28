/**
 * The pixel size of an image, read from the header of its data. The reader knows PNG, JPEG, GIF, and
 * WebP, and it decodes no pixel.
 */

export interface ImageDimensions {
    readonly width: number;
    readonly height: number;
}

/** The bytes that a read decodes at most. A JPEG whose frame header comes after them gives no size. */
const HEADER_BYTES = 65_536;

const HEADER_BASE64_CHARS = Math.ceil(HEADER_BYTES / 3) * 4;

/** The size of the image in `data`: base64 text, a base64 data URL, or bytes. `undefined` when the header gives no size. */
export function imageDimensions(data: unknown): ImageDimensions | undefined {
    const bytes = headerBytes(data);
    if (bytes === undefined) return undefined;
    const size = pngDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes) ?? jpegDimensions(bytes);
    return size !== undefined && size.width > 0 && size.height > 0 ? size : undefined;
}

function headerBytes(data: unknown): Uint8Array | undefined {
    if (data instanceof Uint8Array) return data.subarray(0, HEADER_BYTES);
    if (data instanceof ArrayBuffer) return new Uint8Array(data, 0, Math.min(data.byteLength, HEADER_BYTES));
    if (typeof data !== "string") return undefined;
    const base64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    return Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), "base64");
}

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[] | string): boolean {
    const codes = typeof expected === "string" ? Array.from(expected, (char) => char.charCodeAt(0)) : expected;
    return bytes.length >= offset + codes.length && codes.every((code, index) => bytes[offset + index] === code);
}

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number): number => u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (bytes.length < 24 || !startsWith(bytes, 0, PNG_SIGNATURE) || !startsWith(bytes, 12, "IHDR")) return undefined;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (bytes.length < 10 || !startsWith(bytes, 0, "GIF8")) return undefined;
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (bytes.length < 30 || !startsWith(bytes, 0, "RIFF") || !startsWith(bytes, 8, "WEBP")) return undefined;
    if (startsWith(bytes, 12, "VP8X")) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    if (startsWith(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
        return {
            width: (((bytes[22]! & 0x3f) << 8) | bytes[21]!) + 1,
            height: (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6)) + 1,
        };
    }
    if (startsWith(bytes, 12, "VP8 ") && startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) {
        return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
    return undefined;
}

/** A start-of-frame marker holds the size. DHT (`C4`), JPG (`C8`), and DAC (`CC`) share the range and hold none. */
function isStartOfFrame(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (!startsWith(bytes, 0, [0xff, 0xd8])) return undefined;
    let offset = 2;
    while (offset + 3 < bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) {
            offset++;
        } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
        } else if (marker === 0xd9 || marker === 0xda) {
            return undefined;
        } else if (isStartOfFrame(marker)) {
            return offset + 8 < bytes.length ? { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) } : undefined;
        } else {
            offset += 2 + u16be(bytes, offset + 2);
        }
    }
    return undefined;
}
