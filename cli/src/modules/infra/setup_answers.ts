import { readFileSync } from "node:fs";
import { Result, ok, err } from "neverthrow";
import { z } from "zod";

import { runtimeIds } from "../../lib/container.ts";
import { EMBEDDING_API_KEY_VAR, isReservedPostgresPort, reservedPostgresPorts, resolveEmbeddingApiKey } from "../../lib/env.ts";
import { SANDBOX_VARIANTS } from "../libs/images.ts";
import { type ConnectionMode } from "./compose.ts";

// The setup ANSWERS layer: one schema for every interactive decision point of `inflexa setup`, two
// front-ends that populate it (value flags, the `--config` YAML file), and the resolver that merges them
// and validates the whole set BEFORE the orchestrator mutates anything.
//
// Resolution per question is `flag > config-file value > prompt (TTY and not --yes) > default-or-error`.
// This module owns the first two and the classification of the rest: it never prompts and never writes —
// it answers "is this question answered, and is the whole set coherent?", so a batch run fails at
// provision time with an actionable message instead of on the client's first chat.
//
// Two rules shape everything here:
//   - NO ANSWER IS EVER SILENTLY IGNORED. An answer the resolved modes cannot consume (a direct-only
//     `--base-url` under cliproxy, an `--embeddings-gguf` with api-key embeddings) is an ERROR, not a
//     no-op — silently dropping it is how a fleet ends up misconfigured with a green setup run.
//   - EVERY ERROR NAMES BOTH SPELLINGS (see {@link answerSpelling}), because the same question is
//     answerable from a flag or a file key and the author must be able to fix it in either.
//
// Secrets never ride an answer (design D7): the direct-connection key and the api-key embedding secret
// stay environment reads through lib/env.ts. The credential-source answers (`connection.auth.*`) are
// token-free by construction — a variable name, a command string, a scheme — exactly what config.json
// already stores.

// --- the answer model ------------------------------------------------------

/** The reference-data preset words an answer may carry in place of an explicit id list. */
export const REFS_PRESETS = ["recommended", "all"] as const;

/** A reference-data preset word — `recommended` (the catalog's recommended datasets) or `all` (everything offered). */
export type RefsPreset = (typeof REFS_PRESETS)[number];

/**
 * The preset `value` names, in its canonical spelling — or `undefined` when it is a catalog dataset id.
 *
 * Matched case-INSENSITIVELY, and this is the only place in the refs answer that folds case. A preset is
 * command VOCABULARY: a word this CLI defines, so `--refs ALL` is the same instruction as `--refs all`, and
 * answering a correctly-spelled word with "unknown dataset id" is a dead end the author cannot debug. A
 * dataset id is an IDENTIFIER the catalog owns and is compared exactly — folding one would silently rewrite
 * what the author named into an id that may or may not exist.
 */
export function refsPresetOf(value: string): RefsPreset | undefined {
    const word = value.toLowerCase();
    return REFS_PRESETS.find((preset) => preset === word);
}

/**
 * The OAuth account kinds a `provider` answer names in CLIPROXY mode — the vocabulary of the accounts the
 * proxy can log into, disjoint in meaning (though overlapping in spelling) from the open vendor slug the
 * same answer carries in DIRECT mode. It lives here rather than in modules/infra/setup.ts's `Provider`
 * union because the orchestrator consumes this module, not the reverse: importing setup.ts from here would
 * close an import cycle. setup.ts's own `resolveProvider` re-validates the value at the command boundary,
 * so a drift between the two lists surfaces there as well; setup_answers.test.ts pins them together.
 */
export const OAUTH_ACCOUNT_KINDS = ["gemini", "openai", "claude", "qwen", "iflow"] as const;

/** A cliproxy OAuth account kind — the `--provider` vocabulary in cliproxy mode. */
export type OAuthAccountKind = (typeof OAUTH_ACCOUNT_KINDS)[number];

/** A direct-mode vendor slug: lowercase, digits, and `-`/`_`/`.` — an OPEN vocabulary (only its shape is checked). */
const VENDOR_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

const authSchemeSchema = z.enum(["x-api-key", "bearer"]);

/**
 * The credential-source answer — the strict-parse mirror of `modelAuthSchema` (lib/config.ts), which the
 * orchestrator persists verbatim as `models.connection.auth`. Declared separately rather than imported
 * because the persisted schema is deliberately LENIENT (config.json is runtime state that must survive
 * corruption) while an answers file is authored intent, where an unknown key must be an error rather than
 * a silently dropped instruction (design D6). The two shapes are kept assignable by a compile-time check
 * in setup_answers.test.ts.
 */
