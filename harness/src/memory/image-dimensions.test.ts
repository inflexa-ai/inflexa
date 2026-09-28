import { describe, expect, it } from "bun:test";

import { imageDimensions } from "./image-dimensions.js";

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));
const u16be = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u16le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u24le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const u32be = (value: number): number[] => [...u16be(Math.floor(value / 0x10000)), ...u16be(value & 0xffff)];

function png(width: number, height: number): Uint8Array {
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
}

function jpeg(width: number, height: number): Uint8Array {
    const app1 = [0xff, 0xe1, ...u16be(2 + 300), ...new Array<number>(300).fill(0x45)];
    const table = [0xff, 0xc4, ...u16be(2 + 4), 0, 1, 2, 3];
    const frame = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return Uint8Array.from([0xff, 0xd8, ...app1, 0xff, ...table, ...frame, 0xff, 0xda, 0, 2]);
}

function webp(fourcc: string, payload: number[]): Uint8Array {
    return Uint8Array.from([
        ...ascii("RIFF"),
        0,
        0,
        0,
        0,
        ...ascii("WEBP"),
        ...ascii(fourcc),
        ...u32be(payload.length).reverse(),
        ...payload,
        ...new Array<number>(8).fill(0),
    ]);
}

describe("imageDimensions", () => {
    it("reads the size of a PNG from its IHDR chunk", () => {
        expect(imageDimensions(png(1280, 800))).toEqual({ width: 1280, height: 800 });
    });

    it("reads the size of a JPEG from its frame header, past an APP1 segment, a table, and a fill byte", () => {
        expect(imageDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    });

    it("reads the size of a GIF", () => {
        expect(imageDimensions(Uint8Array.from([...ascii("GIF89a"), ...u16le(320), ...u16le(240), 0, 0, 0]))).toEqual({ width: 320, height: 240 });
    });

    it("reads the size of each WebP kind", () => {
        expect(imageDimensions(webp("VP8X", [0, 0, 0, 0, ...u24le(1919), ...u24le(1079)]))).toEqual({ width: 1920, height: 1080 });
        const bits = 639 | (479 << 14);
        expect(imageDimensions(webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({
            width: 640,
            height: 480,
        });
        expect(imageDimensions(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600)]))).toEqual({ width: 800, height: 600 });
    });

    it("reads base64 text and a base64 data URL", () => {
        const base64 = Buffer.from(png(64, 32)).toString("base64");

        expect(imageDimensions(base64)).toEqual({ width: 64, height: 32 });
        expect(imageDimensions(`data:image/png;base64,${base64}`)).toEqual({ width: 64, height: 32 });
    });

    it("gives no size for data that is no known image, and for a JPEG that ends before its frame header", () => {
        expect(imageDimensions("A".repeat(400))).toBeUndefined();
        expect(imageDimensions(new URL("https://example.org/figure.png"))).toBeUndefined();
        expect(imageDimensions(jpeg(10, 10).subarray(0, 200))).toBeUndefined();
        expect(imageDimensions(png(0, 10))).toBeUndefined();
    });
});
