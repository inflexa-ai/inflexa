import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    OAUTH_ACCOUNT_KINDS,
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
sandbox: python
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
            sandbox: "python",
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
            sandbox: "python-r",
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
            sandbox: "python-r",
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
        const resolved = resolveSetupAnswers({}, { sandbox: "python", runtime: "podman", refs: "all" }, batch())._unsafeUnwrap();
        expect(resolved.answers.sandbox).toBe("python");
        expect(resolved.answers.runtime).toBe("podman");
        expect(resolved.answers.refs).toBe("all");
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

    test("an interactive run whose mode is still unanswered does not pre-judge a direct-only answer", () => {
        // The mode prompt has not happened yet: rejecting `--base-url` here would refuse a coherent run.
        const resolved = resolveSetupAnswers({ connection: { baseURL: "https://gw.corp/v1" } }, undefined, interactive())._unsafeUnwrap();
        expect(resolved.connectionMode).toBeUndefined();
        expect(resolved.answers.connection?.baseURL).toBe("https://gw.corp/v1");
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

    test("interactive endpoint answers without a mode are fine — the prompt decides which apply", () => {
        expect(
            resolveSetupAnswers({ embedding: { baseURL: "https://api.openai.com/v1" } }, undefined, interactive())._unsafeUnwrap().answers.embedding?.baseURL,
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
        const error = loadSetupAnswers({ config: join(dir, "absent.yml"), postgresPort: "abc" }, batch())._unsafeUnwrapErr();
        expect(error.type).toBe("answers_file_unreadable");
    });

    test("without --config the flags stand alone", () => {
        expect(loadSetupAnswers({ sandbox: "python" }, batch())._unsafeUnwrap().answers.sandbox).toBe("python");
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
});

describe("vocabulary agreement with the orchestrator", () => {
    test("the cliproxy provider answers are exactly setup.ts's account kinds", () => {
        // setup.ts owns the account-kind → vendor-slug map; `providerKindForSlug` is its inverse, so mapping
        // the slugs it writes back to kinds must reproduce this module's vocabulary. A kind renamed or
        // dropped there fails here instead of at the first fleet provision.
        const kinds = ["anthropic", "openai", "google", "qwen", "iflow"].map(providerKindForSlug);
        expect(new Set(kinds)).toEqual(new Set(OAUTH_ACCOUNT_KINDS));
    });

    test("an answered credential source is exactly what config.json persists", () => {
        // Compile-time: a widening on either side breaks this assignment rather than surfacing as a bad
        // config write once the orchestrator wires the answer into `writeDirectConnection`.
        const answered: SetupAuthAnswer = { kind: "command", command: "helper", scheme: "bearer", format: "raw", ttlMs: 1000 };
        const persisted: ModelAuthConfig = answered;
        expect(persisted).toEqual(answered);
    });
});