export const setupAuthAnswerSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("env"),
        var: z.string().min(1, { error: "must name an environment variable" }),
        scheme: authSchemeSchema,
    }),
    z.strictObject({
        kind: z.literal("command"),
        command: z.string().min(1, { error: "must name a command" }),
        scheme: authSchemeSchema,
        format: z.enum(["raw", "exec-credential"]).optional(),
        ttlMs: z.number().int().positive({ error: "must be a positive number of milliseconds" }).optional(),
    }),
]);

/** An answered credential source — token-free by construction (a variable name or command, plus its wire scheme). */
export type SetupAuthAnswer = z.infer<typeof setupAuthAnswerSchema>;

/**
 * Every setup question, in the config-file spelling (design D3). ALL fields are optional at parse time:
 * requiredness is CONTEXTUAL — a direct connection needs a `baseURL` only under batch resolution — and is
 * enforced by {@link resolveSetupAnswers}, never by the schema.
 *
 * Strict at every level: an unknown key is an error naming the key, which is what makes a typo'd
 * `embedings:` a failed provision rather than a silently skipped step. Execution modifiers (`--yes`,
 * `--no-start`, `--no-postgres`, `--force`, `--no-validate`, `--no-auth`) are absent BY CONSTRUCTION —
 * they answer "how should THIS run behave", not "what should this client look like", so their appearance
 * in a file is an unknown-key error with no extra machinery.
 */
export const setupAnswersSchema = z.strictObject({
    /** The chat backend: the managed local proxy, or a direct endpoint of the author's own. */
    connection: z
        .strictObject({
            mode: z.enum(["cliproxy", "direct"]).optional(),
            provider: z.string().min(1, { error: "must not be empty" }).optional(),
            baseURL: z.string().min(1, { error: "must not be empty" }).optional(),
            protocol: z.enum(["anthropic", "openai-compatible"]).optional(),
            model: z.string().min(1, { error: "must not be empty" }).optional(),
            auth: setupAuthAnswerSchema.optional(),
        })
        .optional(),
    /** The harness substrate's connection fields; unanswered fields keep their per-field defaults and persist nothing. */
    postgres: z
        .strictObject({
            user: z.string().min(1, { error: "must not be empty" }).optional(),
            password: z.string().min(1, { error: "must not be empty" }).optional(),
            port: z
                .number()
                .int()
                .min(1, { error: "must be a port between 1 and 65535" })
                .max(65535, { error: "must be a port between 1 and 65535" })
                .optional(),
            database: z.string().min(1, { error: "must not be empty" }).optional(),
            host: z.string().min(1, { error: "must not be empty" }).optional(),
        })
        .optional(),
    /** The machine allowance, as a PERCENTAGE so one file is portable across a heterogeneous fleet. */
    resources: z
        .strictObject({
            sharePct: z
                .number()
                .int()
                .min(1, { error: "must be a percentage between 1 and 100" })
                .max(100, { error: "must be a percentage between 1 and 100" })
                .optional(),
        })
        .optional(),
    /** Singular, matching config.json's block name. `gguf` belongs to `local`; `baseURL`/`model` to `api-key`. */
    embedding: z
        .strictObject({
            mode: z.enum(["local", "api-key", "off"]).optional(),
            baseURL: z.string().min(1, { error: "must not be empty" }).optional(),
            model: z.string().min(1, { error: "must not be empty" }).optional(),
            gguf: z.string().min(1, { error: "must not be empty" }).optional(),
        })
        .optional(),
    /** A preset word or an explicit dataset-id list. The value IS the download consent; absence downloads nothing. */
    refs: z
        .preprocess(
            // A scalar `refs:` can only ever be a preset attempt — ids are spelled as a list — so canonicalizing
            // a recognized preset word is the whole normalization (`refsPresetOf` owns why case folds here and
            // nowhere else). Anything unrecognized passes through untouched and fails the union below.
            (value) => (typeof value === "string" ? (refsPresetOf(value) ?? value) : value),
            z.union([z.enum(REFS_PRESETS), z.array(z.string().min(1)).min(1, { error: "must list at least one dataset id" })], {
                error: "must be a preset (`recommended` or `all`) or a non-empty list of dataset ids",
            }),
        )
        .optional(),
    /** The sandbox image variant to pull. The answer IS the multi-GB consent. */
    sandbox: z.enum(SANDBOX_VARIANTS).optional(),
    /** Pins the container runtime as a hard gate — given-but-dead is an error, never a silent fallback. */
    runtime: z.enum(runtimeIds).optional(),
});

/**
 * The resolved answer set — one optional field per setup question. An ABSENT field is an unanswered
 * question the orchestrator either prompts for (interactive) or resolves to its default (batch); see
 * {@link answerOf}.
 */
export type SetupAnswers = z.infer<typeof setupAnswersSchema>;

// --- errors ----------------------------------------------------------------

