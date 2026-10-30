import { describe, expect, it } from "bun:test";

import { parseUnknownRecord } from "../lib/unknown-containers.js";
import { normalizeUnicode, redactSecretAssignments, redactSecretFields, redactSecrets, stripNulCharacters } from "../input-sanitization.js";

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

describe("stripNulCharacters", () => {
    const NUL = String.fromCharCode(0);

    it("removes every NUL from a string", () => {
        expect(stripNulCharacters(`MAGIC${NUL}rest${NUL}${NUL}end`)).toBe("MAGICrestend");
    });

    it("leaves a string with no NUL untouched", () => {
        expect(stripNulCharacters("plain\ttext\nhere")).toBe("plain\ttext\nhere");
    });

    it("keeps the other control characters a tool result may legitimately carry", () => {
        // Unlike `normalizeUnicode`, this strips ONE character — an ANSI escape or
        // a form feed in captured stdout is content, and storage accepts it.
        const ESC = String.fromCharCode(0x1b);
        expect(stripNulCharacters(`a${ESC}[0mb`)).toBe(`a${ESC}[0mb`);
    });
});

describe("redactSecretFields", () => {
    it("replaces the value of a secret field at depth, in an object and in an array", () => {
        const out = redactSecretFields({
            cmd: "run",
            env: { GITHUB_TOKEN: "ghp_value", PATH: "/bin" },
            list: [{ db_password: "hunter2" }, { name: "ana" }],
        });
        expect(JSON.stringify(out)).not.toContain("ghp_value");
        expect(JSON.stringify(out)).not.toContain("hunter2");
        expect(out).toMatchObject({ cmd: "run", env: { PATH: "/bin" }, list: [{}, { name: "ana" }] });
    });

    it("matches a name with the case, underscore, and hyphen removed", () => {
        const out = redactSecretFields({ "x-api-key": "a", Private_Key: "b", Authorization: "c", credentials: { user: "d" }, ACCESS_KEY: "e" });
        expect(Object.values(parseUnknownRecord(out) ?? {}).every((value) => typeof value === "string" && value.startsWith("[REDACTED:"))).toBe(true);
    });

    it("keeps a name that holds a secret word without an end on it", () => {
        const input = { max_tokens: 100, tokenizer: "bpe", tokenCount: 7, sequence: "ACGT".repeat(10), secretary: "ana" };
        expect(redactSecretFields(input)).toEqual(input);
    });

    it("does not change its input", () => {
        const input = { env: { API_TOKEN: "abc" } };
        redactSecretFields(input);
        expect(input).toEqual({ env: { API_TOKEN: "abc" } });
    });
});

describe("redactSecretAssignments", () => {
    it("replaces the value of an assignment whose name ends with a secret word", () => {
        const out = redactSecretAssignments("export API_KEY=abc123 && AWS_SECRET_ACCESS_KEY='s3cr3t value' run --token=xyz");
        expect(out).not.toContain("abc123");
        expect(out).not.toContain("s3cr3t");
        expect(out).not.toContain("xyz");
        expect(out).toContain("API_KEY=[REDACTED:");
        expect(out).toContain("&& ");
    });

    it("replaces the value of a quoted JSON field", () => {
        const out = redactSecretAssignments('{"user": "ana", "password": "hunter2", "note": "ok"}');
        expect(out).not.toContain("hunter2");
        expect(out).toContain('"user": "ana"');
        expect(out).toContain('"note": "ok"');
    });

    it("ends a quoted value at its closing quote, not at an escaped quote", () => {
        const assignment = redactSecretAssignments('export API_KEY="abc\\" def" && run');
        expect(assignment).toBe("export API_KEY=[REDACTED: Secret Assignment] && run");
        const field = redactSecretAssignments('{"password":"ab\\"cd","user":"ana"}');
        expect(field).toBe('{"password":"[REDACTED: Secret Field]","user":"ana"}');
    });

    it("replaces the value of a SECRET_KEY assignment and field", () => {
        expect(redactSecretAssignments("SECRET_KEY=abcd1234 run")).toBe("SECRET_KEY=[REDACTED: Secret Assignment] run");
        expect(redactSecretFields({ SECRET_KEY: "abcd1234" })).toEqual({ SECRET_KEY: "[REDACTED: Secret Field]" });
    });

    it("replaces the rest of the text after a quote that does not close", () => {
        expect(redactSecretAssignments('export API_KEY="abc')).toBe("export API_KEY=[REDACTED: Secret Assignment]");
        expect(redactSecretAssignments("export API_KEY='abc\ndef")).toBe("export API_KEY=[REDACTED: Secret Assignment]");
        expect(redactSecretAssignments('API_KEY="abc\\')).toBe("API_KEY=[REDACTED: Secret Assignment]");
        expect(redactSecretAssignments('{"user": "ana", "password": "hunter2')).toBe('{"user": "ana", "password": "[REDACTED: Secret Field]"');
    });

    it("replaces a double-quoted assignment value that holds spaces", () => {
        const out = redactSecretAssignments('API_KEY="abc 123" run');
        expect(out).not.toContain("abc 123");
        expect(out).toContain("run");
    });

    it("keeps a sequence, a token count, and a comparison unchanged", () => {
        const text = `{"sequence":"${"ACGT".repeat(10)}","max_tokens":100} if token == other max_tokens=5`;
        expect(redactSecretAssignments(text)).toBe(text);
    });
});
