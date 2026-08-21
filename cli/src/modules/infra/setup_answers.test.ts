import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    OAUTH_ACCOUNT_KINDS,
    REFS_PRESETS,
    answerOf,
    answerSpelling,
    answersFromFlags,
    describeSetupAnswersError,
    isBatchRun,
    loadSetupAnswers,
    readAnswersFile,
    refsPresetOf,
    resolveSetupAnswers,
    type SetupAnswers,
    type SetupAnswersContext,
    type SetupAnswersError,
    type SetupAuthAnswer,
} from "./setup_answers.ts";
import { providerKindForSlug } from "./setup.ts";
import { REFERENCE_PRESETS } from "../refs/commands.ts";
import { type ModelAuthConfig } from "../../lib/config.ts";
import { reservedPostgresPorts } from "../../lib/env.ts";

/**
 * A batch context with the api-key embedding secret reported ABSENT by default. The seam keeps every case
 * pure — no test in this file touches `process.env` (env.test.ts owns the real accessor's contract).
 */
function batch(embeddingApiKey?: string): SetupAnswersContext {
    return { batch: true, embeddingApiKey: () => embeddingApiKey };
}

/** An interactive context: unanswered questions stay open for a prompt rather than resolving to a default. */
function interactive(embeddingApiKey?: string): SetupAnswersContext {
    return { batch: false, embeddingApiKey: () => embeddingApiKey };
}

function problemsOf(error: SetupAnswersError): readonly string[] {
    return error.type === "answers_invalid" ? error.problems : [];
}

/** The direct connection answers a batch run requires, so a case can vary one thing without tripping the others. */
const DIRECT_BASELINE: SetupAnswers = {
    connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.corp/v1", model: "m1" },
};