/**
 * Everything that can go wrong before setup mutates anything. Deliberately NOT one message string: the
 * resolver reports EVERY problem it found in one pass, so a fleet author fixes their file once instead of
 * re-running the provision per typo.
 */
export type SetupAnswersError =
    /** The `--config` path could not be read (absent, a directory, no permission). */
    | { readonly type: "answers_file_unreadable"; readonly path: string; readonly detail: string }
    /** The `--config` file was read but is not valid YAML. */
    | { readonly type: "answers_file_unparseable"; readonly path: string; readonly detail: string }
    /** The answers themselves are invalid. `path` names the answers file when the problems came from it, else `undefined` (flags / the merged set). */
    | { readonly type: "answers_invalid"; readonly path: string | undefined; readonly problems: readonly string[] };

/** Render a {@link SetupAnswersError} as the multi-line message the CLI boundary prints. */
export function describeSetupAnswersError(error: SetupAnswersError): string {
    switch (error.type) {
        case "answers_file_unreadable":
            return `Could not read the setup answers file \`${error.path}\` — ${error.detail}`;
        case "answers_file_unparseable":
            return `The setup answers file \`${error.path}\` is not valid YAML — ${error.detail}`;
        case "answers_invalid": {
            const header =
                error.path === undefined ? "`inflexa setup` cannot run with these answers:" : `The setup answers file \`${error.path}\` is not usable:`;
            return [header, ...error.problems.map((problem) => `  - ${problem}`)].join("\n");
        }
        default: {
            const exhaustive: never = error;
            throw new Error(`unhandled setup answers error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

// --- both spellings of one question ----------------------------------------

/**
 * Every answerable question in BOTH spellings: its config-file key path → its flag, or `null` when the
 * question has no flag (a value too niche for argv, answerable only in a file). The single source behind
 * {@link answerSpelling}, so an error message can never name one spelling and forget the other.
 */
const ANSWER_SPELLINGS = {
    "connection.mode": "--connection",
    "connection.provider": "--provider",
    "connection.baseURL": "--base-url",
    "connection.protocol": "--protocol",
    "connection.model": "--model",
    "connection.auth": "--auth-env / --auth-command",
    "connection.auth.kind": "--auth-env / --auth-command",
    "connection.auth.var": "--auth-env",
    "connection.auth.command": "--auth-command",
    "connection.auth.scheme": "--auth-scheme",
    "connection.auth.format": "--auth-format",
    "connection.auth.ttlMs": null,
    "postgres.user": "--postgres-user",
    "postgres.password": "--postgres-password",
    "postgres.port": "--postgres-port",
    "postgres.database": "--postgres-database",
    "postgres.host": "--postgres-host",
    "resources.sharePct": "--resource-share",
    "embedding.mode": "--embeddings",
    "embedding.baseURL": "--embeddings-url",
    "embedding.model": "--embeddings-model",
    "embedding.gguf": "--embeddings-gguf",
    refs: "--refs",
    sandbox: "--sandbox",
    runtime: "--runtime",
} as const satisfies Record<string, string | null>;

/** A setup question, named by its config-file key path (the key `--config` files use, and this module's canonical id). */
export type AnswerKey = keyof typeof ANSWER_SPELLINGS;

/**
 * Name a question in both spellings — ``` `--base-url` / `connection.baseURL` ``` — the opening of every
 * error this module reports. A file-only question renders as its key plus the reason it has no flag.
 */
export function answerSpelling(key: AnswerKey): string {
    const flag = ANSWER_SPELLINGS[key];
    return flag === null ? `\`${key}\` (config file only)` : `\`${flag}\` / \`${key}\``;
}

function isAnswerKey(key: string): key is AnswerKey {
    return Object.hasOwn(ANSWER_SPELLINGS, key);
}

/** Name whatever a zod issue points at: a known question in both spellings, else the raw path (an unmapped nested key). */
function spellPath(path: readonly PropertyKey[]): string {
    const key = path.join(".");
    return isAnswerKey(key) ? answerSpelling(key) : `\`${key}\``;
}

// The zod issue shape, derived from the schema rather than imported by name so it cannot drift with zod's
// type-export layout (the modules/harness/plan_intake.ts precedent).
type AnswersIssue = ReturnType<typeof setupAnswersSchema.safeParse> extends { error?: infer E } ? (E extends { issues: (infer I)[] } ? I : never) : never;

/** One zod issue → the problem lines it means, each naming the offending question in both spellings. */
function describeIssue(issue: AnswersIssue): string[] {
    if (issue.code === "unrecognized_keys") {
        return issue.keys.map(
            (key) =>
                `Unknown key \`${[...issue.path, key].join(".")}\` — not a setup answer. How a run behaves (start, force, postgres, validate, yes, auth) is answered by flags only, never by the file.`,
        );
    }
    return [`${spellPath(issue.path)} — ${issue.message}`];
}

/** An unknown thrown value's message, for the file-boundary errors — `String` covers the non-Error throws a runtime boundary can produce. */
function causeMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function parseAnswers(document: unknown, path: string | undefined): Result<SetupAnswers, SetupAnswersError> {
    const parsed = setupAnswersSchema.safeParse(document);
    if (parsed.success) return ok(parsed.data);
    return err({ type: "answers_invalid", path, problems: parsed.error.issues.flatMap(describeIssue) });
}

// --- the file front-end ----------------------------------------------------

/**
 * Load and strict-parse a `--config <file.yml>` answers file. Every failure mode names the path: an
 * unreadable file, a YAML syntax error, and each schema violation (unknown keys included) are all reported
 * here — BEFORE any mutation — because a file is authored intent, and the worst failure a fleet can have
 * is a mistyped key that silently skips a step.
 *
 * Parsed with the runtime's native YAML (`Bun.YAML.parse`, Bun 1.3+), so the answers file costs no
 * dependency. An empty document is a problem rather than "no answers": a file that answers nothing is a
 * broken deploy, not an intent worth honoring silently.
 */
export function readAnswersFile(path: string): Result<SetupAnswers, SetupAnswersError> {
    return Result.fromThrowable(
        () => readFileSync(path, "utf8"),
        (cause): SetupAnswersError => ({ type: "answers_file_unreadable", path, detail: causeMessage(cause) }),
    )()
        .andThen((text) =>
            Result.fromThrowable(
                // unknown: an on-disk YAML document, validated by the schema below.
                (): unknown => Bun.YAML.parse(text),
                (cause): SetupAnswersError => ({ type: "answers_file_unparseable", path, detail: causeMessage(cause) }),
            )(),
        )
        .andThen((document) => {
            // Bun.YAML.parse yields null for an empty (or comment-only) document; zod would report it as a
            // type error against the whole file, which reads as a schema problem rather than an empty file.
            if (document === null || document === undefined) {
                return err<SetupAnswers, SetupAnswersError>({
                    type: "answers_invalid",
                    path,
                    problems: ["the file is empty — it must be a YAML mapping of setup answers (e.g. `connection:`, `postgres:`, `refs:`)."],
                });
            }
            return parseAnswers(document, path);
        });
}

// --- the flag front-end ----------------------------------------------------

/**
 * The raw `setup` option values commander hands over — strings, exactly as typed on the command line,
 * keyed by commander's camelCased option names so the registry can pass `opts()` straight through. Parsing
 * and validation happen HERE, not in the registry, so both front-ends meet in one schema.
 */
export type SetupAnswerFlags = {
    /** `--config <path>`: names the answers FILE. Not itself an answer — {@link loadSetupAnswers} consumes it. */
    readonly config?: string;
    /** `--connection cliproxy|direct`. */
    readonly connection?: string;
    /** `--provider <name>`: an OAuth account kind (cliproxy) or a vendor slug (direct) — see {@link OAUTH_ACCOUNT_KINDS}. */
    readonly provider?: string;
    /** `--base-url <url>`: the direct endpoint, `/v1`-terminated as the wire layer requires. */
    readonly baseUrl?: string;
    /** `--protocol anthropic|openai-compatible`: the direct endpoint's wire kind (inferred from the provider when absent). */
    readonly protocol?: string;
    /** `--model <id>`: pins BOTH user-facing agents, as the wizard's explicit pick does. */
    readonly model?: string;
    /** `--auth-env <VAR>`: declares an env-variable credential source. */
    readonly authEnv?: string;
    /** `--auth-command <cmd>`: declares a command credential source. */
    readonly authCommand?: string;
    /** `--auth-scheme x-api-key|bearer`: the credential source's wire header. */
    readonly authScheme?: string;
    /** `--auth-format raw|exec-credential`: how a command source's stdout is read. */
    readonly authFormat?: string;
    /** `--postgres-user <name>`. */
    readonly postgresUser?: string;
    /** `--postgres-password <password>`. */
    readonly postgresPassword?: string;
    /** `--postgres-port <port>`: numeric; a reserved channel default is rejected under batch resolution. */
    readonly postgresPort?: string;
    /** `--postgres-database <name>`. */
    readonly postgresDatabase?: string;
    /** `--postgres-host <host>`. */
    readonly postgresHost?: string;
    /** `--resource-share <pct>`: numeric, 1–100. */
    readonly resourceShare?: string;
    /** `--embeddings local|api-key|off`. */
    readonly embeddings?: string;
    /** `--embeddings-url <url>`: the api-key endpoint. */
    readonly embeddingsUrl?: string;
    /** `--embeddings-model <id>`: the api-key model. */
    readonly embeddingsModel?: string;
    /** `--embeddings-gguf <path>`: a user-owned local GGUF. */
    readonly embeddingsGguf?: string;
    /** `--refs recommended|all|<id,…>`. */
    readonly refs?: string;
    /** `--sandbox python|python-r`. */
    readonly sandbox?: string;
    /** `--runtime docker|podman`. */
    readonly runtime?: string;
};

/** Keep a block only when it actually answers something, so an absent block reads as "no answers here". */
function pruned<T extends Record<string, unknown>>(block: T): T | undefined {
    return Object.values(block).some((value) => value !== undefined) ? block : undefined;
}

function wholeNumber(raw: string | undefined, key: AnswerKey, problems: string[]): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value)) {
        problems.push(`${answerSpelling(key)} — must be a whole number (got "${raw}").`);
        return undefined;
    }
    return value;
}

