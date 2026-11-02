import { describe, expect, it } from "bun:test";

import { hasLoneHighSurrogate, hasLoneLowSurrogate } from "../../lib/test/text-shapes.js";
import { viewCode, viewFields, viewJson, viewText } from "../../tools/tool-view.js";
import { codeToolValue, errorToolValue, jsonToolValue, makeToolCallValue, TOOL_VALUE_CAP, textToolValue, withoutToolValues } from "../tool-value.js";
import type { ToolCallLeaf } from "../../contracts/chat-events.js";
import type { EmitEvent } from "../types.js";

const source = { agentId: "a", callPath: ["a"] };

/** The value of an output, with the reason of a refusal dropped. */
function shown(output: unknown) {
    return makeToolCallValue(output).unwrapOr(undefined);
}

/** The reason that an output cannot show, or `undefined` when it shows or is silent. */
function reasonOf(output: unknown): string | undefined {
    const made = makeToolCallValue(output);
    return made.isErr() ? made.error : undefined;
}

describe("jsonToolValue", () => {
    it("shows a short value whole and uncut", () => {
        expect(jsonToolValue({ path: "data/a.csv" })).toEqual({ kind: "json", text: '{"path":"data/a.csv"}', cut: false });
    });

    it("shows a string as a JSON string", () => {
        expect(jsonToolValue("line one\nline two")).toEqual({ kind: "json", text: '"line one\\nline two"', cut: false });
    });

    it("shows null as null and gives no leaf for a value with no JSON text", () => {
        expect(jsonToolValue(null)).toEqual({ kind: "json", text: "null", cut: false });
        expect(jsonToolValue(undefined)).toBeUndefined();
        expect(jsonToolValue(() => 1)).toBeUndefined();
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
        const value = shown('{\n  "password": "hunter2",\n  "user": "ana"\n}');
        expect(value?.kind === "text" ? value.text : undefined).toBe('{\n  "password": "[REDACTED: Secret Field]",\n  "user": "ana"\n}');
    });

    it("removes the secret values of an argv array", () => {
        const value = jsonToolValue({ argv: ["db", "--password", "hunter2", "-u", "ana:hunter3", "--token=t1"] });
        expect(value?.text).not.toContain("hunter2");
        expect(value?.text).not.toContain("hunter3");
        expect(value?.text).not.toContain("t1");
        expect(value?.text).toContain('"db"');
        expect(value?.text).toContain("ana");
    });

    it("removes a quoted cookie header and a cookie field", () => {
        const value = jsonToolValue({ cmd: 'curl -H "Cookie: session=c1"', headers: { Cookie: "session=c2", "Set-Cookie": "id=c3" } });
        for (const secret of ["c1", "c2", "c3"]) expect(value?.text).not.toContain(secret);
    });

    it("keeps a sequence and a token count", () => {
        const sequence = "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT";
        expect(jsonToolValue({ sequence, max_tokens: 100 })?.text).toBe(`{"sequence":"${sequence}","max_tokens":100}`);
    });
});