describe("readAnswersFile — the strict YAML front-end", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeAnswers(body: string): string {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, body);
        return path;
    }

    test("parses the documented file shape into answers", () => {
        const path = writeAnswers(`
connection:
  mode: direct
  provider: anthropic
  baseURL: https://api.anthropic.com/v1
  protocol: anthropic
  model: claude-sonnet-5
  auth:
    kind: command
    command: my-token-helper
    scheme: bearer
    format: raw
    ttlMs: 300000
postgres:
  user: inflexa
  password: inflexa
  port: 5555
  database: inflexa
  host: localhost
resources:
  sharePct: 50
embedding:
  mode: api-key
  baseURL: https://api.openai.com/v1
  model: text-embedding-3-small
refs: recommended
sandbox: true
runtime: docker
`);
        expect(readAnswersFile(path)._unsafeUnwrap()).toEqual({
            connection: {
                mode: "direct",
                provider: "anthropic",
                baseURL: "https://api.anthropic.com/v1",
                protocol: "anthropic",
                model: "claude-sonnet-5",
                auth: { kind: "command", command: "my-token-helper", scheme: "bearer", format: "raw", ttlMs: 300000 },
            },
            postgres: { user: "inflexa", password: "inflexa", port: 5555, database: "inflexa", host: "localhost" },
            resources: { sharePct: 50 },
            embedding: { mode: "api-key", baseURL: "https://api.openai.com/v1", model: "text-embedding-3-small" },
            refs: "recommended",
            sandbox: true,
            runtime: "docker",
        });
    });

    test("an id list is accepted in place of a preset", () => {
        const path = writeAnswers("refs: [CollecTRI, msigdb-hallmark]\n");
        expect(readAnswersFile(path)._unsafeUnwrap().refs).toEqual(["CollecTRI", "msigdb-hallmark"]);
    });

    test("a preset word is taken in any casing, and canonicalized — the file and the flag read one vocabulary", () => {
        expect(readAnswersFile(writeAnswers("refs: ALL\n"))._unsafeUnwrap().refs).toBe("all");
        expect(readAnswersFile(writeAnswers("refs: Recommended\n"))._unsafeUnwrap().refs).toBe("recommended");
        // Ids are the catalog's identifiers: the same fold applied to them would rewrite what the file names.
        expect(readAnswersFile(writeAnswers("refs: [CollecTRI]\n"))._unsafeUnwrap().refs).toEqual(["CollecTRI"]);
    });

    test("a missing file fails naming the path", () => {
        const path = join(dir, "absent.yml");
        const error = readAnswersFile(path)._unsafeUnwrapErr();
        expect(error.type).toBe("answers_file_unreadable");
        expect(describeSetupAnswersError(error)).toContain(path);
    });

    test("a YAML syntax error fails naming the path and the parse failure", () => {
        const path = writeAnswers("connection: [unclosed\n");
        const error = readAnswersFile(path)._unsafeUnwrapErr();
        expect(error.type).toBe("answers_file_unparseable");
        const message = describeSetupAnswersError(error);
        expect(message).toContain(path);
        expect(message.toLowerCase()).toContain("yaml");
    });

    test("an empty (or comment-only) file is a problem, not an empty answer set", () => {
        const error = readAnswersFile(writeAnswers("# nothing here\n"))._unsafeUnwrapErr();
        expect(problemsOf(error)[0]).toContain("empty");
    });

    test("an explicit empty mapping is the same problem — `{}` would provision every default in silence", () => {
        for (const body of ["{}\n", "{}", "# lead-in\n{}\n"]) {
            const error = readAnswersFile(writeAnswers(body))._unsafeUnwrapErr();
            expect(error.type).toBe("answers_invalid");
            expect(problemsOf(error)[0]).toContain("empty");
        }
    });

    test("blocks that answer nothing are the same problem — a block is a container, not an answer", () => {
        // The `{}` rule has to reach one level down or it is trivially evaded: `connection: {}` parses to a
        // PRESENT block holding no answer, and a presence test on the top level alone reads that as an
        // answered question and provisions every default in silence.
        for (const body of ["connection: {}\n", "postgres: {}\nresources: {}\n", "connection:\n  {}\n"]) {
            const error = readAnswersFile(writeAnswers(body))._unsafeUnwrapErr();
            expect(error.type).toBe("answers_invalid");
            expect(problemsOf(error)[0]).toContain("empty");
        }
    });

    test("one leaf anywhere is enough to make the file an answer set", () => {
        expect(readAnswersFile(writeAnswers("connection: {}\npostgres:\n  port: 5555\n"))._unsafeUnwrap()).toEqual({
            connection: {},
            postgres: { port: 5555 },
        });
        // A nested leaf counts through its block, and `refs` counts as the list it is.
        expect(readAnswersFile(writeAnswers("connection:\n  auth:\n    kind: env\n    var: KEY\n    scheme: bearer\n"))._unsafeUnwrap()).toEqual({
            connection: { auth: { kind: "env", var: "KEY", scheme: "bearer" } },
        });
        expect(readAnswersFile(writeAnswers("refs:\n  - demo\n"))._unsafeUnwrap()).toEqual({ refs: ["demo"] });
    });

    test("a key answered twice is rejected — YAML resolves duplicates last-wins before any of this code sees them", () => {
        // Verified: `Bun.YAML.parse("runtime: docker\nruntime: podman")` is `{runtime: "podman"}`. The first
        // answer is gone by the time the schema runs, so the raw text is the only place the evidence exists.
        const error = readAnswersFile(writeAnswers("runtime: docker\nruntime: podman\n"))._unsafeUnwrapErr();
        const text = problemsOf(error).join("\n");
        expect(text).toContain("`runtime`");
        expect(text).toContain("twice");
    });

    test("a duplicate is reported by its full key path, at any depth", () => {
        const nested = problemsOf(readAnswersFile(writeAnswers("embedding:\n  mode: local\n  mode: off\n"))._unsafeUnwrapErr()).join("\n");
        expect(nested).toContain("`embedding.mode`");

        // The fleet failure the scan exists for: two whole blocks, the first silently discarded.
        const block = problemsOf(readAnswersFile(writeAnswers("embedding:\n  mode: local\nrefs: all\nembedding:\n  mode: off\n"))._unsafeUnwrapErr()).join(
            "\n",
        );
        expect(block).toContain("`embedding`");

        const deep = problemsOf(
            readAnswersFile(writeAnswers("connection:\n  auth:\n    kind: env\n    var: A\n    var: B\n    scheme: bearer\n"))._unsafeUnwrapErr(),
        ).join("\n");
        expect(deep).toContain("`connection.auth.var`");
    });

    test("the same key at different levels is not a duplicate — the scan tracks a path, not a name", () => {
        const answers = readAnswersFile(
            writeAnswers(
                "connection:\n  mode: direct\n  model: m1\n  baseURL: https://gw.corp/v1\nembedding:\n  mode: api-key\n  model: e1\n  baseURL: https://api.openai.com/v1\n",
            ),
        )._unsafeUnwrap();
        expect(answers.connection?.model).toBe("m1");
        expect(answers.embedding?.model).toBe("e1");
    });

    test("a block sequence and a block scalar do not confuse the duplicate scan", () => {
        expect(readAnswersFile(writeAnswers("refs:\n  - CollecTRI\n  - msigdb-hallmark\nruntime: docker\n"))._unsafeUnwrap().refs).toEqual([
            "CollecTRI",
            "msigdb-hallmark",
        ]);
        // A block scalar's body is text: a `var: …` line inside it is content, not a second mapping key.
        expect(
            readAnswersFile(
                writeAnswers("connection:\n  auth:\n    kind: command\n    command: |\n      var: one\n      var: two\n    scheme: bearer\n"),
            )._unsafeUnwrap().connection?.auth,
        ).toEqual({ kind: "command", command: "var: one\nvar: two", scheme: "bearer" });
    });

    test("the duplicate scan is a line scan: a duplicate inside a FLOW mapping is NOT caught (documented limit)", () => {
        // Asserted honestly rather than claimed: `embedding: {mode: local, mode: off}` is one line with one
        // key to the scan, so YAML's last-wins stands and `off` is what the answers carry.
        expect(readAnswersFile(writeAnswers("embedding: {mode: local, mode: off}\n"))._unsafeUnwrap().embedding?.mode).toBe("off");
    });

    test("a typo'd top-level key is rejected by name (the fleet failure strict parsing exists to prevent)", () => {
        const error = readAnswersFile(writeAnswers("embedings:\n  mode: local\n"))._unsafeUnwrapErr();
        expect(problemsOf(error).join("\n")).toContain("`embedings`");
    });

    test("an execution modifier in the file is an unknown key — how a run behaves is flag-only", () => {
        const error = readAnswersFile(writeAnswers("start: false\n"))._unsafeUnwrapErr();
        const text = problemsOf(error).join("\n");
        expect(text).toContain("`start`");
        expect(text).toContain("flags only");
    });

    test("no execution modifier is silently accepted as an answer", () => {
        // `postgres: false` (the `--no-postgres` spelling) is the one that fails as a TYPE error rather than
        // an unknown key — `postgres` is a real answers block — but it fails all the same, naming the key.
        for (const body of ["start: false", "force: true", "postgres: false", "validate: false", "yes: true", "auth: false"]) {
            const error = readAnswersFile(writeAnswers(`${body}\n`))._unsafeUnwrapErr();
            expect(problemsOf(error).join("\n")).toContain(`\`${body.split(":")[0]}\``);
        }
    });

    test("an empty refs list is a problem — the answer is the download consent, so it must name something", () => {
        const error = readAnswersFile(writeAnswers("refs: []\n"))._unsafeUnwrapErr();
        expect(problemsOf(error).join("\n")).toContain("at least one dataset id");
    });

    test("a nested unknown key names its full path (a near-miss spelling is not silently dropped)", () => {
        const error = readAnswersFile(writeAnswers("connection:\n  baseUrl: https://gw.corp/v1\n"))._unsafeUnwrapErr();
        expect(problemsOf(error).join("\n")).toContain("`connection.baseUrl`");
    });

    test("the flags-only advice is reserved for a TOP-LEVEL key that actually names an execution modifier", () => {
        // `--no-start`'s file spelling lands on the same advice as `start`.
        for (const body of ["start: false", "no-start: true", "no-validate: true", "yes: true"]) {
            expect(problemsOf(readAnswersFile(writeAnswers(`${body}\n`))._unsafeUnwrapErr()).join("\n")).toContain("flags only");
        }
    });

    test("a nested typo gets a plain unknown-key error — the flags-only advice would be about another question entirely", () => {
        for (const [body, key] of [
            ["postgres:\n  prot: 5555\n", "postgres.prot"],
            ["connection:\n  auth:\n    kind: env\n    var: V\n    scheme: bearer\n    ttl: 10\n", "connection.auth.ttl"],
            // `start` nested under a real block is still not an execution modifier — only the top level is.
            ["postgres:\n  start: false\n", "postgres.start"],
        ] as const) {
            const text = problemsOf(readAnswersFile(writeAnswers(body))._unsafeUnwrapErr()).join("\n");
            expect(text).toContain(`\`${key}\``);
            expect(text).not.toContain("flags only");
        }
    });

    test("a top-level key that is neither an answer nor a modifier gets the plain error too", () => {
        const text = problemsOf(readAnswersFile(writeAnswers("nope: 1\n"))._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("`nope`");
        expect(text).not.toContain("flags only");
    });

    test("a document-level type error names the document, not an empty locator", () => {
        // A scalar file, and the ARRAY `Bun.YAML.parse` returns for a multi-document file — a stray trailing
        // `---` is enough. Both have an empty issue path, which used to render as a dash with no subject.
        for (const body of ["hello\n", "runtime: docker\n---\n"]) {
            const message = describeSetupAnswersError(readAnswersFile(writeAnswers(body))._unsafeUnwrapErr());
            expect(message).toContain("the answers document");
            expect(message).not.toContain("\n  -  —");
        }
    });

    test("an array-element problem falls back to its nearest mapped question, keeping both spellings", () => {
        const text = problemsOf(readAnswersFile(writeAnswers('refs: ["", CollecTRI]\n'))._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--refs");
        expect(text).toContain("`refs.0`");
    });

    test("a credential block rejects anything token-shaped — the auth answer is token-free by construction", () => {
        const error = readAnswersFile(
            writeAnswers("connection:\n  auth:\n    kind: env\n    var: MY_TOKEN\n    scheme: bearer\n    token: sk-secret\n"),
        )._unsafeUnwrapErr();
        expect(problemsOf(error).join("\n")).toContain("`connection.auth.token`");
    });

    test("an out-of-range value names both spellings of its question", () => {
        const error = readAnswersFile(writeAnswers("resources:\n  sharePct: 300\n"))._unsafeUnwrapErr();
        const text = problemsOf(error).join("\n");
        expect(text).toContain("--resource-share");
        expect(text).toContain("resources.sharePct");
    });

    test("a refs scalar that is not a preset word names the accepted forms", () => {
        const error = readAnswersFile(writeAnswers("refs: everything\n"))._unsafeUnwrapErr();
        const text = problemsOf(error).join("\n");
        expect(text).toContain("--refs");
        expect(text).toContain("recommended");
    });

    test("a block-shaped problem names the block's flag family as well as its key", () => {
        // `postgres:` with nothing under it parses to a null block — a shape error at the BLOCK, whose issue
        // path has no leaf to name. Without a spelling for the block itself the line reads as a bare key,
        // leaving an author who only ever touches argv with nothing to act on.
        for (const [body, flag, key] of [
            ["postgres:\nruntime: docker\n", "--postgres-", "`postgres`"],
            ["connection: 3\n", "--connection", "`connection`"],
            ["resources: []\n", "--resource-share", "`resources`"],
            ["embedding: nope\n", "--embeddings", "`embedding`"],
        ] as const) {
            const text = problemsOf(readAnswersFile(writeAnswers(body))._unsafeUnwrapErr()).join("\n");
            expect(text).toContain(flag);
            expect(text).toContain(key);
        }
    });

    test("a numeric answer must be a plain decimal integer in the FILE too — YAML resolves the other literals away", () => {
        // `Bun.YAML.parse("port: 0x1F5B")` is 8027 and `1e2` is 100 before zod sees either, so the file
        // would silently accept a value the flag front-end rejects — and provision a port the author never
        // wrote. Both spellings are named, exactly as the flag's own message does.
        for (const [body, flag, key, literal] of [
            ["postgres:\n  port: 0x1F5B\n", "--postgres-port", "postgres.port", "0x1F5B"],
            ["resources:\n  sharePct: 1e2\n", "--resource-share", "resources.sharePct", "1e2"],
            ["postgres:\n  port: 0o17\n", "--postgres-port", "postgres.port", "0o17"],
            ["resources:\n  sharePct: .inf\n", "--resource-share", "resources.sharePct", ".inf"],
            [
                "connection:\n  auth:\n    kind: command\n    command: helper\n    scheme: bearer\n    ttlMs: 3e5\n",
                "config file only",
                "connection.auth.ttlMs",
                "3e5",
            ],
        ] as const) {
            const text = problemsOf(readAnswersFile(writeAnswers(body))._unsafeUnwrapErr()).join("\n");
            expect(text).toContain("must be a whole number");
            expect(text).toContain(flag);
            expect(text).toContain(key);
            expect(text).toContain(`"${literal}"`);
        }
    });

    test("the numeric check reads a block written INLINE, the way a one-liner spells it", () => {
        const text = problemsOf(readAnswersFile(writeAnswers("postgres: {port: 0x1F5B}\n"))._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--postgres-port");
        expect(text).toContain('"0x1F5B"');
    });

    test("a trailing comment is not part of the literal", () => {
        expect(readAnswersFile(writeAnswers("postgres:\n  port: 5555 # the published host port\n"))._unsafeUnwrap().postgres?.port).toBe(5555);
    });

    test("a plain decimal still passes, and a QUOTED number stays the schema's type error", () => {
        expect(readAnswersFile(writeAnswers("postgres:\n  port: 5555\n"))._unsafeUnwrap().postgres?.port).toBe(5555);
        // A quoted scalar is a string, which the schema rejects in the author's own terms; reporting the
        // literal shape too would be two messages for one mistake.
        const quoted = problemsOf(readAnswersFile(writeAnswers("postgres:\n  port: '5555'\n"))._unsafeUnwrapErr()).join("\n");
        expect(quoted).toContain("postgres.port");
        expect(quoted).not.toContain("must be a whole number");
        // Same reasoning for a literal YAML does NOT resolve into a number (`0b11` is a plain string to it):
        // there is no parity hole to close, so the schema's own type error stands alone.
        const binary = problemsOf(readAnswersFile(writeAnswers("postgres:\n  port: 0b11\n"))._unsafeUnwrapErr()).join("\n");
        expect(binary).toContain("postgres.port");
        expect(binary).not.toContain("must be a whole number");
    });

    test("a base URL answer must parse as a URL with a scheme, from the file as much as the flag", () => {
        for (const body of ["connection:\n  baseURL: gw.corp\n", "embedding:\n  mode: api-key\n  baseURL: gw.corp\n"]) {
            expect(problemsOf(readAnswersFile(writeAnswers(body))._unsafeUnwrapErr()).join("\n")).toContain("must be a URL with a scheme");
        }
    });

    test("every reported problem carries the file path in the rendered message", () => {
        const path = writeAnswers("start: false\nnope: 1\n");
        const message = describeSetupAnswersError(readAnswersFile(path)._unsafeUnwrapErr());
        expect(message).toContain(path);
        expect(message).toContain("`start`");
        expect(message).toContain("`nope`");
    });
});

describe("answersFromFlags — the flag front-end", () => {
    test("maps every value flag into the same shape the file parses into", () => {
        const answers = answersFromFlags({
            connection: "direct",
            provider: "deepseek",
            baseUrl: "https://gw.corp/v1",
            protocol: "openai-compatible",
            model: "d1",
            authCommand: "my-helper",
            authScheme: "bearer",
            authFormat: "exec-credential",
            postgresUser: "u",
            postgresPassword: "p",
            postgresPort: "5555",
            postgresDatabase: "db",
            postgresHost: "h",
            resourceShare: "50",
            embeddings: "api-key",
            embeddingsUrl: "https://api.openai.com/v1",
            embeddingsModel: "text-embedding-3-small",
            sandbox: true,
            runtime: "podman",
            refs: "a,b",
        })._unsafeUnwrap();
        expect(answers).toEqual({
            connection: {
                mode: "direct",
                provider: "deepseek",
                baseURL: "https://gw.corp/v1",
                protocol: "openai-compatible",
                model: "d1",
                auth: { kind: "command", command: "my-helper", scheme: "bearer", format: "exec-credential" },
            },
            postgres: { user: "u", password: "p", port: 5555, database: "db", host: "h" },
            resources: { sharePct: 50 },
            embedding: { mode: "api-key", baseURL: "https://api.openai.com/v1", model: "text-embedding-3-small" },
            refs: ["a", "b"],
            sandbox: true,
            runtime: "podman",
        });
    });

    test("no flags answer nothing (every block stays absent, so the orchestrator prompts or defaults)", () => {
        expect(answersFromFlags({})._unsafeUnwrap()).toEqual({
            connection: undefined,
            postgres: undefined,
            resources: undefined,
            embedding: undefined,
            refs: undefined,
            sandbox: undefined,
            runtime: undefined,
        });
    });

    test("an env credential source needs only its variable and scheme", () => {
        const answers = answersFromFlags({ authEnv: "ANTHROPIC_AUTH_TOKEN", authScheme: "bearer" })._unsafeUnwrap();
        expect(answers.connection?.auth).toEqual({ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" });
    });

    test("two credential sources are a contradiction, not a precedence", () => {
        const error = answersFromFlags({ authEnv: "VAR", authCommand: "cmd", authScheme: "bearer" })._unsafeUnwrapErr();
        expect(problemsOf(error).join("\n")).toContain("exactly one");
    });

    test("a credential source without a scheme fails naming --auth-scheme", () => {
        const text = problemsOf(answersFromFlags({ authCommand: "cmd" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--auth-scheme");
        expect(text).toContain("connection.auth.scheme");
    });

    test("a scheme without a source fails naming the two source flags", () => {
        const text = problemsOf(answersFromFlags({ authScheme: "bearer" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--auth-env");
        expect(text).toContain("--auth-command");
    });

    test("--auth-format describes a command's output, so it is rejected on an env source", () => {
        const text = problemsOf(answersFromFlags({ authEnv: "VAR", authScheme: "bearer", authFormat: "raw" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--auth-format");
    });

    test("a numeric flag is a plain decimal integer — JavaScript's other integer literals are not whole numbers the author can verify", () => {
        // `Number("0x10")` is 16 and `Number("1e2")` is 100, both `Number.isInteger`: taken by `Number` alone
        // the CLI would provision a port the author never wrote while promising "must be a whole number".
        for (const raw of ["0x10", "1e2", "0b11", "0o17", "5.5", "Infinity", " ", ""]) {
            const text = problemsOf(answersFromFlags({ postgresPort: raw })._unsafeUnwrapErr()).join("\n");
            expect(text).toContain("must be a whole number");
            expect(text).toContain(`"${raw}"`);
        }
        expect(problemsOf(answersFromFlags({ resourceShare: "1e2" })._unsafeUnwrapErr()).join("\n")).toContain("must be a whole number");
        expect(answersFromFlags({ postgresPort: "5555", resourceShare: "50" })._unsafeUnwrap().postgres?.port).toBe(5555);
    });

    test("a non-numeric numeric flag names both spellings and the value it could not read", () => {
        const text = problemsOf(answersFromFlags({ postgresPort: "abc", resourceShare: "half" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--postgres-port");
        expect(text).toContain("postgres.port");
        expect(text).toContain('"abc"');
        expect(text).toContain("--resource-share");
        expect(text).toContain('"half"');
    });

    test("a numeric flag outside its range is rejected by the shared schema", () => {
        const text = problemsOf(answersFromFlags({ resourceShare: "0" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("percentage between 1 and 100");
    });

    test("an unknown enum value names both spellings", () => {
        const text = problemsOf(answersFromFlags({ connection: "proxy" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--connection");
        expect(text).toContain("connection.mode");
    });

    test("--refs takes a lone preset word, and otherwise a deduped id list", () => {
        expect(answersFromFlags({ refs: "recommended" })._unsafeUnwrap().refs).toBe("recommended");
        expect(answersFromFlags({ refs: "all" })._unsafeUnwrap().refs).toBe("all");
        expect(answersFromFlags({ refs: "demo, other, demo" })._unsafeUnwrap().refs).toEqual(["demo", "other"]);
    });

    test("a preset word is command vocabulary, so --refs takes it in any casing", () => {
        expect(answersFromFlags({ refs: "ALL" })._unsafeUnwrap().refs).toBe("all");
        expect(answersFromFlags({ refs: "Recommended" })._unsafeUnwrap().refs).toBe("recommended");
        expect(answersFromFlags({ refs: " All " })._unsafeUnwrap().refs).toBe("all");
    });

    test("a dataset id keeps its casing — an id is the catalog's identifier, not this CLI's vocabulary", () => {
        expect(answersFromFlags({ refs: "CollecTRI" })._unsafeUnwrap().refs).toEqual(["CollecTRI"]);
        expect(answersFromFlags({ refs: "CollecTRI, MSigDB-Hallmark" })._unsafeUnwrap().refs).toEqual(["CollecTRI", "MSigDB-Hallmark"]);
    });

    test("--config names the answers file and is never itself an answer", () => {
        expect(answersFromFlags({ config: "./fleet.yml" })._unsafeUnwrap()).toEqual(answersFromFlags({})._unsafeUnwrap());
    });

    test("flag-level and schema-level problems are reported in ONE pass, not one class per run", () => {
        // A malformed port never becomes a candidate value (this front-end drops it), while a bad `--runtime`
        // is only the schema's to judge. Reporting the first and stopping would send the author back for a
        // second run to discover the second — the same fix-it-once contract the file front-end holds.
        const problems = problemsOf(answersFromFlags({ postgresPort: "0x1F5B", runtime: "podmen" })._unsafeUnwrapErr());
        expect(problems).toHaveLength(2);
        const text = problems.join("\n");
        expect(text).toContain("--postgres-port");
        expect(text).toContain("must be a whole number");
        expect(text).toContain("--runtime");
    });

    test("a dropped flag candidate is never double-reported — the schema does not see it", () => {
        // The incoherent credential source is dropped from the raw object, so only the flag-level message
        // about it survives; zod has nothing to say about an `auth` key that is not there.
        const problems = problemsOf(answersFromFlags({ authEnv: "VAR", authCommand: "cmd", authScheme: "bearer" })._unsafeUnwrapErr());
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("exactly one");
    });

    test("a URL answer must parse as a URL WITH a scheme", () => {
        for (const flags of [{ baseUrl: "gw.corp" }, { embeddingsUrl: "embeds.internal/v1" }] as const) {
            expect(problemsOf(answersFromFlags(flags)._unsafeUnwrapErr()).join("\n")).toContain("must be a URL with a scheme");
        }
        // Both spellings, like every other value-domain error here.
        const text = problemsOf(answersFromFlags({ baseUrl: "gw.corp/v1" })._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--base-url");
        expect(text).toContain("connection.baseURL");
        expect(answersFromFlags({ baseUrl: "https://gw.corp/v1" })._unsafeUnwrap().connection?.baseURL).toBe("https://gw.corp/v1");
    });

    test("a scheme-less endpoint fails the whole direct answer set upfront", () => {
        // The spec'd shape: an otherwise-complete direct connection whose endpoint has no scheme. `--no-validate`
        // is a run modifier this layer never sees — the point is that skipping the network probes cannot
        // rescue an answer that was never addressable to begin with.
        const text = problemsOf(
            loadSetupAnswers({ connection: "direct", baseUrl: "gw.corp", provider: "anthropic", model: "m" }, batch())._unsafeUnwrapErr(),
        ).join("\n");
        expect(text).toContain("--base-url");
        expect(text).toContain("connection.baseURL");
        expect(text).toContain("must be a URL with a scheme");
    });
});

describe("answer normalization — one schema, so both front-ends read a value identically", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function fromFile(body: string): SetupAnswers {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, body);
        return readAnswersFile(path)._unsafeUnwrap();
    }

    test("a provider answer is trimmed and case-folded, from the FLAG as well as the file", () => {
        // Every consumer of a provider answer compares it exact-lowercase (the vendor-slug shape, the OAuth
        // account kinds, the protocol implication, the conventional model and api-key variable lookups), so an
        // unfolded `Anthropic` misses all of them silently instead of failing.
        expect(answersFromFlags({ provider: "  Anthropic  " })._unsafeUnwrap().connection?.provider).toBe("anthropic");
        expect(fromFile("connection:\n  provider: '  Anthropic  '\n").connection?.provider).toBe("anthropic");
        expect(answersFromFlags({ provider: "DeepSeek" })._unsafeUnwrap().connection?.provider).toBe("deepseek");
    });

    test("a folded provider then satisfies the vocabularies that used to miss it", () => {
        // Interactive cliproxy takes an account kind; direct takes a lowercase vendor slug. Both now accept
        // the mixed-case spelling a shell or a hand-written file produces.
        expect(
            resolveSetupAnswers(answersFromFlags({ connection: "cliproxy", provider: "Claude" })._unsafeUnwrap(), undefined, interactive())._unsafeUnwrap()
                .answers.connection?.provider,
        ).toBe("claude");
        const direct = answersFromFlags({
            connection: "direct",
            provider: "DeepSeek",
            baseUrl: "https://gw.corp/v1",
            model: "d1",
        })._unsafeUnwrap();
        expect(resolveSetupAnswers(direct, undefined, batch())._unsafeUnwrap().answers.connection?.provider).toBe("deepseek");
    });

    test("free-text answers are trimmed but never case-folded — only the provider is vocabulary", () => {
        const answers = answersFromFlags({
            baseUrl: "  https://gw.corp/v1  ",
            model: " Claude-Sonnet-5 ",
            postgresUser: " Fleet ",
            postgresDatabase: " Inflexa ",
            postgresHost: " Localhost ",
            embeddingsUrl: " https://api.openai.com/v1 ",
            embeddingsModel: " Text-Embedding-3-Small ",
            embeddingsGguf: " /models/M.gguf ",
            authEnv: " MY_TOKEN ",
            authScheme: "bearer",
        })._unsafeUnwrap();
        expect(answers.connection?.baseURL).toBe("https://gw.corp/v1");
        expect(answers.connection?.model).toBe("Claude-Sonnet-5");
        expect(answers.postgres).toEqual({ user: "Fleet", password: undefined, port: undefined, database: "Inflexa", host: "Localhost" });
        expect(answers.embedding).toEqual({
            mode: undefined,
            baseURL: "https://api.openai.com/v1",
            model: "Text-Embedding-3-Small",
            gguf: "/models/M.gguf",
        });
        expect(answers.connection?.auth).toEqual({ kind: "env", var: "MY_TOKEN", scheme: "bearer" });
        expect(answersFromFlags({ authCommand: " my-helper ", authScheme: "bearer" })._unsafeUnwrap().connection?.auth).toEqual({
            kind: "command",
            command: "my-helper",
            scheme: "bearer",
            format: undefined,
        });
    });

    test("the same trimming applies from the file", () => {
        const answers = fromFile("connection:\n  baseURL: '  https://gw.corp/v1  '\n  model: '  m1  '\npostgres:\n  user: '  fleet  '\n");
        expect(answers.connection?.baseURL).toBe("https://gw.corp/v1");
        expect(answers.connection?.model).toBe("m1");
        expect(answers.postgres?.user).toBe("fleet");
    });

    test("a postgres password keeps its whitespace — those characters are part of the secret", () => {
        expect(answersFromFlags({ postgresPassword: "  p a s s  " })._unsafeUnwrap().postgres?.password).toBe("  p a s s  ");
        expect(fromFile("postgres:\n  password: '  p a s s  '\n").postgres?.password).toBe("  p a s s  ");
    });

    test("an all-whitespace answer is reported as the empty answer it is", () => {
        expect(problemsOf(answersFromFlags({ provider: "   " })._unsafeUnwrapErr()).join("\n")).toContain("must not be empty");
        expect(problemsOf(answersFromFlags({ baseUrl: "  " })._unsafeUnwrapErr()).join("\n")).toContain("must not be empty");
    });
});

describe("resolveSetupAnswers — precedence", () => {
    test("a flag overrides the config file for that question", () => {
        const resolved = resolveSetupAnswers({ postgres: { password: "b" } }, { postgres: { password: "a" } }, batch())._unsafeUnwrap();
        expect(resolved.answers.postgres?.password).toBe("b");
    });

    test("the override is per QUESTION — the file's other fields in the same block survive", () => {
        const resolved = resolveSetupAnswers(
            { postgres: { password: "b" } },
            { postgres: { user: "fleet", password: "a", port: 5555 } },
            batch(),
        )._unsafeUnwrap();
        expect(resolved.answers.postgres).toEqual({ user: "fleet", password: "b", port: 5555, database: undefined, host: undefined });
    });

    test("a flag-declared credential source replaces a file-declared one wholesale (its fields are interlocked by kind)", () => {
        const flagAuth: SetupAuthAnswer = { kind: "env", var: "TOKEN", scheme: "bearer" };
        const resolved = resolveSetupAnswers(
            { ...DIRECT_BASELINE, connection: { ...DIRECT_BASELINE.connection, auth: flagAuth } },
            { connection: { auth: { kind: "command", command: "helper", scheme: "x-api-key", format: "raw" } } },
            batch(),
        )._unsafeUnwrap();
        expect(resolved.answers.connection?.auth).toEqual(flagAuth);
    });

    test("a file-only answer survives when no flag answers it", () => {
        const resolved = resolveSetupAnswers({}, { sandbox: true, runtime: "podman", refs: "all" }, batch())._unsafeUnwrap();
        expect(resolved.answers.sandbox).toBe(true);
        expect(resolved.answers.runtime).toBe("podman");
        expect(resolved.answers.refs).toBe("all");
    });
});

describe("resolveSetupAnswers — a mode-carrying flag supersedes the file's dependent leaves", () => {
    test("a file's api-key embedding block yields to `--embeddings off`, and the drop is announced", () => {
        const resolved = resolveSetupAnswers(
            { embedding: { mode: "off" } },
            { embedding: { mode: "api-key", baseURL: "https://api.openai.com/v1", model: "text-embedding-3-small" } },
            batch(),
        )._unsafeUnwrap();
        expect(resolved.answers.embedding?.mode).toBe("off");
        expect(resolved.answers.embedding?.baseURL).toBeUndefined();
        expect(resolved.answers.embedding?.model).toBeUndefined();
        expect(resolved.notes).toHaveLength(1);
        const note = resolved.notes.join("\n");
        expect(note).toContain("--embeddings off");
        expect(note).toContain("`embedding.baseURL`");
        expect(note).toContain("`embedding.model`");
    });

    test("`--connection cliproxy` supersedes a direct-mode file's endpoint answers the same way", () => {
        const resolved = resolveSetupAnswers(
            { connection: { mode: "cliproxy" } },
            {
                connection: {
                    mode: "direct",
                    baseURL: "https://gw.corp/v1",
                    protocol: "anthropic",
                    auth: { kind: "env", var: "TOKEN", scheme: "bearer" },
                    model: "m1",
                },
            },
            batch(),
        )._unsafeUnwrap();
        expect(resolved.connectionMode).toBe("cliproxy");
        expect(resolved.answers.connection?.baseURL).toBeUndefined();
        expect(resolved.answers.connection?.protocol).toBeUndefined();
        expect(resolved.answers.connection?.auth).toBeUndefined();
        // `model` is valid in BOTH modes, so it is not the flag's to supersede.
        expect(resolved.answers.connection?.model).toBe("m1");
        const note = resolved.notes.join("\n");
        expect(note).toContain("--connection cliproxy");
        for (const key of ["`connection.baseURL`", "`connection.protocol`", "`connection.auth`"]) expect(note).toContain(key);
    });

    test("a flag mode against a FLAG leaf is a same-source contradiction and still fails upfront", () => {
        const text = problemsOf(resolveSetupAnswers({ embedding: { mode: "off", baseURL: "https://gw.corp/v1" } }, undefined, batch())._unsafeUnwrapErr()).join(
            "\n",
        );
        expect(text).toContain("--embeddings-url");
        expect(text).toContain("resolves to off");
    });

    test("an all-FILE mismatch still fails — nothing moved the mode, so there is no override to honor", () => {
        const text = problemsOf(resolveSetupAnswers({}, { embedding: { mode: "off", baseURL: "https://gw.corp/v1" } }, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--embeddings-url");
        expect(text).toContain("resolves to off");
    });

    test("a flag mode the file's leaves already agree with supersedes nothing, and says nothing", () => {
        const resolved = resolveSetupAnswers(
            { embedding: { mode: "api-key" } },
            { embedding: { mode: "api-key", baseURL: "https://api.openai.com/v1" } },
            batch("sk-embed"),
        )._unsafeUnwrap();
        expect(resolved.answers.embedding?.baseURL).toBe("https://api.openai.com/v1");
        expect(resolved.notes).toEqual([]);
    });

    test("a run with no mode flag never supersedes, so a plain merge carries no notes", () => {
        expect(resolveSetupAnswers({ postgres: { password: "b" } }, { postgres: { password: "a" } }, batch())._unsafeUnwrap().notes).toEqual([]);
    });

    test("the supersede is per LEAF: a value the new mode DOES consume survives", () => {
        // `--embeddings api-key` over a local-mode file keeps the file's endpoint answers and drops only the
        // GGUF, which nothing but `local` could have consumed.
        const resolved = resolveSetupAnswers(
            { embedding: { mode: "api-key" } },
            { embedding: { mode: "local", gguf: "/models/m.gguf", baseURL: "https://api.openai.com/v1" } },
            batch("sk-embed"),
        )._unsafeUnwrap();
        expect(resolved.answers.embedding?.gguf).toBeUndefined();
        expect(resolved.answers.embedding?.baseURL).toBe("https://api.openai.com/v1");
        expect(resolved.notes.join("\n")).toContain("`embedding.gguf`");
    });
});

describe("resolveSetupAnswers — batch defaults and required answers", () => {
    test("a bare batch run resolves to the cliproxy default with nothing else answered", () => {
        const resolved = resolveSetupAnswers({}, undefined, batch())._unsafeUnwrap();
        expect(resolved.connectionMode).toBe("cliproxy");
        expect(resolved.batch).toBe(true);
        expect(answerOf(resolved.answers.refs).answered).toBe(false);
        expect(answerOf(resolved.answers.sandbox).answered).toBe(false);
        expect(answerOf(resolved.answers.connection?.model).answered).toBe(false);
    });

    test("batch direct without endpoint/provider/model fails naming all three, in both spellings", () => {
        const problems = problemsOf(resolveSetupAnswers({ connection: { mode: "direct" } }, undefined, batch())._unsafeUnwrapErr());
        expect(problems).toHaveLength(3);
        const text = problems.join("\n");
        for (const spelling of ["--base-url", "connection.baseURL", "--provider", "connection.provider", "--model", "connection.model"]) {
            expect(text).toContain(spelling);
        }
    });

    test("batch direct with all three required answers resolves", () => {
        const resolved = resolveSetupAnswers(DIRECT_BASELINE, undefined, batch())._unsafeUnwrap();
        expect(resolved.connectionMode).toBe("direct");
        expect(resolved.answers.connection?.model).toBe("m1");
    });

    test("an interactive direct run requires nothing upfront — the wizard still asks", () => {
        expect(resolveSetupAnswers({ connection: { mode: "direct" } }, undefined, interactive())._unsafeUnwrap().connectionMode).toBe("direct");
    });

    test("the model answer is valid in BOTH modes (cliproxy pins it without a prompt)", () => {
        const resolved = resolveSetupAnswers({ connection: { mode: "cliproxy", model: "some-model" } }, undefined, batch())._unsafeUnwrap();
        expect(resolved.answers.connection?.model).toBe("some-model");
    });
});

describe("resolveSetupAnswers — the --provider vocabulary keys on the connection mode", () => {
    test("batch cliproxy rejects a provider answer and points at the first-launch sign-in", () => {
        const text = problemsOf(resolveSetupAnswers({ connection: { provider: "claude" } }, undefined, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--provider");
        expect(text).toContain("connection.provider");
        expect(text).toContain("unattended");
        expect(text).toContain("first `inflexa` launch");
    });

    test("interactive cliproxy takes an OAuth account kind", () => {
        for (const kind of OAUTH_ACCOUNT_KINDS) {
            expect(resolveSetupAnswers({ connection: { mode: "cliproxy", provider: kind } }, undefined, interactive())._unsafeUnwrap().batch).toBe(false);
        }
    });

    test("interactive cliproxy rejects a vendor slug that is not an account kind", () => {
        const text = problemsOf(
            resolveSetupAnswers({ connection: { mode: "cliproxy", provider: "anthropic" } }, undefined, interactive())._unsafeUnwrapErr(),
        ).join("\n");
        expect(text).toContain("OAuth account kind");
        expect(text).toContain("gemini, openai, claude, qwen, iflow");
    });

    test("direct mode takes an open vendor slug with no account-kind validation", () => {
        const resolved = resolveSetupAnswers(
            { connection: { mode: "direct", provider: "deepseek", baseURL: "https://gw.corp/v1", model: "d1" } },
            undefined,
            batch(),
        )._unsafeUnwrap();
        expect(resolved.answers.connection?.provider).toBe("deepseek");
    });

    test("direct mode still rejects a provider that is not a lowercase slug", () => {
        const text = problemsOf(
            resolveSetupAnswers(
                { ...DIRECT_BASELINE, connection: { ...DIRECT_BASELINE.connection, provider: "Anthropic Inc" } },
                undefined,
                batch(),
            )._unsafeUnwrapErr(),
        ).join("\n");
        expect(text).toContain("lowercase vendor slug");
    });
});

describe("resolveSetupAnswers — no answer is ever silently ignored", () => {
    test("direct-only connection answers are rejected under cliproxy", () => {
        const problems = problemsOf(
            resolveSetupAnswers(
                {
                    connection: {
                        mode: "cliproxy",
                        baseURL: "https://gw.corp/v1",
                        protocol: "anthropic",
                        auth: { kind: "env", var: "TOKEN", scheme: "bearer" },
                    },
                },
                undefined,
                batch(),
            )._unsafeUnwrapErr(),
        );
        expect(problems).toHaveLength(3);
        const text = problems.join("\n");
        for (const spelling of ["--base-url", "--protocol", "--auth-env", "connection.baseURL", "connection.protocol", "connection.auth"]) {
            expect(text).toContain(spelling);
        }
        expect(text).toContain("resolves to cliproxy");
    });

    test("an interactive run with no connection mode rejects a direct-only answer rather than letting the prompt strand it", () => {
        // The mode prompt has not happened yet, and it may well resolve to cliproxy — at which point nothing
        // consumes `--base-url` and the run reports success having ignored it.
        const problems = problemsOf(
            resolveSetupAnswers(
                {
                    connection: {
                        baseURL: "https://gw.corp/v1",
                        protocol: "anthropic",
                        auth: { kind: "env", var: "TOKEN", scheme: "bearer" },
                    },
                },
                undefined,
                interactive(),
            )._unsafeUnwrapErr(),
        );
        expect(problems).toHaveLength(3);
        const text = problems.join("\n");
        for (const spelling of ["--base-url", "connection.baseURL", "--protocol", "connection.protocol", "--auth-env", "connection.auth"]) {
            expect(text).toContain(spelling);
        }
        // The fix the author is told to make names the question that is missing, in both spellings.
        expect(text).toContain("--connection");
        expect(text).toContain("connection.mode");
    });

    test("naming the mode makes the same direct-only answer resolve interactively", () => {
        const resolved = resolveSetupAnswers({ connection: { mode: "direct", baseURL: "https://gw.corp/v1" } }, undefined, interactive())._unsafeUnwrap();
        expect(resolved.connectionMode).toBe("direct");
        expect(resolved.answers.connection?.baseURL).toBe("https://gw.corp/v1");
    });

    test("provider and model are valid in BOTH modes, so an unresolved mode does not reject them", () => {
        // `--provider claude` on an interactive run is a long-standing valid invocation: the wizard's cliproxy
        // branch consumes it as an account kind and its direct branch as a vendor slug.
        const resolved = resolveSetupAnswers({ connection: { provider: "claude", model: "m1" } }, undefined, interactive())._unsafeUnwrap();
        expect(resolved.connectionMode).toBeUndefined();
        expect(resolved.answers.connection?.provider).toBe("claude");
        expect(resolved.answers.connection?.model).toBe("m1");
    });

    test("a local-model answer is rejected against api-key embeddings, and endpoint answers against local/off", () => {
        const gguf = problemsOf(
            resolveSetupAnswers({ embedding: { mode: "api-key", gguf: "/models/m.gguf" } }, undefined, batch("sk-embed"))._unsafeUnwrapErr(),
        ).join("\n");
        expect(gguf).toContain("--embeddings-gguf");
        expect(gguf).toContain("embedding.gguf");
        expect(gguf).toContain("resolves to api-key");

        const endpoint = problemsOf(
            resolveSetupAnswers(
                { embedding: { mode: "local", baseURL: "https://api.openai.com/v1", model: "text-embedding-3-small" } },
                undefined,
                batch(),
            )._unsafeUnwrapErr(),
        );
        expect(endpoint).toHaveLength(2);
        expect(endpoint.join("\n")).toContain("resolves to local");
    });

    test("batch endpoint answers without an embedding mode fail rather than stranding", () => {
        const text = problemsOf(resolveSetupAnswers({ embedding: { baseURL: "https://api.openai.com/v1" } }, undefined, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--embeddings-url");
        expect(text).toContain("--embeddings");
    });

    test("an embedding value answer demands its mode in EVERY run, not only batch", () => {
        // On an already-configured machine an unanswered mode leaves the backend as it is, so the interactive
        // step never reaches a writer with this value: the run would report success having written nothing.
        for (const [key, embedding] of [
            ["--embeddings-gguf", { gguf: "/models/new.gguf" }],
            ["--embeddings-url", { baseURL: "https://api.openai.com/v1" }],
            ["--embeddings-model", { model: "text-embedding-3-small" }],
        ] as const) {
            const problems = problemsOf(resolveSetupAnswers({ embedding }, undefined, interactive())._unsafeUnwrapErr());
            expect(problems).toHaveLength(1);
            const text = problems.join("\n");
            expect(text).toContain(key);
            expect(text).toContain(`embedding.${Object.keys(embedding)[0]}`);
            // Both spellings of the answer that is missing, so the file author can fix it in the file.
            expect(text).toContain("--embeddings");
            expect(text).toContain("embedding.mode");
        }
    });

    test("the mode makes the same interactive value answer resolve", () => {
        expect(
            resolveSetupAnswers({ embedding: { mode: "api-key", baseURL: "https://api.openai.com/v1" } }, undefined, interactive())._unsafeUnwrap().answers
                .embedding?.baseURL,
        ).toBe("https://api.openai.com/v1");
    });

    test("a preset word inside an id list is rejected — the words are reserved", () => {
        const text = problemsOf(resolveSetupAnswers({ refs: ["recommended", "demo"] }, undefined, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("--refs");
        expect(text).toContain("reserved preset word");
    });

    test("the reservation reads casing the same way the preset check does, and reports the author's spelling", () => {
        const text = problemsOf(resolveSetupAnswers({ refs: ["ALL", "demo"] }, undefined, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("ALL");
        expect(text).toContain("reserved preset word");
    });

    test("a plain id list passes through — catalog membership is the refs module's question", () => {
        expect(resolveSetupAnswers({ refs: ["demo", "other"] }, undefined, batch())._unsafeUnwrap().answers.refs).toEqual(["demo", "other"]);
        expect(refsPresetOf("demo")).toBeUndefined();
    });
});

describe("resolveSetupAnswers — reserved Postgres ports", () => {
    test("a reserved channel default is a hard error under batch (a silently unpersisted value is invisible in automation)", () => {
        for (const port of reservedPostgresPorts) {
            const text = problemsOf(resolveSetupAnswers({ postgres: { port } }, undefined, batch())._unsafeUnwrapErr()).join("\n");
            expect(text).toContain("--postgres-port");
            expect(text).toContain("postgres.port");
            expect(text).toContain(String(port));
        }
    });

    test("interactive behavior is unchanged — the wizard keeps its warn-and-use-once", () => {
        const port = reservedPostgresPorts[0]!;
        expect(resolveSetupAnswers({ postgres: { port } }, undefined, interactive())._unsafeUnwrap().answers.postgres?.port).toBe(port);
    });

    test("any other port is a genuine choice", () => {
        expect(resolveSetupAnswers({ postgres: { port: 5555 } }, undefined, batch())._unsafeUnwrap().answers.postgres?.port).toBe(5555);
    });
});

describe("resolveSetupAnswers — the embedding secret's one channel", () => {
    test("batch api-key embeddings without the environment variable fail upfront naming it", () => {
        const text = problemsOf(resolveSetupAnswers({ embedding: { mode: "api-key" } }, undefined, batch())._unsafeUnwrapErr()).join("\n");
        expect(text).toContain("INFLEXA_EMBEDDING_API_KEY");
        expect(text).toContain("never ride");
    });

    test("with the variable exported, the same answers resolve", () => {
        const resolved = resolveSetupAnswers({ embedding: { mode: "api-key" } }, undefined, batch("sk-embed"))._unsafeUnwrap();
        expect(resolved.answers.embedding?.mode).toBe("api-key");
    });

    test("an interactive run still prompts for the secret, so its absence is not an upfront failure", () => {
        expect(resolveSetupAnswers({ embedding: { mode: "api-key" } }, undefined, interactive())._unsafeUnwrap().batch).toBe(false);
    });

    test("the other embedding modes never consult the variable", () => {
        expect(resolveSetupAnswers({ embedding: { mode: "local" } }, undefined, batch())._unsafeUnwrap().answers.embedding?.mode).toBe("local");
        expect(resolveSetupAnswers({ embedding: { mode: "off" } }, undefined, batch())._unsafeUnwrap().answers.embedding?.mode).toBe("off");
    });
});

describe("resolveSetupAnswers — every problem is reported in one pass", () => {
    test("an answer set with several faults lists them all, each naming a flag and a file key", () => {
        const problems = problemsOf(
            resolveSetupAnswers(
                {
                    connection: { mode: "direct" },
                    postgres: { port: reservedPostgresPorts[0]! },
                    embedding: { mode: "api-key", gguf: "/models/m.gguf" },
                    refs: ["all"],
                },
                undefined,
                batch(),
            )._unsafeUnwrapErr(),
        );
        // 3 missing direct answers + reserved port + gguf mismatch + missing embedding key + reserved refs word.
        expect(problems).toHaveLength(7);
        for (const problem of problems) {
            // Each line either names a flag or is the secret's env-var problem, which has no flag by design.
            expect(problem.includes("--") || problem.includes("INFLEXA_EMBEDDING_API_KEY")).toBe(true);
        }
    });
});

describe("isBatchRun", () => {
    test("--yes is batch even on a TTY (the deliberate break from the refs-consent-only meaning)", () => {
        expect(isBatchRun(true, true)).toBe(true);
    });

    test("a non-TTY run resolves like --yes", () => {
        expect(isBatchRun(undefined, false)).toBe(true);
        expect(isBatchRun(false, false)).toBe(true);
    });

    test("a TTY without --yes stays interactive", () => {
        expect(isBatchRun(undefined, true)).toBe(false);
        expect(isBatchRun(false, true)).toBe(false);
    });
});

describe("answerOf — the orchestrator's per-question view", () => {
    test("an answered question carries its value; an unanswered one is promptable", () => {
        expect(answerOf("python")).toEqual({ answered: true, value: "python" });
        expect(answerOf(undefined)).toEqual({ answered: false });
    });

    test("an interactive run with a partial file leaves the unanswered questions open", () => {
        const resolved = resolveSetupAnswers({}, { connection: { mode: "cliproxy" }, postgres: { user: "fleet" } }, interactive())._unsafeUnwrap();
        expect(answerOf(resolved.answers.connection?.mode)).toEqual({ answered: true, value: "cliproxy" });
        expect(answerOf(resolved.answers.postgres?.user)).toEqual({ answered: true, value: "fleet" });
        expect(answerOf(resolved.answers.embedding?.mode).answered).toBe(false);
        expect(answerOf(resolved.answers.resources?.sharePct).answered).toBe(false);
        expect(answerOf(resolved.answers.refs).answered).toBe(false);
    });
});

describe("loadSetupAnswers — both front-ends in one call", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("the file answers most questions and the flags override the rest", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(
            path,
            "connection:\n  mode: direct\n  provider: anthropic\n  baseURL: https://api.anthropic.com/v1\n  model: a\npostgres:\n  password: a\n",
        );
        const resolved = loadSetupAnswers({ config: path, postgresPassword: "b", model: "b-model" }, batch())._unsafeUnwrap();
        expect(resolved.answers.connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: undefined,
            model: "b-model",
            auth: undefined,
        });
        expect(resolved.answers.postgres?.password).toBe("b");
    });

    test("a missing file fails before the flags are even considered", () => {
        // A file-BOUNDARY failure yielded no answers at all, so there is nothing to merge the flags with and
        // nothing a combined list would add beyond the one thing to fix first.
        const error = loadSetupAnswers({ config: join(dir, "absent.yml"), postgresPort: "abc" }, batch())._unsafeUnwrapErr();
        expect(error.type).toBe("answers_file_unreadable");
    });

    test("an unparseable file is terminal for the same reason", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "connection: [unclosed\n");
        expect(loadSetupAnswers({ config: path, postgresPort: "abc" }, batch())._unsafeUnwrapErr().type).toBe("answers_file_unparseable");
    });

    test("when BOTH front-ends have problems, both lists are reported in one pass", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "nope: 1\nresources:\n  sharePct: 300\n");
        const error = loadSetupAnswers({ config: path, postgresPort: "abc", authScheme: "bearer" }, batch())._unsafeUnwrapErr();
        const problems = problemsOf(error);
        const text = problems.join("\n");
        // The file's two problems…
        expect(text).toContain("`nope`");
        expect(text).toContain("--resource-share");
        // …and the flags' two, which a short-circuit on the file Result would have hidden until the next run.
        expect(text).toContain("--postgres-port");
        expect(text).toContain("--auth-env");
        expect(problems).toHaveLength(4);
        // The merged error has no single path, so each file problem carries its file inline instead.
        expect(problems.filter((problem) => problem.includes(path))).toHaveLength(2);
    });

    test("one side failing keeps its own error whole, so the file's header still names the file to open", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "nope: 1\n");
        const fileOnly = loadSetupAnswers({ config: path }, batch())._unsafeUnwrapErr();
        expect(fileOnly.type === "answers_invalid" && fileOnly.path).toBe(path);
        expect(describeSetupAnswersError(fileOnly)).toContain(`\`${path}\` is not usable`);

        const flagsOnly = loadSetupAnswers({ postgresPort: "abc" }, batch())._unsafeUnwrapErr();
        expect(flagsOnly.type === "answers_invalid" && flagsOnly.path).toBeUndefined();
    });

    test("without --config the flags stand alone", () => {
        expect(loadSetupAnswers({ sandbox: true }, batch())._unsafeUnwrap().answers.sandbox).toBe(true);
    });

    test("--config pointed at a DIRECTORY is the unreadable-file error, not a parse failure", () => {
        // The everyday typo (`--config .` , `--config ./conf`) must read as "I could not read that", which
        // is the only message that tells the author to look at the path rather than the contents.
        const error = loadSetupAnswers({ config: dir }, batch())._unsafeUnwrapErr();
        expect(error.type).toBe("answers_file_unreadable");
        expect(describeSetupAnswersError(error)).toContain(dir);
    });

    test("a mode-mismatched answer arriving from the FILE fails the same way a flag's does", () => {
        // The file leg reaches the resolver through a different path than a pre-parsed object does, and it
        // is the leg a fleet actually uses — a mismatch that only ever failed for flags would ship.
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "connection:\n  mode: cliproxy\n  baseURL: https://gw.corp/v1\nembedding:\n  mode: api-key\n  gguf: /models/m.gguf\n");
        const problems = problemsOf(loadSetupAnswers({ config: path }, batch("sk-embed"))._unsafeUnwrapErr());
        expect(problems).toHaveLength(2);
        const text = problems.join("\n");
        expect(text).toContain("--base-url");
        expect(text).toContain("resolves to cliproxy");
        expect(text).toContain("--embeddings-gguf");
        expect(text).toContain("resolves to api-key");
    });

    test("a mode flag supersedes the file's leaves end to end, through the file front-end", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "embedding:\n  mode: api-key\n  baseURL: https://api.openai.com/v1\n  model: text-embedding-3-small\n");
        const resolved = loadSetupAnswers({ config: path, embeddings: "off" }, batch())._unsafeUnwrap();
        expect(resolved.answers.embedding).toEqual({ mode: "off", baseURL: undefined, model: undefined, gguf: undefined });
        expect(resolved.notes.join("\n")).toContain("--embeddings off");
    });

    test("both flags answering the embedding block still fail, file or no file", () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "embedding:\n  mode: api-key\n  baseURL: https://api.openai.com/v1\n");
        const text = problemsOf(loadSetupAnswers({ config: path, embeddings: "off", embeddingsUrl: "https://gw.corp/v1" }, batch())._unsafeUnwrapErr()).join(
            "\n",
        );
        expect(text).toContain("--embeddings-url");
        expect(text).toContain("resolves to off");
    });
});

describe("answer spellings", () => {
    test("a question renders as its flag and its file key", () => {
        expect(answerSpelling("connection.baseURL")).toBe("`--base-url` / `connection.baseURL`");
        expect(answerSpelling("resources.sharePct")).toBe("`--resource-share` / `resources.sharePct`");
    });

    test("a file-only question says so rather than inventing a flag", () => {
        expect(answerSpelling("connection.auth.ttlMs")).toContain("config file only");
        expect(answerSpelling("connection.auth.ttlMs")).not.toContain("--");
    });

    test("a BLOCK is spellable too — it names the flag family that fills it", () => {
        // A block carries no value of its own, but a file can mis-shape one, and that error has to point an
        // argv-only author somewhere. Naming the family beats pasting nine flags into one line.
        expect(answerSpelling("postgres")).toBe("`--postgres-*` / `postgres`");
        expect(answerSpelling("resources")).toContain("--resource-share");
        expect(answerSpelling("embedding")).toContain("--embeddings");
        expect(answerSpelling("connection")).toContain("--connection");
    });
});

describe("vocabulary agreement with the orchestrator", () => {
    test("the cliproxy provider answers are exactly setup.ts's account kinds", () => {
        // setup.ts owns the account-kind → vendor-slug map; `providerKindForSlug` is its inverse, so mapping
        // the slugs it writes back to kinds must reproduce this module's vocabulary. A kind renamed or
        // dropped there fails here instead of at the first fleet provision.
        const kinds = ["anthropic", "openai", "google", "qwen", "iflow"].map(providerKindForSlug);
        expect(new Set(kinds)).toEqual(new Set(OAUTH_ACCOUNT_KINDS));
    });

    test("the refs preset words are exactly the refs module's", () => {
        // The two lists are declared separately so this layer never loads the catalog, which leaves them
        // free to drift. TypeScript catches only one direction — `referenceSelectionOf` (setup.ts) assigns
        // a RefsPreset into a ReferencePreset, so a word added HERE alone fails to compile. A word added
        // to REFERENCE_PRESETS alone compiles fine and is reserved by the collision check while staying
        // unreachable from `--refs`, which is what this equality catches.
        expect(new Set<string>(REFS_PRESETS)).toEqual(new Set<string>(REFERENCE_PRESETS));
    });

    test("an answered credential source is exactly what config.json persists", () => {
        // Compile-time: a widening on either side breaks this assignment rather than surfacing as a bad
        // config write once the orchestrator wires the answer into `writeDirectConnection`.
        const answered: SetupAuthAnswer = { kind: "command", command: "helper", scheme: "bearer", format: "raw", ttlMs: 1000 };
        const persisted: ModelAuthConfig = answered;
        expect(persisted).toEqual(answered);
    });
});