/**
 * A `--refs` value is a preset word OR a comma-separated id list. The preset check comes first and applies
 * only to a lone token, so `--refs recommended` is the preset while `--refs a,b` is an id list (a list
 * that CONTAINS a preset word is rejected in validation — the words are reserved).
 *
 * Ids are never touched beyond trimming and deduplication: whether one exists is the refs module's question,
 * asked where the catalog is already loaded. Pulling that catalog in here would make this layer know the
 * reference data it exists to stay ignorant of.
 */
function refsFromFlag(raw: string | undefined): RefsPreset | string[] | undefined {
    if (raw === undefined) return undefined;
    const tokens = [
        ...new Set(
            raw
                .split(",")
                .map((token) => token.trim())
                .filter(Boolean),
        ),
    ];
    const [only] = tokens;
    const preset = tokens.length === 1 && only !== undefined ? refsPresetOf(only) : undefined;
    return preset ?? tokens;
}

/**
 * Assemble the credential-source answer from the four `--auth-*` flags. The combination rules live here
 * rather than in the schema because the file spells the source as one discriminated block (`kind`) while
 * the flags spell it as independent switches, so only this front-end can say "you named two sources" or
 * "a source needs a scheme" in the user's own vocabulary.
 *
 * Returns `unknown`: what it builds is an unvalidated CANDIDATE (the scheme is still a raw string), and
 * {@link setupAuthAnswerSchema} is what turns it into a {@link SetupAuthAnswer} — typing it as the answer
 * here would assert a validation that has not happened yet.
 */