describe("textToolValue", () => {
    it("does not cut a text at the cap", () => {
        const text = "x".repeat(TOOL_VALUE_CAP);
        expect(textToolValue(text)).toEqual({ kind: "text", text, cut: false });
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

    function plainCut(raw: string): ToolCallLeaf {
        return { kind: "json", text: `${raw.slice(0, 3072)}\n[... ${raw.length - 8192} characters not shown ...]\n${raw.slice(-5120)}`, cut: true };
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

    it("removes a private-key block that starts in the first window and ends in the last window", () => {
        const body = Array.from({ length: 30 }, (_, i) => `KEYLINE${i}abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV`).join("\n");
        const text = `-----BEGIN PRIVATE KEY-----\n${body}\n${"a ".repeat(20_000)}\n${body}\n-----END PRIVATE KEY-----\ntail`;
        const value = textToolValue(text);
        expect(value.cut).toBe(true);
        expect(value.text).not.toContain("KEYLINE");
        expect(value.text).toContain("[REDACTED: Private Key]");
    });

    it("removes the tail of a key block that the last window starts inside", () => {
        const text = `${"a ".repeat(20_000)}\nKEYLINE1abcdefghijklmnopqrstuvwxyz\nKEYLINE2abcdefghijklmnopqrstuvwxyz\n-----END RSA PRIVATE KEY-----\ndone`;
        const value = textToolValue(text);
        expect(value.text).not.toContain("KEYLINE");
        expect(value.text.endsWith("done")).toBe(true);
    });

    it("removes an argv secret at each end of a long array", () => {
        const middle = Array.from({ length: 4000 }, (_, i) => `arg${i}`);
        const value = jsonToolValue({ argv: ["db", "--password", "hunter1", ...middle, "--token", "hunter2", "-u", "ana:hunter3"] });
        expect(value?.cut).toBe(true);
        expect(value?.text).not.toContain("hunter");
        expect(value?.text).toContain('"arg3999"');
    });

    it("removes an argv secret that the start of the shown end divides", () => {
        const trailing = Array.from({ length: 500 }, () => "abcdefg");
        const value = jsonToolValue({ argv: ["db", ...Array.from({ length: 4000 }, (_, i) => `arg${i}`), "--password", "h".repeat(8000), ...trailing] });
        expect(value?.cut).toBe(true);
        expect(value?.text).not.toContain("hhhh");
        expect(value?.text).toContain('"abcdefg"]}');
    });

    it("counts the original text of a long text in its marker", () => {
        const text = `${"x".repeat(20_000)} ${secret} ${"y".repeat(20_000)}`;
        expect(textToolValue(text).text).toContain(`[... ${text.length - 8192} characters not shown ...]`);
    });

    it("shows a long string output as a long text leaf", () => {
        const text = `${"s".repeat(3072)}${"m".repeat(40_000)}${"e".repeat(5120)}`;
        expect(shown(text)).toEqual(textToolValue(text));
    });

    it("shows a long string as a JSON string with its quotes", () => {
        const text = `${"s".repeat(3072)}${"m".repeat(40_000)}${"e".repeat(5120)}`;
        expect(jsonToolValue(text)).toEqual(plainCut(JSON.stringify(text)));
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
    it("shows the error message of the JSON error text of the adapter as a text leaf", () => {
        const text = JSON.stringify({ error: "file not found: data/b.csv", retryable: false });
        expect(errorToolValue(text)).toEqual({ kind: "text", text: "file not found: data/b.csv", cut: false });
    });

    it("removes a secret form inside the error message", () => {
        const text = JSON.stringify({ error: 'failed: export API_KEY="abc\\" def" && run', retryable: false });
        expect(errorToolValue(text).text).toBe("failed: export API_KEY=[REDACTED: Secret Assignment] && run");
    });

    it("shows each other error text whole", () => {
        expect(errorToolValue("file not found: data/b.csv")).toEqual({ kind: "text", text: "file not found: data/b.csv", cut: false });
        expect(errorToolValue("[1,2]").text).toBe("[1,2]");
        const noMessage = JSON.stringify({ retryable: true });
        expect(errorToolValue(noMessage).text).toBe(noMessage);
        const notText = JSON.stringify({ error: { code: 1 } });
        expect(errorToolValue(notText).text).toBe(notText);
    });

    it("cuts a long error message", () => {
        const leaf = errorToolValue(JSON.stringify({ error: "x".repeat(20_000), retryable: false }));
        expect(leaf.cut).toBe(true);
        expect(leaf.text).toContain("[... 11808 characters not shown ...]");
    });
});

describe("codeToolValue", () => {
    it("gives a code leaf with its language, cleaned and cut as a text", () => {
        expect(codeToolValue("javascript", "const a = 1;")).toEqual({ kind: "code", language: "javascript", text: "const a = 1;", cut: false });
        const long = codeToolValue("javascript", `const k = "${"x".repeat(20_000)}";`);
        expect(long.cut).toBe(true);
        expect(codeToolValue("r", "API_KEY=abc123 run").text).toBe("API_KEY=[REDACTED: Secret Assignment] run");
    });
});

describe("makeToolCallValue", () => {
    it("gives no value for an absent output", () => {
        expect(shown(undefined)).toBeUndefined();
    });

    it("gives a text leaf for a string and a json leaf for each other plain value", () => {
        expect(shown("a")).toEqual({ kind: "text", text: "a", cut: false });
        expect(shown({ rows: 3 })).toEqual({ kind: "json", text: '{"rows":3}', cut: false });
        expect(shown([1, 2])).toEqual({ kind: "json", text: "[1,2]", cut: false });
        expect(shown(7)).toEqual({ kind: "json", text: "7", cut: false });
        expect(shown(null)).toEqual({ kind: "json", text: "null", cut: false });
    });

    it("gives each kind of a helper", () => {
        expect(shown(viewText("a"))).toEqual({ kind: "text", text: "a", cut: false });
        expect(shown(viewJson("a"))).toEqual({ kind: "json", text: '"a"', cut: false });
        expect(shown(viewJson({ a: [1] }))).toEqual({ kind: "json", text: '{"a":[1]}', cut: false });
        expect(shown(viewCode("javascript", "return 1;"))).toEqual({ kind: "code", language: "javascript", text: "return 1;", cut: false });
    });

    it("keeps a tool result with a field named kind as a json leaf", () => {
        expect(shown({ kind: "code", language: "r", text: "x" })).toEqual({
            kind: "json",
            text: '{"kind":"code","language":"r","text":"x"}',
            cut: false,
        });
        expect(shown({ kind: "fields", fields: [] })?.kind).toBe("json");
    });

    it("gives the named leaves of a fields value in order", () => {
        const value = shown(viewFields({ output: viewText("hello"), value: viewJson({ n: 1 }), script: viewCode("javascript", "1") }));
        expect(value).toEqual({
            kind: "fields",
            fields: [
                { name: "output", kind: "text", text: "hello", cut: false },
                { name: "value", kind: "json", text: '{"n":1}', cut: false },
                { name: "script", kind: "code", language: "javascript", text: "1", cut: false },
            ],
        });
    });

    it("cuts each field alone", () => {
        const long = "y".repeat(20_000);
        const value = shown(viewFields({ a: viewText(long), b: viewText(long), c: viewText("short") }));
        if (value?.kind !== "fields") throw new Error("expected a fields value");
        expect(value.fields.map((field) => field.cut)).toEqual([true, true, false]);
        for (const field of value.fields.slice(0, 2)) {
            expect(field.text).toBe(`${"y".repeat(3072)}\n[... 11808 characters not shown ...]\n${"y".repeat(5120)}`);
        }
    });

    it("cleans each leaf of a fields value", () => {
        const value = shown(viewFields({ cmd: viewText("run --password hunter2"), body: viewJson({ token: "abc" }) }));
        expect(JSON.stringify(value)).not.toContain("hunter2");
        expect(JSON.stringify(value)).not.toContain("abc");
    });

    it("leaves out a field whose leaf has no value and gives no value when no field is left", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const value = shown(viewFields({ a: viewText("x"), b: undefined, d: viewJson(undefined), e: viewJson(() => 1) }));
        expect(value).toEqual({ kind: "fields", fields: [{ name: "a", kind: "text", text: "x", cut: false }] });
        expect(shown(viewFields({}))).toBeUndefined();
        expect(reasonOf(viewFields({}))).toBeUndefined();
        expect(reasonOf(viewFields({ c: viewJson(cycle) }))).toBe("the field c: the value does not serialize to JSON");
    });

    it("gives no value for a value that breaks a rule", () => {
        const five = viewFields({ a: viewText("1"), b: viewText("2"), c: viewText("3"), d: viewText("4"), e: viewText("5") });
        expect(shown(five)).toBeUndefined();
        expect(shown(viewFields({ a: viewText("1"), b: viewText("2"), c: viewText("3"), d: viewText("4") }))?.kind).toBe("fields");
        expect(shown(viewFields({ "bad name": viewText("1") }))).toBeUndefined();
        expect(shown(viewFields({ [`n${"x".repeat(40)}`]: viewText("1") }))).toBeUndefined();
        expect(shown(viewCode("JavaScript", "1"))).toBeUndefined();
        expect(shown(viewCode("", "1"))).toBeUndefined();
        expect(shown(viewCode("x".repeat(21), "1"))).toBeUndefined();
        expect(shown(viewCode("c++", "1"))?.kind).toBe("code");
        // @ts-expect-error -- a fields value inside a fields value is refused at the type level, and at run time too.
        const nested = viewFields({ inner: viewFields({ a: viewText("1") }) });
        expect(shown(nested)).toBeUndefined();
    });

    it("gives no value for a value that does not serialize", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(shown(cycle)).toBeUndefined();
        expect(shown({ n: 1n })).toBeUndefined();
        expect(shown(viewJson(cycle))).toBeUndefined();
    });

    it("gives the reason for each output that cannot show, and no reason for an absent output", () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(reasonOf(cycle)).toBe("the value does not serialize to JSON");
        expect(reasonOf(() => 1)).toBe("the value has no JSON text");
        expect(reasonOf(viewFields({ a: viewText("1"), b: viewText("2"), c: viewText("3"), d: viewText("4"), e: viewText("5") }))).toBe(
            "a fields value holds more than 4 fields",
        );
        expect(reasonOf(viewCode("JavaScript", "1"))).toContain("language");
        expect(reasonOf(viewFields({ "bad name": viewText("1") }))).toContain("name");
        // @ts-expect-error -- a fields value inside a fields value is refused at the type level, and at run time too.
        expect(reasonOf(viewFields({ inner: viewFields({ a: viewText("1") }) }))).toBe("a fields value holds a fields value");
        expect(reasonOf(undefined)).toBeUndefined();
        expect(reasonOf(viewJson(undefined))).toBeUndefined();
        expect(reasonOf("a")).toBeUndefined();
    });
});

describe("withoutToolValues", () => {
    const value = { kind: "text", text: "x", cut: false } as const;

    it("drops the input value of a started event and keeps the rest", () => {
        const event: EmitEvent = { type: "tool-started", source, toolUseId: "c1", name: "t", detail: "d", input: value };
        const out = withoutToolValues(event);
        expect(out).toEqual({ type: "tool-started", source, toolUseId: "c1", name: "t", detail: "d" });
        expect(out).not.toHaveProperty("input");
    });

    it("drops the three values of a finished event and keeps the rest", () => {
        const event: EmitEvent = {
            type: "tool-finished",
            source,
            toolUseId: "c1",
            name: "t",
            outcome: "ok",
            durationMs: 5,
            input: value,
            result: value,
            error: value,
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
