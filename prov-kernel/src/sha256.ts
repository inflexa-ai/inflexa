// A minimal synchronous SHA-256 (FIPS 180-4), vendored into the kernel.
//
// The kernel must load in browser and server runtimes. A browser bundler cannot resolve
// `node:crypto`, and the Web Crypto API gives only an asynchronous digest — but the QName
// derivation (`defaultProvDigest`) is synchronous by contract. Thus the kernel carries this
// one-shot implementation and imports no crypto module. `sha256.test.ts` proves byte-equality
// against `node:crypto` over varied inputs, and the golden fixture pins the derived bytes.

/**
 * The round constants: the first 32 bits of the fractional parts of the cube roots of the
 * first 64 primes (FIPS 180-4, section 4.2.2).
 */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
    0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
    0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * The initial hash state: the first 32 bits of the fractional parts of the square roots of the
 * first 8 primes (FIPS 180-4, section 5.3.3).
 */
const H_INIT = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

/** Turn the 32-bit word `x` to the right by `n` bits. */
function rotr(x: number, n: number): number {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Compute the SHA-256 digest of `message`. The result is the standard 32-byte digest,
 * byte-identical to `createHash("sha256")` from `node:crypto`.
 */
export function sha256(message: Uint8Array): Uint8Array {
    // Pad the message (FIPS 180-4, section 5.1.1): one 0x80 byte, then zeros, then the bit
    // length as a 64-bit big-endian integer, up to a multiple of the 64-byte block size.
    const len = message.length;
    const paddedLen = Math.ceil((len + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLen);
    padded.set(message);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    // A JS byte length stays below 2^53, thus the split into two 32-bit words is exact.
    view.setUint32(paddedLen - 8, Math.floor(len / 0x20000000));
    view.setUint32(paddedLen - 4, (len << 3) >>> 0);

    const h = new Uint32Array(H_INIT);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLen; offset += 64) {
        // The message schedule (section 6.2.2, step 1). A Uint32Array write truncates to
        // 32 bits, thus no explicit mask is necessary on the additions.
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        // The compression loop (section 6.2.2, steps 2 to 3).
        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        let f = h[5];
        let g = h[6];
        let hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }

        // Add the compressed block into the state (section 6.2.2, step 4).
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }

    // Serialize the state big-endian (section 6.2.2, the final digest).
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return out;
}