function authFromFlags(flags: SetupAnswerFlags, problems: string[]): unknown {
    const { authEnv, authCommand, authScheme, authFormat } = flags;
    if (authEnv === undefined && authCommand === undefined && authScheme === undefined && authFormat === undefined) return undefined;
    if (authEnv !== undefined && authCommand !== undefined) {
        problems.push(
            `${answerSpelling("connection.auth.var")} and ${answerSpelling("connection.auth.command")} are two credential sources — declare exactly one.`,
        );
        return undefined;
    }
    if (authEnv === undefined && authCommand === undefined) {
        problems.push(`${answerSpelling("connection.auth")} — a credential source needs \`--auth-env <VAR>\` or \`--auth-command <cmd>\`.`);
        return undefined;
    }
    if (authScheme === undefined) {
        problems.push(`${answerSpelling("connection.auth.scheme")} is required with a credential source — one of: x-api-key, bearer.`);
        return undefined;
    }
    if (authFormat !== undefined && authCommand === undefined) {
        problems.push(`${answerSpelling("connection.auth.format")} describes a command's output, so it needs \`--auth-command\`.`);
        return undefined;
    }
    return authEnv !== undefined
        ? { kind: "env", var: authEnv, scheme: authScheme }
        : { kind: "command", command: authCommand, scheme: authScheme, format: authFormat };
}

/**
 * Map the raw commander option values into the SAME answers shape the config file parses into — the reason
 * the two front-ends cannot drift: there is exactly one set of key names and one set of validations.
 * Value-domain errors (a misspelled mode, an out-of-range percentage) surface here naming both spellings;
 * CONTEXTUAL requirements are not checked here — they belong to {@link resolveSetupAnswers}, which sees
 * the merged set.
 */
