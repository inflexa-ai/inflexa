import { describe, expect, it } from "bun:test";

import { hasLoneHighSurrogate, hasLoneLowSurrogate } from "../../lib/test/text-shapes.js";
import { errorToolValue, jsonToolValue, TOOL_VALUE_CAP, textToolValue, withoutToolValues } from "../tool-value.js";
import type { ToolCallValue } from "../../contracts/chat-events.js";
import type { EmitEvent } from "../types.js";

const source = { agentId: "a", callPath: ["a"] };

describe("jsonToolValue", () => {
    it("shows a short value whole and uncut", () => {
        expect(jsonToolValue({ path: "data/a.csv" })).toEqual({ text: '{"path":"data/a.csv"}', cut: false });
    });

    it("shows a string as the string itself", () => {
        expect(jsonToolValue("line one\nline two")).toEqual({ text: "line one\nline two", cut: false });
    });

    it("shows an absent value as null", () => {
        expect(jsonToolValue(undefined)).toEqual({ text: "null", cut: false });
    });

    it("gives no value for a value that does not serialize", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(jsonToolValue(cycle)).toBeUndefined();
        expect(jsonToolValue({ n: 1n })).toBeUndefined();
    });

    it("removes the value of a secret field before it serializes", () => {
        const value = jsonToolValue({ env: { GITHUB_TOKEN: "ghp_0123456789abcdefghij0123456789abcdef" }, cmd: "export API_KEY=abc123 && run" });
        expect(value?.text).not.toContain("ghp_");
        expect(value?.text).not.toContain("abc123");
        expect(value?.text).toContain("run");
    });

    it("removes a quoted assignment value that holds an escaped quote", () => {
        const value = jsonToolValue({ cmd: 'export API_KEY="abc\\" def" && run' });
        expect(value?.text).toBe('{"cmd":"export API_KEY=[REDACTED: Secret Assignment] && run"}');
    });

    it("removes a quoted field value that holds an escaped quote, in a string", () => {
        const value = jsonToolValue({ body: '{"password":"ab\\"cd"}' });
        expect(value?.text).not.toContain("cd");
        expect(value?.text).not.toContain("ab");
        expect(value?.text).toContain("[REDACTED: Secret Field]");
    });

    it("removes the value of a SECRET_KEY field and assignment", () => {
        const value = jsonToolValue({ SECRET_KEY: "abcd1234", cmd: "SECRET_KEY=efgh5678 run" });
        expect(value?.text).not.toContain("abcd1234");
        expect(value?.text).not.toContain("efgh5678");
    });

    it("shows a string that holds JSON with its raw layout and removes its secret", () => {
        const value = jsonToolValue('{\n  "password": "hunter2",\n  "user": "ana"\n}');
        expect(value?.text).toBe('{\n  "password": "[REDACTED: Secret Field]",\n  "user": "ana"\n}');
    });

    it("keeps a sequence and a token count", () => {
        const sequence = "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT";
        expect(jsonToolValue({ sequence, max_tokens: 100 })?.text).toBe(`{"sequence":"${sequence}","max_tokens":100}`);
    });
});

