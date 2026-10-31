import { describe, expect, it } from "bun:test";

import { parseUnknownRecord } from "../lib/unknown-containers.js";
import { normalizeUnicode, redactSecretAssignments, redactSecretFields, redactSecretForms, redactSecrets, stripNulCharacters } from "../input-sanitization.js";

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

    it("replaces the element after a secret --name element of an array", () => {
        const input = ["db", "--password", "hunter2", "--api-key", "k123", "--host", "x", "--db_token", "--next"];
        expect(redactSecretFields({ argv: input })).toEqual({
            argv: ["db", "--password", "[REDACTED: Secret Flag]", "--api-key", "[REDACTED: Secret Flag]", "--host", "x", "--db_token", "--next"],
        });
        expect(input[2]).toBe("hunter2");
    });

    it("replaces the password of the element after -u or --user of an array", () => {
        expect(redactSecretFields(["curl", "-u", "ana:hunter3", "--user", "bob:hunter4:x", "-u", "carl"])).toEqual([
            "curl",
            "-u",
            "ana:[REDACTED: Password]",
            "--user",
            "bob:[REDACTED: Password]",
            "-u",
            "carl",
        ]);
    });

    it("keeps an array with no secret flag, and an element after a flag with no secret name", () => {
        const argv = ["run", "--verbose", "yes", "--max-tokens", "100", "-p", "5432", "password"];
        expect(redactSecretFields(argv)).toEqual(argv);
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

describe("redactSecretForms", () => {
    it("replaces a private-key block from its begin line to its end line", () => {
        const out = redactSecretForms("before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nafter");
        expect(out).toBe("before\n[REDACTED: Private Key]\nafter");
    });

    it("hides the rest of the text after a begin line with no end line", () => {
        expect(redactSecretForms("a -----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB")).toBe("a [REDACTED: Private Key]");
    });

    it("hides the text before an end line with no begin line", () => {
        expect(redactSecretForms("AAAA\nBBBB\n-----END RSA PRIVATE KEY-----\nafter")).toBe("[REDACTED: Private Key]\nafter");
    });

    it("hides each block of a text that holds more than one", () => {
        const block = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
        expect(redactSecretForms(`one ${block} two ${block} three`)).toBe("one [REDACTED: Private Key] two [REDACTED: Private Key] three");
    });

    it("keeps a public key block", () => {
        const text = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
        expect(redactSecretForms(text)).toBe(text);
    });

    it("replaces the password of a URL and keeps the user and the host", () => {
        expect(redactSecretForms("get https://ana:hunter3@example.com/x now")).toBe("get https://ana:[REDACTED: URL Password]@example.com/x now");
        const plain = "see https://example.com:8080/a@b and mailto:ana@example.com";
        expect(redactSecretForms(plain)).toBe(plain);
    });

    it("replaces the password of a -u or --user option and keeps the user", () => {
        expect(redactSecretForms("curl -u ana:hunter4 https://x")).toBe("curl -u ana:[REDACTED: Password] https://x");
        expect(redactSecretForms("curl --user ana:hunter4 https://x")).toBe("curl --user ana:[REDACTED: Password] https://x");
        expect(redactSecretForms("curl --user=ana:hunter4 https://x")).toBe("curl --user=ana:[REDACTED: Password] https://x");
        expect(redactSecretForms('curl -u "ana:hunter 4" https://x')).toBe('curl -u "ana:[REDACTED: Password]" https://x');
        expect(redactSecretForms("curl -u ana https://x")).toBe("curl -u ana https://x");
    });

    it("replaces the value of a --name value flag and of a --name=value flag", () => {
        expect(redactSecretForms("mysql --password hunter2 --host db")).toBe("mysql --password [REDACTED: Secret Flag] --host db");
        expect(redactSecretForms("run --api-key=abc123 --verbose")).toBe("run --api-key=[REDACTED: Secret Flag] --verbose");
        expect(redactSecretForms('run --token "a b c" next')).toBe("run --token [REDACTED: Secret Flag] next");
        expect(redactSecretForms("run --token 'abc")).toBe("run --token [REDACTED: Secret Flag]");
    });

    it("keeps a flag with no secret name, and a secret flag with no value", () => {
        const text = "run --max-tokens 100 --name ana --password --verbose";
        expect(redactSecretForms(text)).toBe(text);
    });

    it("replaces the value of a header or YAML pair whose name ends with a secret word", () => {
        expect(redactSecretForms('curl -H "X-Api-Key: k123" -H "Accept: json"')).toBe('curl -H "X-Api-Key: [REDACTED: Secret Pair]" -H "Accept: json"');
        expect(redactSecretForms("db:\n  db_password: p789\n  user: ana")).toBe("db:\n  db_password: [REDACTED: Secret Pair]\n  user: ana");
        expect(redactSecretForms("Authorization: Basic abc")).toBe("Authorization: [REDACTED: Secret Pair]");
    });

    it("finds a secret pair after a pair with a name that holds no secret on the same line", () => {
        expect(redactSecretForms("user: ana password: hunter2")).toBe("user: ana password: [REDACTED: Secret Pair]");
        expect(redactSecretForms("max_tokens: 5 bypass: yes")).toBe("max_tokens: 5 bypass: [REDACTED: Secret Pair]");
        expect(redactSecretForms("a: b: c token: t0k\nname: x")).toBe("a: b: c token: [REDACTED: Secret Pair]\nname: x");
    });

    it("scans a long line of pairs with no secret name in linear time", () => {
        const line = "k: v ".repeat(40_000);
        const started = performance.now();
        expect(redactSecretForms(line)).toBe(line);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("replaces the value of a Cookie and a Set-Cookie header to the end of the line", () => {
        const request = redactSecretForms("GET /\nCookie: session=c456; theme=dark\nHost: x");
        expect(request).not.toContain("c456");
        expect(request).not.toContain("theme=dark");
        expect(request.split("[REDACTED: ")).toHaveLength(2);
        expect(request).toContain("\nHost: x");
        const set = redactSecretForms("Set-Cookie: sid=c456; HttpOnly");
        expect(set).not.toContain("c456");
        expect(set.split("[REDACTED: ")).toHaveLength(2);
    });

    it("replaces the whole value of a secret pair, a marker from an earlier rule included", () => {
        const text = redactSecretForms("password: [REDACTED: Password] hunter2");
        expect(text).not.toContain("hunter2");
        expect(text.startsWith("password: [REDACTED: ")).toBe(true);
    });

    it("replaces a quoted cookie header, a cookie assignment, and a cookie field", () => {
        const header = redactSecretForms('curl -H "Cookie: session=hunter6" -H "Accept: json"');
        expect(header).not.toContain("hunter6");
        expect(header).toContain('-H "Accept: json"');
        expect(redactSecretForms("cookie=hunter7 run")).toBe("cookie=[REDACTED: Secret Assignment] run");
        expect(redactSecretForms('{"Set-Cookie": "id=hunter8"}')).toBe('{"Set-Cookie": "[REDACTED: Secret Field]"}');
        expect(redactSecretFields({ Cookie: "a", "Set-Cookie": "b", cookies: "kept" })).toEqual({
            Cookie: "[REDACTED: Secret Field]",
            "Set-Cookie": "[REDACTED: Secret Field]",
            cookies: "kept",
        });
    });

    it("replaces a number and a bare word in a quoted password field", () => {
        expect(redactSecretForms('{"password": 123456, "user": "ana"}')).toBe('{"password": [REDACTED: Secret Field], "user": "ana"}');
        expect(redactSecretForms('{"api_key":abc123}')).toBe('{"api_key":[REDACTED: Secret Field]}');
        expect(redactSecretForms('{"password": "hunter2", "n": 1}')).toBe('{"password": "[REDACTED: Secret Field]", "n": 1}');
    });

    it("counts pass as a secret word and keeps PWD and max_tokens", () => {
        expect(redactSecretForms("DB_PASS=hunter2 run")).toBe("DB_PASS=[REDACTED: Secret Assignment] run");
        expect(redactSecretFields({ pass: "hunter2" })).toEqual({ pass: "[REDACTED: Secret Field]" });
        const text = 'PWD=/x max_tokens=100 {"max_tokens": 5} pwd: /x';
        expect(redactSecretForms(text)).toBe(text);
    });

    it("keeps the marker of an earlier rule and still removes a value that only starts like a marker", () => {
        expect(redactSecretForms("a --token=abc b")).toBe("a --token=[REDACTED: Secret Flag] b");
        expect(redactSecretForms("API_KEY=[REDACTED:hunter2 run")).not.toContain("hunter2");
    });

    it("keeps a sequence unchanged", () => {
        const text = `sequence: ${"ACGT".repeat(10)}`;
        expect(redactSecretForms(text)).toBe(text);
    });

    it("does a long text of each form in a bounded time", () => {
        const size = 24_576;
        const texts = [
            "--".concat("a".repeat(size)),
            "http://".concat("u".repeat(size)),
            '-u "'.concat("a".repeat(size)),
            "Cookie".repeat(size / 6),
            "-----BEGIN ".repeat(size / 11),
            "a: ".repeat(size / 3),
            '--password "'.repeat(size / 12),
        ];
        const start = performance.now();
        for (const text of texts) redactSecretForms(text);
        expect(performance.now() - start).toBeLessThan(500);
    });

    it("leaves redactSecrets free of each value-only rule", () => {
        const text =
            '--password hunter2 DB_PASS=x {"password": 123} Cookie: a=b -u ana:pw -----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY----- https://ana:pw@example.com';
        expect(redactSecrets(text)).toBe(text);
    });
});