export function answersFromFlags(flags: SetupAnswerFlags): Result<SetupAnswers, SetupAnswersError> {
    const problems: string[] = [];
    const auth = authFromFlags(flags, problems);
    const raw = {
        connection: pruned({
            mode: flags.connection,
            provider: flags.provider,
            baseURL: flags.baseUrl,
            protocol: flags.protocol,
            model: flags.model,
            auth,
        }),
        postgres: pruned({
            user: flags.postgresUser,
            password: flags.postgresPassword,
            port: wholeNumber(flags.postgresPort, "postgres.port", problems),
            database: flags.postgresDatabase,
            host: flags.postgresHost,
        }),
        resources: pruned({ sharePct: wholeNumber(flags.resourceShare, "resources.sharePct", problems) }),
        embedding: pruned({
            mode: flags.embeddings,
            baseURL: flags.embeddingsUrl,
            model: flags.embeddingsModel,
            gguf: flags.embeddingsGguf,
        }),
        refs: refsFromFlag(flags.refs),
        sandbox: flags.sandbox,
        runtime: flags.runtime,
    };
    // A flag that could not even be turned into a candidate value (a non-numeric port, an incoherent
    // credential source) is reported before the schema runs, so its message names the flag rather than
    // zod's view of a value we already know we dropped.
    if (problems.length > 0) return err({ type: "answers_invalid", path: undefined, problems });
    return parseAnswers(raw, undefined);
}

// --- resolution ------------------------------------------------------------

/**
 * BATCH resolution — never prompt, resolve every unanswered question to its default or fail — is `--yes`
 * OR the absence of a TTY. The two are one contract, not two behaviors: a scripted run with no terminal
 * must resolve exactly as `--yes` does, so nothing can hang waiting for an answer that cannot arrive.
 */
export function isBatchRun(yes: boolean | undefined, isTTY: boolean): boolean {
    return yes === true || !isTTY;
}

/** A question's resolution: an answer to consume, or a gap the orchestrator fills by prompt (interactive) or default (batch). */
export type Answer<T> = { readonly answered: true; readonly value: T } | { readonly answered: false };

/**
 * Classify one field of {@link SetupAnswers} for the orchestrator: `{answered: true, value}` when the run
 * supplied it (from either front-end), `{answered: false}` when the question is still open. The narrowing
 * is what keeps each step's branch honest — an answered question must never reach a prompt, and an
 * unanswered one must never be invented.
 */
export function answerOf<T>(value: T | undefined): Answer<T> {
    return value === undefined ? { answered: false } : { answered: true, value };
}

/** What `inflexa setup` needs to know about the invocation before it can resolve answers. */
export type SetupAnswersContext = {
    /** True when no prompt may run — `--yes` or a non-TTY invocation (see {@link isBatchRun}). */
    readonly batch: boolean;
    /**
     * Seam for the api-key embedding secret's presence check, defaulting to lib/env.ts's
     * `resolveEmbeddingApiKey` (the sole `process.env` reader). Injectable for tests only — it is the one
     * value in this module that is not a function of its inputs.
     */
    readonly embeddingApiKey?: () => string | undefined;
};

/** The outcome of a successful resolution — the merged answers plus the facts the orchestrator would otherwise re-derive. */
export type ResolvedSetupAnswers = {
    /** The merged per-question answers (flag over file). An absent field is an unanswered question. */
    readonly answers: SetupAnswers;
    /** Whether this run may prompt (see {@link isBatchRun}) — carried so every step reads one flag, not two. */
    readonly batch: boolean;
    /**
     * The connection mode the answers resolve to: the answer when given, the `cliproxy` default under batch,
     * and `undefined` when an interactive prompt still decides it (the ONE question whose default is not
     * applied early, because applying it would pre-empt the wizard's first question).
     */
    readonly connectionMode: ConnectionMode | undefined;
};

/** Merge one question: the flag answer when present, else the file's. Applied per LEAF, so a file block survives a single overriding flag. */
function mergeAnswers(file: SetupAnswers, flags: SetupAnswers): SetupAnswers {
    return {
        connection: pruned({
            mode: flags.connection?.mode ?? file.connection?.mode,
            provider: flags.connection?.provider ?? file.connection?.provider,
            baseURL: flags.connection?.baseURL ?? file.connection?.baseURL,
            protocol: flags.connection?.protocol ?? file.connection?.protocol,
            model: flags.connection?.model ?? file.connection?.model,
            // The credential source is ONE question, not four: its fields are interlocked by `kind`, so a
            // flag-declared source replaces a file-declared one wholesale rather than merging across kinds.
            auth: flags.connection?.auth ?? file.connection?.auth,
        }),
        postgres: pruned({
            user: flags.postgres?.user ?? file.postgres?.user,
            password: flags.postgres?.password ?? file.postgres?.password,
            port: flags.postgres?.port ?? file.postgres?.port,
            database: flags.postgres?.database ?? file.postgres?.database,
            host: flags.postgres?.host ?? file.postgres?.host,
        }),
        resources: pruned({ sharePct: flags.resources?.sharePct ?? file.resources?.sharePct }),
        embedding: pruned({
            mode: flags.embedding?.mode ?? file.embedding?.mode,
            baseURL: flags.embedding?.baseURL ?? file.embedding?.baseURL,
            model: flags.embedding?.model ?? file.embedding?.model,
            gguf: flags.embedding?.gguf ?? file.embedding?.gguf,
        }),
        refs: flags.refs ?? file.refs,
        sandbox: flags.sandbox ?? file.sandbox,
        runtime: flags.runtime ?? file.runtime,
    };
}