describe("textToolValue", () => {
    it("does not cut a text at the cap", () => {
        const text = "x".repeat(TOOL_VALUE_CAP);
        expect(textToolValue(text)).toEqual({ text, cut: false });
    });

    it("cuts a long text to its start and its end with the marker between them", () => {
        const text = `${"s".repeat(3072)}${"m".repeat(40_000)}${"e".repeat(5120)}`;
        const value = textToolValue(text);
        expect(value.cut).toBe(true);
        expect(value.text).toBe(`${"s".repeat(3072)}\n[... 40000 characters not shown ...]\n${"e".repeat(5120)}`);
    });

    it("divides no surrogate pair at either end of the cut", () => {
        // A pair that straddles each cut index: the start cut falls at 3072, the end cut at length - 5120.
        const pair = "\u{1F9EC}";
        const text = `${"a".repeat(3071)}${pair}${"b".repeat(20_000)}${pair}${"c".repeat(5119)}`;
        const value = textToolValue(text);
        expect(value.cut).toBe(true);
        expect(hasLoneHighSurrogate(value.text)).toBe(false);
        expect(hasLoneLowSurrogate(value.text)).toBe(false);
    });

    it("removes a control character but keeps the tab, the line feed, and the carriage return", () => {
        const escape = String.fromCharCode(0x1b);
        const nul = String.fromCharCode(0);
        expect(textToolValue(`a${escape}[31mred\tb\nc\rd${nul}e`).text).toBe("a[31mred\tb\nc\rde");
    });

    it("removes a secret that a control byte divides", () => {
        const bell = String.fromCharCode(7);
        const value = textToolValue(`key sk-ant-api03-abcdefghij${bell}1234567890XYZ end`);
        expect(value.text).toContain("[REDACTED: Anthropic API Key]");
        expect(value.text).not.toContain("abcdefghij");
    });

    it("removes a secret before the cut, thus the cut cannot divide it", () => {
        const secret = "ghp_0123456789abcdefghij0123456789abcdef";
        // Without the removal, the end cut would fall 10 characters inside the secret.
        const text = `${"a".repeat(20_000)} ${secret} ${"b".repeat(5130 - secret.length - 1)}`;
        const value = textToolValue(text);
        expect(value.cut).toBe(true);
        expect(value.text).toContain("[REDACTED: GitHub Token]");
        expect(value.text).not.toContain("abcdefghij0123456789");
    });

    it("removes a quoted assignment value that holds an escaped quote", () => {
        const value = textToolValue('export API_KEY="abc\\" def" && run');
        expect(value.text).toBe("export API_KEY=[REDACTED: Secret Assignment] && run");
    });

    it("removes an assignment value whose quote does not close", () => {
        expect(textToolValue('run --env API_KEY="abc123').text).toBe("run --env API_KEY=[REDACTED: Secret Assignment]");
    });

    it("removes a quoted field value that holds an escaped quote", () => {
        const value = textToolValue('{"password":"ab\\"cd"}');
        expect(value.text).toBe('{"password":"[REDACTED: Secret Field]"}');
    });

    it("removes an assignment, a quoted field, and a prefixed token in one text", () => {
        const value = textToolValue('{"cmd":"AWS_SECRET_ACCESS_KEY=abc run","password":"hunter2","h":"Bearer abcdef1234567890XYZ"}');
        for (const secret of ["abc run", "hunter2", "abcdef1234567890XYZ"]) expect(value.text).not.toContain(secret);
    });
});

