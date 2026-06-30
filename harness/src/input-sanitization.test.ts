import { describe, expect, it } from "bun:test";

import { normalizeUnicode, redactSecrets } from "./input-sanitization.js";

describe("redactSecrets", () => {
    const cases: ReadonlyArray<{ label: string; secret: string }> = [
        { label: "AWS access key", secret: "AKIAIOSFODNN7EXAMPLE" },
        { label: "Anthropic API key", secret: "sk-ant-api03-abcdefghij1234567890XYZ" },
        { label: "OpenAI API key", secret: "sk-abcdefghij1234567890XYZ0" },
        {
            label: "GitHub token",
            secret: "ghp_0123456789abcdefghij0123456789abcdef",
        },
        {
            label: "JWT",
            secret: "eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4f",
        },
        { label: "Bearer token", secret: "Bearer abcdef1234567890XYZ" },
        {
            label: "DB connection string",
            secret: "postgres://user:s3cr3t@db.internal:5432/cortex",
        },
    ];

    for (const { label, secret } of cases) {
        it(`redacts a ${label}`, () => {
            const out = redactSecrets(`my key is ${secret} ok`);
            expect(out).toContain("[REDACTED:");
            expect(out).not.toContain(secret);
        });
    }

    it("leaves a 40-nucleotide DNA sequence unredacted", () => {
        const dna = "ACGT".repeat(10);
        expect(dna).toHaveLength(40);
        expect(redactSecrets(`sequence: ${dna}`)).toBe(`sequence: ${dna}`);
    });

    it("leaves a 40-residue protein sequence unredacted", () => {
        const protein = "ACDEFGHIKLMNPQRSTVWY".repeat(2);
        expect(protein).toHaveLength(40);
        expect(redactSecrets(`protein: ${protein}`)).toBe(`protein: ${protein}`);
    });
});

describe("normalizeUnicode", () => {
    const BELL = String.fromCharCode(0x07); // C0 control
    const DEL = String.fromCharCode(0x7f); // DEL / start of C1 range
    const COMBINING_ACUTE = String.fromCharCode(0x0301);
    const E_ACUTE = String.fromCharCode(0x00e9); // precomposed "é"

    it("strips a C0 control character", () => {
        expect(normalizeUnicode(`a${BELL}b`)).toBe("ab");
    });

    it("strips a DEL control character", () => {
        expect(normalizeUnicode(`a${DEL}bc`)).toBe("abc");
    });

    it("NFC-normalizes a decomposed sequence", () => {
        expect(normalizeUnicode(`e${COMBINING_ACUTE}`)).toBe(E_ACUTE);
    });

    it("leaves newline and tab intact", () => {
        expect(normalizeUnicode("a\nb\tc")).toBe("a\nb\tc");
    });
});