/** Validate the connection questions against the mode they resolved to. */
function validateConnection(answers: SetupAnswers, mode: ConnectionMode | undefined, batch: boolean, problems: string[]): void {
    const connection = answers.connection;
    // Mode still unresolved: an interactive run whose first prompt decides it. Every mode-keyed rule below
    // would be guessing, and rejecting `--base-url` before the user has answered "how should inflexa reach
    // models?" would reject a perfectly coherent interactive run.
    if (mode === undefined) return;

    if (mode === "direct") {
        if (batch) {
            if (connection?.baseURL === undefined) {
                problems.push(`${answerSpelling("connection.baseURL")} is required for a direct connection in a non-interactive run.`);
            }
            if (connection?.provider === undefined) {
                problems.push(
                    `${answerSpelling("connection.provider")} is required for a direct connection in a non-interactive run (the vendor slug, e.g. anthropic).`,
                );
            }
            if (connection?.model === undefined) {
                problems.push(
                    `${answerSpelling("connection.model")} is required for a direct connection in a non-interactive run — direct mode has no auto-resolve, so a client without one boots into \`model_required\`.`,
                );
            }
        }
        if (connection?.provider !== undefined && !VENDOR_SLUG.test(connection.provider)) {
            problems.push(
                `${answerSpelling("connection.provider")} — a direct connection's provider is a lowercase vendor slug (e.g. anthropic, openai, deepseek).`,
            );
        }
        return;
    }

    if (connection?.provider !== undefined) {
        // In cliproxy mode the provider names an OAuth ACCOUNT KIND, and that sign-in needs a human in a
        // browser — so under batch it is not "unsupported", it is unrunnable. Batch cliproxy setup is
        // pre-staging: everything but the login, which each client performs once at first launch.
        if (batch) {
            problems.push(
                `${answerSpelling("connection.provider")} names an OAuth account kind in cliproxy mode, and that sign-in cannot run unattended. Drop it — the first \`inflexa\` launch offers the sign-in — or pass \`--connection direct\` to name a vendor slug instead.`,
            );
        } else if (!(OAUTH_ACCOUNT_KINDS as readonly string[]).includes(connection.provider)) {
            problems.push(`${answerSpelling("connection.provider")} — in cliproxy mode it is an OAuth account kind: ${OAUTH_ACCOUNT_KINDS.join(", ")}.`);
        }
    }
    // The questions only a direct endpoint can consume. Key and value are written together so the pair can
    // never drift; `model` is deliberately absent — it is valid in BOTH modes (cliproxy pins it too).
    const directOnly: readonly (readonly [AnswerKey, unknown])[] = [
        ["connection.baseURL", connection?.baseURL],
        ["connection.protocol", connection?.protocol],
        ["connection.auth", connection?.auth],
    ];
    for (const [key, answered] of directOnly) {
        if (answered !== undefined) {
            problems.push(
                `${answerSpelling(key)} answers a direct connection, but the connection resolves to cliproxy — pass \`--connection direct\` / \`connection.mode: direct\`, or drop the answer.`,
            );
        }
    }
}

/** Validate the embedding questions against the mode they resolved to, including the secret's environment channel. */
function validateEmbedding(answers: SetupAnswers, batch: boolean, readKey: () => string | undefined, problems: string[]): void {
    const embedding = answers.embedding;
    const mode = embedding?.mode;
    if (mode === undefined) {
        // Unanswered embedding mode means "leave the configured backend unchanged" under batch, which would
        // silently strand any endpoint/model/gguf answer — so batch demands the mode that consumes them.
        // Interactive runs still ask, and the prompt's answer decides which of these apply.
        if (!batch) return;
        const backendAnswers: readonly (readonly [AnswerKey, string | undefined])[] = [
            ["embedding.baseURL", embedding?.baseURL],
            ["embedding.model", embedding?.model],
            ["embedding.gguf", embedding?.gguf],
        ];
        for (const [key, answered] of backendAnswers) {
            if (answered !== undefined) {
                problems.push(
                    `${answerSpelling(key)} needs an embedding backend answer in a non-interactive run — add ${answerSpelling("embedding.mode")}, or drop it.`,
                );
            }
        }
        return;
    }
    if (embedding?.gguf !== undefined && mode !== "local") {
        problems.push(`${answerSpelling("embedding.gguf")} answers a local embedding model, but ${answerSpelling("embedding.mode")} resolves to ${mode}.`);
    }
    if (embedding?.baseURL !== undefined && mode !== "api-key") {
        problems.push(
            `${answerSpelling("embedding.baseURL")} answers an api-key embedding endpoint, but ${answerSpelling("embedding.mode")} resolves to ${mode}.`,
        );
    }
    if (embedding?.model !== undefined && mode !== "api-key") {
        problems.push(
            `${answerSpelling("embedding.model")} answers an api-key embedding endpoint, but ${answerSpelling("embedding.mode")} resolves to ${mode}.`,
        );
    }
    // The secret has exactly one channel — no flag, no file key — so batch must prove it is present before
    // provisioning anything; interactive runs still prompt for it (masked) in the embedding step.
    if (mode === "api-key" && batch && readKey() === undefined) {
        problems.push(
            `api-key embeddings need the ${EMBEDDING_API_KEY_VAR} environment variable — secrets never ride a flag or the answers file. Export it and re-run.`,
        );
    }
}