describe("the value of a long text or a long JSON value", () => {
    const secret = "ghp_0123456789abcdefghij0123456789abcdef";

    function plainCut(raw: string): ToolCallValue {
        return { text: `${raw.slice(0, 3072)}\n[... ${raw.length - 8192} characters not shown ...]\n${raw.slice(-5120)}`, cut: true };
    }

    it("removes a secret that the start cut divides", () => {
        // The cut falls inside the redaction marker, thus only the absence of the secret is certain.
        const value = textToolValue(`${"a".repeat(3060)} ${secret} ${"b".repeat(40_000)}`);
        expect(value.text.includes("[REDACTED: ")).toBe(true);
        expect(value.text.includes("ghp_")).toBe(false);
    });

    it("removes a secret that the end cut divides, and an assignment whose quote the start window does not close", () => {
        const value = textToolValue(`${"a".repeat(40_000)} ${secret} ${"b".repeat(5110)}`);
        expect(value.text.includes("Token]")).toBe(true);
        expect(value.text.includes("0123456789abcdef")).toBe(false);
        const open = textToolValue(`${"a".repeat(3000)} API_KEY="${"s".repeat(30_000)}" ${"b".repeat(10_000)}`);
        expect(open.text.includes("API_KEY=[REDACTED: Secret Assignment]")).toBe(true);
        expect(open.text.includes("sss")).toBe(false);
    });

    it("counts the original text of a long text in its marker", () => {
        const text = `${"x".repeat(20_000)} ${secret} ${"y".repeat(20_000)}`;
        expect(textToolValue(text).text).toContain(`[... ${text.length - 8192} characters not shown ...]`);
    });

    it("shows a long string value as a long text", () => {
        const text = `${"s".repeat(3072)}${"m".repeat(40_000)}${"e".repeat(5120)}`;
        expect(jsonToolValue(text)).toEqual(textToolValue(text));
    });

    it("shows the start and the end of the JSON text of a long value", () => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({ gene: `GENE${i}`, note: 'a "quoted"\nline', value: i / 3, gone: undefined }));
        const values: unknown[] = [
            { rows },
            [rows, [[1, 2], [3]], null],
            { first: "h".repeat(100_000), rows, when: new Date(0), last: "t".repeat(100_000) },
            { first: { deep: { deeper: rows } }, list: rows.map((row) => [row.gene, row.value]) },
        ];
        for (const value of values) expect(jsonToolValue(value)).toEqual(plainCut(JSON.stringify(value)));
    });

    it("removes a secret field and a secret string at each end of a long value", () => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({ gene: `GENE${i}` }));
        const value = jsonToolValue({ token: "hunter1", note: `key ${secret}`, rows, last: { password: "hunter2", cmd: "API_KEY=abc123 run" } });
        expect(value?.cut).toBe(true);
        expect(value?.text).not.toContain("hunter");
        expect(value?.text).not.toContain("abcdefghij");
        expect(value?.text).not.toContain("abc123");
        expect(value?.text).toContain('"gene":"GENE0"');
        expect(value?.text).toContain('"gene":"GENE1999"');
    });
});

describe("errorToolValue", () => {
    it("shows an error text that parses as a JSON object in its compact JSON form", () => {
        const text = JSON.stringify({ error: 'failed: export API_KEY="abc\\" def" && run', retryable: false });
        expect(errorToolValue(text)?.text).toBe('{"error":"failed: export API_KEY=[REDACTED: Secret Assignment] && run","retryable":false}');
    });

    it("removes a quoted field inside the error of a JSON error text", () => {
        const text = JSON.stringify({ error: 'bad body {"password":"ab\\"cd"}', retryable: true });
        const value = errorToolValue(text);
        expect(value?.text).not.toContain("cd");
        expect(value?.text).toContain("[REDACTED: Secret Field]");
    });

    it("treats each other error text as a plain text", () => {
        expect(errorToolValue("file not found: data/b.csv")).toEqual({ text: "file not found: data/b.csv", cut: false });
        expect(errorToolValue("[1,2]")).toEqual({ text: "[1,2]", cut: false });
        expect(errorToolValue('export API_KEY="abc\\" def" run')?.text).toBe("export API_KEY=[REDACTED: Secret Assignment] run");
    });
});

describe("withoutToolValues", () => {
    const value = { text: "x", cut: false };

    it("drops the input value of a started event and keeps the rest", () => {
        const event: EmitEvent = { type: "tool-started", source, toolUseId: "c1", name: "t", input: { a: 1 }, detail: "d", inputValue: value };
        const out = withoutToolValues(event);
        expect(out).toEqual({ type: "tool-started", source, toolUseId: "c1", name: "t", input: { a: 1 }, detail: "d" });
        expect(out).not.toHaveProperty("inputValue");
    });

    it("drops the three values of a finished event and keeps the rest", () => {
        const event: EmitEvent = {
            type: "tool-finished",
            source,
            toolUseId: "c1",
            name: "t",
            outcome: "ok",
            durationMs: 5,
            inputValue: value,
            resultValue: value,
            errorValue: value,
        };
        expect(withoutToolValues(event)).toEqual({ type: "tool-finished", source, toolUseId: "c1", name: "t", outcome: "ok", durationMs: 5 });
    });

    it("gives any other event back unchanged", () => {
        const event: EmitEvent = { type: "iteration", source, index: 0, final: false };
        expect(withoutToolValues(event)).toBe(event);
        const delta = { type: "text-delta", text: "hi" } as const;
        expect(withoutToolValues(delta)).toBe(delta);
    });
});