/**
 * Merge the two front-ends per question (flag wins), then validate the WHOLE set — the fail-before-mutate
 * gate. Nothing here prompts, reads config, or writes: it classifies each question as answered, still-open,
 * or contradictory, so `setup` can refuse a bad answer set before the first container command.
 *
 * The error carries EVERY problem found, each naming both spellings, because a fleet author editing one
 * file wants the full list in one run.
 */
export function resolveSetupAnswers(
    flags: SetupAnswers,
    file: SetupAnswers | undefined,
    context: SetupAnswersContext,
): Result<ResolvedSetupAnswers, SetupAnswersError> {
    const answers = mergeAnswers(file ?? {}, flags);
    const batch = context.batch;
    // Batch resolves the connection default up front (cliproxy) so every mode-keyed rule below has a mode
    // to check against; an interactive run leaves it open for the wizard's first prompt.
    const connectionMode = answers.connection?.mode ?? (batch ? "cliproxy" : undefined);

    const problems: string[] = [];
    validateConnection(answers, connectionMode, batch, problems);

    const port = answers.postgres?.port;
    // The wizard warns and uses a reserved port for the current run without persisting it. That is
    // acceptable with a human watching and poison in automation, where "the value you passed was silently
    // not persisted" is invisible — so batch refuses it instead.
    if (batch && port !== undefined && isReservedPostgresPort(port)) {
        problems.push(
            `${answerSpelling("postgres.port")} ${port} is a reserved channel default (${reservedPostgresPorts.join(", ")}) that setup never persists — one channel's stack would collide with the other's. Pick another port.`,
        );
    }

    // The preset words are reserved: inside an id list they would read as catalog ids, so a run asking for
    // `--refs recommended,foo` is ambiguous rather than additive. Whether the remaining ids exist is the
    // refs module's question — it owns the catalog; this layer never loads it.
    if (Array.isArray(answers.refs)) {
        // Reserved by the same case-insensitive reading that makes `--refs ALL` the preset, and reported in
        // the author's own spelling: a word recognized as vocabulary in one position cannot be an ordinary
        // id in the other, or the rule has a case-shaped hole that surfaces as an unknown-dataset error.
        const reserved = answers.refs.filter((id) => refsPresetOf(id) !== undefined);
        if (reserved.length > 0) {
            problems.push(
                `${answerSpelling("refs")} — ${reserved.join(", ")} ${reserved.length === 1 ? "is a reserved preset word" : "are reserved preset words"}; pass one alone (\`--refs recommended\`) rather than inside a list of dataset ids.`,
            );
        }
    }

    validateEmbedding(answers, batch, context.embeddingApiKey ?? resolveEmbeddingApiKey, problems);

    if (problems.length > 0) return err({ type: "answers_invalid", path: undefined, problems });
    return ok({ answers, batch, connectionMode });
}

/**
 * The orchestrator's one call: read the `--config` file when one was named, map the flags, merge, and
 * validate — in that order, so the first failure reported is the one closest to what the author typed.
 * Everything a caller needs to fail the run lives on the returned error ({@link describeSetupAnswersError}).
 */
export function loadSetupAnswers(flags: SetupAnswerFlags, context: SetupAnswersContext): Result<ResolvedSetupAnswers, SetupAnswersError> {
    // Annotated so both branches meet at ONE Result type — a `Result<undefined, never> | Result<SetupAnswers, …>`
    // union has no callable `.andThen`.
    const file: Result<SetupAnswers | undefined, SetupAnswersError> = flags.config === undefined ? ok(undefined) : readAnswersFile(flags.config);
    return file.andThen((fileAnswers) => answersFromFlags(flags).andThen((flagAnswers) => resolveSetupAnswers(flagAnswers, fileAnswers, context)));
}
