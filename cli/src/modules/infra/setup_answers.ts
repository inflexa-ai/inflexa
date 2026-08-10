import { readFileSync } from "node:fs";
import { Result, ok, err } from "neverthrow";
import { z } from "zod";

import { runtimeIds } from "../../lib/container.ts";
import { EMBEDDING_API_KEY_VAR, isReservedPostgresPort, reservedPostgresPorts, resolveEmbeddingApiKey } from "../../lib/env.ts";
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
//   - NO ANSWER IS EVER SILENTLY IGNORED — in interactive runs as much as batch ones. An answer the
//     resolved modes cannot consume (a direct-only `--base-url` under cliproxy, an `--embeddings-gguf` with
//     api-key embeddings) is an ERROR, not a no-op, and so is an answer whose consuming MODE is unanswered:
//     an unresolved mode is not a promise that a prompt will resolve the way the answer needs. Silently
//     dropping either is how a fleet ends up misconfigured with a green setup run. The ONE override that is
//     not an error is announced instead: a mode-carrying FLAG supersedes the FILE's leaves that only the
//     mode it replaced could consume, and every dropped key is named in `ResolvedSetupAnswers.notes`.
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

/**
 * Whether `value` has the shape of a direct-mode vendor slug. Exported because the orchestrator must
 * re-ask this question on the ONE path this module cannot judge: an interactive run whose mode is
 * decided by a prompt, after the resolver has already returned. Sharing the predicate keeps the
 * vocabulary defined once — a second regex there would drift the moment either is widened.
 */
export function isVendorSlug(value: string): boolean {
    return VENDOR_SLUG.test(value);
}

const authSchemeSchema = z.enum(["x-api-key", "bearer"]);

/**
 * A free-text answer, trimmed. Surrounding whitespace is never meaningful in a value this CLI compares,
 * splices into a URL, or writes to config.json, and both front-ends pick it up by accident — a shell that
 * quotes an argument with a trailing space, a YAML value indented for readability. Normalizing on the
 * SCHEMA is what makes flag and file identical: every answer, from either front-end, meets
 * {@link setupAnswersSchema} exactly once.
 *
 * Emptiness is checked AFTER the trim, so an all-whitespace answer is reported as the empty answer it is
 * rather than accepted as a one-space value nothing downstream can use.
 */
function trimmedAnswer(error: string): z.ZodString {
    return z.string().trim().min(1, { error });
}

/**
 * The sandbox image variants this CLI retired, refused by name in the one up-front validation pass.
 *
 * They are literals here rather than an import, because nothing in the CLI publishes or resolves them any
 * more. Their only remaining role is this refusal, which exists so a file or a flag written against the
 * old surface names the reason it stopped working instead of provisioning something else.
 */
const RETIRED_SANDBOX_VARIANTS = ["python", "python-r"] as const;

/** Whether `value` names a sandbox image variant this CLI retired. */
export function isRetiredSandboxVariant(value: string): boolean {
    // The cast widens the readonly tuple to `readonly string[]` so `.includes` accepts an arbitrary
    // string; type-level only, the comparison is unchanged at runtime.
    return (RETIRED_SANDBOX_VARIANTS as readonly string[]).includes(value);
}

/**
 * The reason a `sandbox` answer that names a retired variant is refused — the tail of the problem line,
 * with the question's spelling prepended by the caller. The schema (the file front-end) and the setup
 * registry (the flag front-end, where the bare `--sandbox` flag turns a variant name into a positional)
 * share one wording, so the two surfaces refuse in the same words.
 */
export const RETIRED_SANDBOX_MESSAGE =
    "names a retired image variant. One sandbox image is published, so the answer takes no image name — the package set comes from the store, which `inflexa store add` extends";

/**
 * A URL answer: a {@link trimmedAnswer} that must also parse AS a URL — which is to say WITH a scheme,
 * because the WHATWG parser is given no base to resolve against. `gw.corp/v1`, the shape a hand-written
 * file most often carries, fails here rather than at the first model request.
 *
 * The interactive prompts have always enforced this; the refinement is what makes the flag and file legs
 * agree with them, so one question has one validity rule whichever front-end answers it (design D7).
 */
function urlAnswer(): z.ZodString {
    return trimmedAnswer("must not be empty").refine(
        // Emptiness is the trim check's problem and is already reported by it; re-reporting it as a URL
        // problem would be two messages for one mistake.
        (value) => value === "" || URL.canParse(value),
        { error: "must be a URL with a scheme, e.g. https://gw.corp/v1" },
    );
}

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
        var: trimmedAnswer("must name an environment variable"),
        scheme: authSchemeSchema,
    }),
    z.strictObject({
        kind: z.literal("command"),
        command: trimmedAnswer("must name a command"),
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
            /**
             * Case-FOLDED as well as trimmed, because every consumer of a provider answer compares it
             * exact-lowercase — the vendor slug shape, the OAuth account kinds, the protocol implication, the
             * conventional model and api-key variable lookups. `--provider Anthropic` is the same instruction
             * as `--provider anthropic`, and an unfolded answer would silently miss every one of those tables
             * instead of failing.
             */
            provider: z.string().trim().toLowerCase().min(1, { error: "must not be empty" }).optional(),
            baseURL: urlAnswer().optional(),
            protocol: z.enum(["anthropic", "openai-compatible"]).optional(),
            model: trimmedAnswer("must not be empty").optional(),
            auth: setupAuthAnswerSchema.optional(),
        })
        .optional(),
    /** The harness substrate's connection fields; unanswered fields keep their per-field defaults and persist nothing. */
    postgres: z
        .strictObject({
            user: trimmedAnswer("must not be empty").optional(),
            /**
             * The ONE free-text answer that is not trimmed: a password's leading or trailing whitespace is a
             * character of the secret, and silently stripping it would provision a Postgres the operator's own
             * credential no longer opens.
             */
            password: z.string().min(1, { error: "must not be empty" }).optional(),
            port: z
                .number()
                .int()
                .min(1, { error: "must be a port between 1 and 65535" })
                .max(65535, { error: "must be a port between 1 and 65535" })
                .optional(),
            database: trimmedAnswer("must not be empty").optional(),
            host: trimmedAnswer("must not be empty").optional(),
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
            baseURL: urlAnswer().optional(),
            model: trimmedAnswer("must not be empty").optional(),
            gguf: trimmedAnswer("must not be empty").optional(),
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
    /**
     * Whether setup pulls the container images and downloads the package catalog. The answer IS the
     * multi-GB consent, and its PRESENCE is the whole of it: one runtime image is published and the
     * provisioner has no variant, so the answer selects nothing and no consumer reads a value. The file
     * spells the answer `sandbox: true`, and the flag is the bare `--sandbox`, thus `true` is the one value
     * the schema accepts.
     *
     * A retired variant name is refused rather than ignored. A user upgrading from the variant surface
     * writes `sandbox: python-r` out of habit, and silently reading that as "pull the one image" would hide
     * from them that the image they asked for no longer exists. The bare flag turns `--sandbox python-r`
     * into a positional, which the setup registry refuses in the same words.
     */
    sandbox: z
        .literal(true, {
            // unknown in: the raw answer from either front-end. A retired variant name earns the specific
            // refusal, and any other non-`true` value earns the presence-only message.
            error: (issue) =>
                typeof issue.input === "string" && isRetiredSandboxVariant(issue.input)
                    ? RETIRED_SANDBOX_MESSAGE
                    : "takes no value — its presence is the whole consent, so write `sandbox: true`",
        })
        .optional(),
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

// --- one table of questions -------------------------------------------------

/**
 * The BLOCKS of the answers document — the top-level keys whose value is a mapping of further questions,
 * as opposed to the top-level leaves (`refs`, `sandbox`, `runtime`) that carry a value of their own.
 *
 * Derived from the schema rather than listed, so a new block joins by its schema declaration alone. The
 * array guard is what keeps `refs` out: a sequence is a VALUE, not a mapping of questions.
 */
type AnswerBlock = {
    [K in keyof SetupAnswers]-?: NonNullable<SetupAnswers[K]> extends readonly unknown[] ? never : NonNullable<SetupAnswers[K]> extends object ? K : never;
}[keyof SetupAnswers];

/** A top-level answer that is a value in its own right — everything the document holds that is not a block. */
type AnswerTopLeaf = Exclude<keyof SetupAnswers, AnswerBlock>;

/** The leaf names one block owns. */
type LeafOf<B extends AnswerBlock> = Extract<keyof NonNullable<SetupAnswers[B]>, string>;

/** Every key of every member of a union — plain `keyof` would yield only the keys the members share. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * The key paths the SCHEMA owns: the blocks, each block's leaves, and the top-level leaves. The question
 * table below must cover this set exactly, which is the compile-time link that makes an answer added to the
 * schema alone a BUILD error rather than a value that parses and is then never spelled, merged, or consumed.
 */
type SchemaAnswerKey = AnswerBlock | AnswerTopLeaf | { [B in AnswerBlock]: `${B}.${LeafOf<B>}` }[AnswerBlock];

/**
 * The fields INSIDE the credential-source answer. They are not schema leaves — `connection.auth` is one
 * question whose interior is a discriminated union — but each is spellable, because a zod issue can land on
 * one and the author needs to know which flag writes it. Derived from the auth schema for the same reason
 * the block leaves are: a field added there must not become an unspellable path.
 */
type AuthFieldKey = `connection.auth.${Extract<KeysOfUnion<SetupAuthAnswer>, string>}`;

/**
 * Where a question's value sits in an answer set — everything {@link mergeAnswers} needs to move it from a
 * front-end into the merged set, and nothing more.
 */
type AnswerLocation =
    /** The block itself: a container. Spellable (a block-shaped file error names it), never a value. */
    | { readonly at: "block" }
    /** A leaf under a block — the merge unit `block.leaf`. */
    | { readonly at: "leaf"; readonly block: AnswerBlock; readonly leaf: string }
    /** A top-level leaf; its own merge unit. */
    | { readonly at: "top"; readonly leaf: AnswerTopLeaf }
    /** A field inside another answer (the credential source's interior) — spellable, never merged on its own. */
    | { readonly at: "within" };

/**
 * The table entry a given key must carry: its flag spelling, plus the {@link AnswerLocation} the key itself
 * implies. A `postgres.port` entry can therefore only say `block: "postgres", leaf: "port"` — mistyping
 * either is a compile error, which is what lets {@link mergeAnswers} trust the table instead of re-deriving
 * the paths beside it.
 */
type AnswerQuestion<K extends string> = { readonly flag: string | null } & (K extends `${infer B}.${infer L}`
    ? B extends AnswerBlock
        ? L extends LeafOf<B>
            ? Extract<AnswerLocation, { at: "leaf" }> & { readonly block: B; readonly leaf: L }
            : Extract<AnswerLocation, { at: "within" }>
        : never
    : K extends AnswerBlock
      ? Extract<AnswerLocation, { at: "block" }>
      : Extract<AnswerLocation, { at: "top" }> & { readonly leaf: K });

/**
 * EVERY answerable question, declared ONCE: its config-file key path (this module's canonical id) → the
 * flag that answers it and where its value lives. Four surfaces read this one table — {@link answerSpelling}
 * renders both spellings from it, {@link mergeAnswers} walks it to merge flag-over-file per leaf, the
 * orchestrator's answer-coverage guard re-derives the key set from this declaration, and the `satisfies`
 * below ties it to the schema's leaf set — so an answer can no longer ship parsed-but-dropped or unspelled
 * because someone updated three places out of four (design D3).
 *
 * `flag` is `null` for a question with no flag at all (a value too niche for argv, answerable only in a
 * file). A BLOCK is not answerable by one flag — its flags are a family — so its entry names that family
 * rather than a single switch: enough for an author staring at a mis-shaped `postgres:` to know which flags
 * fill it, without pasting nine flags into one error line.
 */
const ANSWER_QUESTIONS = {
    connection: { flag: "--connection / --provider / --base-url / …", at: "block" },
    "connection.mode": { flag: "--connection", at: "leaf", block: "connection", leaf: "mode" },
    "connection.provider": { flag: "--provider", at: "leaf", block: "connection", leaf: "provider" },
    "connection.baseURL": { flag: "--base-url", at: "leaf", block: "connection", leaf: "baseURL" },
    "connection.protocol": { flag: "--protocol", at: "leaf", block: "connection", leaf: "protocol" },
    "connection.model": { flag: "--model", at: "leaf", block: "connection", leaf: "model" },
    "connection.auth": { flag: "--auth-env / --auth-command", at: "leaf", block: "connection", leaf: "auth" },
    "connection.auth.kind": { flag: "--auth-env / --auth-command", at: "within" },
    "connection.auth.var": { flag: "--auth-env", at: "within" },
    "connection.auth.command": { flag: "--auth-command", at: "within" },
    "connection.auth.scheme": { flag: "--auth-scheme", at: "within" },
    "connection.auth.format": { flag: "--auth-format", at: "within" },
    "connection.auth.ttlMs": { flag: null, at: "within" },
    postgres: { flag: "--postgres-*", at: "block" },
    "postgres.user": { flag: "--postgres-user", at: "leaf", block: "postgres", leaf: "user" },
    "postgres.password": { flag: "--postgres-password", at: "leaf", block: "postgres", leaf: "password" },
    "postgres.port": { flag: "--postgres-port", at: "leaf", block: "postgres", leaf: "port" },
    "postgres.database": { flag: "--postgres-database", at: "leaf", block: "postgres", leaf: "database" },
    "postgres.host": { flag: "--postgres-host", at: "leaf", block: "postgres", leaf: "host" },
    resources: { flag: "--resource-share", at: "block" },
    "resources.sharePct": { flag: "--resource-share", at: "leaf", block: "resources", leaf: "sharePct" },
    embedding: { flag: "--embeddings / --embeddings-*", at: "block" },
    "embedding.mode": { flag: "--embeddings", at: "leaf", block: "embedding", leaf: "mode" },
    "embedding.baseURL": { flag: "--embeddings-url", at: "leaf", block: "embedding", leaf: "baseURL" },
    "embedding.model": { flag: "--embeddings-model", at: "leaf", block: "embedding", leaf: "model" },
    "embedding.gguf": { flag: "--embeddings-gguf", at: "leaf", block: "embedding", leaf: "gguf" },
    refs: { flag: "--refs", at: "top", leaf: "refs" },
    sandbox: { flag: "--sandbox", at: "top", leaf: "sandbox" },
    runtime: { flag: "--runtime", at: "top", leaf: "runtime" },
} as const satisfies { readonly [K in SchemaAnswerKey | AuthFieldKey]: AnswerQuestion<K> };

/** A setup question, named by its config-file key path (the key `--config` files use, and this module's canonical id). */
export type AnswerKey = keyof typeof ANSWER_QUESTIONS;

/**
 * A question that carries a VALUE — every {@link AnswerKey} except the block containers, which are
 * spellable (a block-shaped file error names them) but hold answers rather than being one.
 *
 * Exported for the orchestrator's answer-coverage guard, which asserts that each answer reaches a
 * destination: a block has no destination of its own to reach, so keying that guard on the whole
 * {@link AnswerKey} set would demand a case that cannot exist.
 */
export type AnswerValueKey = Exclude<AnswerKey, AnswerBlock>;

/**
 * Name a question in both spellings — ``` `--base-url` / `connection.baseURL` ``` — the opening of every
 * error this module reports. A file-only question renders as its key plus the reason it has no flag.
 */
export function answerSpelling(key: AnswerKey): string {
    const flag = ANSWER_QUESTIONS[key].flag;
    return flag === null ? `\`${key}\` (config file only)` : `\`${flag}\` / \`${key}\``;
}

function isAnswerKey(key: string): key is AnswerKey {
    return Object.hasOwn(ANSWER_QUESTIONS, key);
}

/** `Object.keys` for an `as const` table: the stdlib signature widens to `string[]`, losing what the declaration proves. */
function keysOf<T extends object>(table: T): (keyof T & string)[] {
    // Sound because every key of a `const`-asserted object literal IS one of its literal key types; the
    // widening TypeScript applies here is a limitation of the signature, not a real loss of knowledge.
    return Object.keys(table) as (keyof T & string)[];
}

/** A block whose `mode` leaf decides which of its OTHER leaves are answerable at all. */
type ModeGatedBlock = Extract<AnswerBlock, "connection" | "embedding">;

/** The mode vocabulary of one mode-gated block. */
type ModeOf<B extends ModeGatedBlock> = NonNullable<NonNullable<SetupAnswers[B]>["mode"]>;

/**
 * Which leaves each mode-carrying block gates, and the ONE mode that can consume each. Two rules read it
 * and must never disagree: the mismatch errors below (an answer no resolved mode can consume is an ERROR,
 * never a no-op) and the supersede drop {@link mergeAnswers} performs when a mode-carrying FLAG moves a
 * block away from the mode the FILE's leaves were written for.
 *
 * `connection.provider` and `connection.model` are deliberately absent: both are valid in either mode
 * (cliproxy names an OAuth account kind and pins a model too), so neither is gated by the mode.
 */
const MODE_GATED_LEAVES = {
    connection: { baseURL: "direct", protocol: "direct", auth: "direct" },
    embedding: { gguf: "local", baseURL: "api-key", model: "api-key" },
} as const satisfies { readonly [B in ModeGatedBlock]: Readonly<Partial<Record<LeafOf<B>, ModeOf<B>>>> };

/** The mode-gated blocks, in the order their supersede notes are reported. */
const MODE_GATED_BLOCKS = keysOf(MODE_GATED_LEAVES);

/** A plain decimal integer, optionally signed — the ONLY numeric literal shape either front-end accepts. */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * How a problem at the DOCUMENT root is named. An empty issue path — the whole file is a scalar, or the
 * ARRAY `Bun.YAML.parse` returns for a multi-document file (a stray trailing `---` is enough) — has no key
 * to quote, and an empty locator renders the problem as a dangling dash with no subject at all.
 */
const DOCUMENT_LOCATOR = "the answers document itself";

/**
 * Name whatever a zod issue points at, in both spellings wherever a spelling exists: the question itself,
 * else its nearest mapped ancestor, else the raw path.
 *
 * The ancestor fallback is what keeps an ARRAY ELEMENT reportable — `refs.0` can never be an answer key of
 * its own, so without it the one question the author can actually edit (`--refs` / `refs`) goes unnamed.
 * The raw path rides along so a long list still says which element.
 */
function spellPath(path: readonly PropertyKey[]): string {
    if (path.length === 0) return DOCUMENT_LOCATOR;
    const key = path.join(".");
    if (isAnswerKey(key)) return answerSpelling(key);
    for (let depth = path.length - 1; depth > 0; depth--) {
        const ancestor = path.slice(0, depth).join(".");
        if (isAnswerKey(ancestor)) return `${answerSpelling(ancestor)} (at \`${key}\`)`;
    }
    return `\`${key}\``;
}

/**
 * The execution modifiers, in the file spelling a mistaken author would reach for. They answer "how should
 * THIS run behave", never "what should this client look like", so they are absent from the schema by
 * construction — and an unknown TOP-LEVEL key matching one of them earns the extra sentence explaining
 * where the answer really lives. A `no-` prefix is folded away so `--no-start`'s file spelling lands here too.
 */
const EXECUTION_MODIFIERS: ReadonlySet<string> = new Set(["start", "force", "postgres", "validate", "yes", "auth"]);

function isExecutionModifier(key: string): boolean {
    return EXECUTION_MODIFIERS.has(key.startsWith("no-") ? key.slice("no-".length) : key);
}

// The zod issue shape, derived from the schema rather than imported by name so it cannot drift with zod's
// type-export layout (the modules/harness/plan_intake.ts precedent).
type AnswersIssue = ReturnType<typeof setupAnswersSchema.safeParse> extends { error?: infer E } ? (E extends { issues: (infer I)[] } ? I : never) : never;

/** One zod issue → the problem lines it means, each naming the offending question in both spellings. */
function describeIssue(issue: AnswersIssue): string[] {
    if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => {
            // The modifier sentence only fits a top-level key that names one: appended to a nested typo
            // (`postgres.prot`, `connection.auth.ttlMs`) it is advice about a different question entirely,
            // and it contradicts the file-only questions this module documents as `(config file only)`.
            const modifier =
                issue.path.length === 0 && isExecutionModifier(key)
                    ? " How a run behaves (start, force, postgres, validate, yes, auth) is answered by flags only, never by the file."
                    : "";
            return `Unknown key \`${[...issue.path, key].join(".")}\` — not a setup answer.${modifier}`;
        });
    }
    return [`${spellPath(issue.path)} — ${issue.message}`];
}

/** An unknown thrown value's message, for the file-boundary errors — `String` covers the non-Error throws a runtime boundary can produce. */
function causeMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The problem lines inside an error, for the places that CONCATENATE two error's lists into one report.
 *
 * The file-boundary branch exists for totality over {@link SetupAnswersError}, not because a boundary error
 * ever reaches a fold — an unreadable or unparseable file is terminal and returns on its own.
 */
function problemsIn(error: SetupAnswersError): readonly string[] {
    return error.type === "answers_invalid" ? error.problems : [describeSetupAnswersError(error)];
}

function parseAnswers(document: unknown, path: string | undefined): Result<SetupAnswers, SetupAnswersError> {
    const parsed = setupAnswersSchema.safeParse(document);
    if (parsed.success) return ok(parsed.data);
    return err({ type: "answers_invalid", path, problems: parsed.error.issues.flatMap(describeIssue) });
}

// --- the file front-end ----------------------------------------------------

/** The one message for every shape of "this file answers nothing", so the three detections read as one rule. */
const EMPTY_FILE_PROBLEM = "the file is empty — it must be a YAML mapping of setup answers (e.g. `connection:`, `postgres:`, `refs:`).";

/**
 * Whether an answer set answers no QUESTION, which is what {@link EMPTY_FILE_PROBLEM} reports.
 *
 * A block is a CONTAINER, not an answer: `connection: {}` parses to a present block holding nothing, so a
 * presence test on the top level alone reads it as answered and provisions every default in silence —
 * exactly the outcome the explicit-`{}` check exists to prevent, one nesting level down. So a block counts
 * only for the leaves inside it.
 *
 * `refs` is the one answer that is itself a container without being a block; its schema already rejects an
 * empty list, so an array reaching here always names something and is counted whole.
 */
function answersNothing(answers: SetupAnswers): boolean {
    return Object.values(answers).every((answer) => {
        if (answer === undefined) return true;
        if (typeof answer !== "object" || Array.isArray(answer)) return false;
        return Object.values(answer).every((leaf) => leaf === undefined);
    });
}

/** A block mapping entry: a key, then `:` followed by whitespace or the end of the line (YAML's own rule). */
const BLOCK_MAPPING_ENTRY = /^([^\s#][^:]*?)\s*:(\s.*)?$/;

/** A block scalar header (`|`, `>`, with optional chomping/indent indicators and a trailing comment). */
const BLOCK_SCALAR_HEADER = /^[|>][+-]?\d*[+-]?\s*(#.*)?$/;

/** One mapping level of {@link duplicateMappingKeys}: the indent its keys sit at, plus how to name them. */
type MappingLevel = {
    readonly indent: number;
    /** The key path of the mapping itself, so a duplicate is reported as `embedding.mode`, not `mode`. */
    readonly path: readonly string[];
    readonly keys: Set<string>;
    /** The most recent key seen here — the parent name a deeper level takes when it opens. */
    lastKey: string;
};

/** What the RAW-text scan finds — the two things the parsed document can no longer show. */
type RawAnswerScan = {
    /** Full key paths answered twice, in the order they occur. */
    readonly duplicates: readonly string[];
    /** Full key path → the raw scalar text the author wrote after it, for every mapping entry that had one. */
    readonly scalars: ReadonlyMap<string, string>;
};

/** A trailing YAML comment on a value line: `#` starts one only when whitespace precedes it. */
const TRAILING_COMMENT = /\s+#.*$/;

/** A one-line flow mapping (`postgres: {port: 8080}`) — a block written inline. */
const FLOW_MAPPING = /^\{(.*)\}$/;

/** Record one mapping entry's raw value under its full key path, descending ONE level into a flow mapping. */
function recordScalar(scalars: Map<string, string>, path: string, raw: string): void {
    const value = raw.replace(TRAILING_COMMENT, "");
    const flow = FLOW_MAPPING.exec(value);
    if (flow === null) {
        if (value !== "") scalars.set(path, value);
        return;
    }
    // The single level is what makes a block written inline (`postgres: {port: 0x1F5B}`) readable to the
    // numeric check below; descending further would be a hand-rolled YAML parser in all but name, and every
    // value this map is consulted for is a scalar leaf sitting directly under a block.
    for (const field of flow[1]!.split(",")) {
        const at = field.indexOf(":");
        if (at === -1) continue;
        scalars.set(`${path}.${field.slice(0, at).trim()}`, field.slice(at + 1).trim());
    }
}

/**
 * Scan the RAW file text for what the parsed document cannot report: mapping keys answered twice, and the
 * literal each value was written as.
 *
 * Both exist because `Bun.YAML.parse` has already resolved the evidence away by the time any of this
 * module's code sees a value. Duplicates go last-wins (`runtime: docker` + `runtime: podman` parses to
 * `{runtime: "podman"}`), so a fleet file with two `embedding:` blocks silently loses the first — precisely
 * the failure strict parsing exists to prevent. And a numeric literal is already a number (`0x1F5B` is
 * 8027), so the file would accept a port shape the flag front-end rejects. The raw text is the only place
 * either fact survives.
 *
 * It is a LINE SCAN, not a YAML parser, and the honest statement of what that buys is the list of what it
 * does NOT see:
 *
 * - **Flow mappings, beyond one level.** `embedding: {mode: local, mode: off}` is one line with one key to
 *   the duplicate half of the scan; the inner duplicate is invisible. The scalar half descends exactly one
 *   level (see {@link recordScalar}), which is as deep as any numeric answer sits.
 * - **Block-sequence items.** A `- ` line, and everything indented under it, is skipped entirely — the
 *   answers schema's only list is `refs` (a list of scalars), so descending would add parser complexity for
 *   no reachable duplicate.
 * - **Keys containing `:`.** A quoted key (`"a:b": 1`) does not match the entry pattern and is skipped.
 * - **Quoted scalars spanning lines.** Block scalars (`|`/`>`) are skipped by header, but a plain or quoted
 *   multi-line value whose continuation lines happen to read as `key: value` IS scanned — twice-repeated
 *   prose of that exact shape would be a false positive. Nothing in the answers schema takes a multi-line
 *   value, which is what makes that trade acceptable rather than merely unlikely.
 */
function scanAnswersText(text: string): RawAnswerScan {
    const duplicates: string[] = [];
    const scalars = new Map<string, string>();
    const levels: MappingLevel[] = [];
    let blockScalarIndent: number | undefined;
    let sequenceIndent: number | undefined;

    for (const line of text.split("\n")) {
        const content = line.trim();
        const indent = line.length - line.trimStart().length;
        // A block scalar's body is text, not structure: everything indented past its key is content.
        if (blockScalarIndent !== undefined) {
            if (content === "" || indent > blockScalarIndent) continue;
            blockScalarIndent = undefined;
        }
        if (content === "" || content.startsWith("#")) continue;
        if (sequenceIndent !== undefined) {
            if (indent >= sequenceIndent) continue;
            sequenceIndent = undefined;
        }
        // A document boundary restarts every mapping level: the same key in two documents is not a duplicate.
        if (content === "---" || content === "..." || content.startsWith("--- ")) {
            levels.length = 0;
            continue;
        }
        if (content === "-" || content.startsWith("- ")) {
            sequenceIndent = indent;
            continue;
        }
        const entry = BLOCK_MAPPING_ENTRY.exec(content);
        if (entry === null) continue;
        const key = entry[1];
        if (key === undefined) continue;
        // `-1` is below every real indent, so an exhausted stack ends the loop without a separate length test.
        while ((levels[levels.length - 1]?.indent ?? -1) > indent) levels.pop();
        const level = levels[levels.length - 1];
        if (level === undefined || level.indent < indent) {
            levels.push({ indent, path: level === undefined ? [] : [...level.path, level.lastKey], keys: new Set([key]), lastKey: key });
        } else {
            if (level.keys.has(key)) duplicates.push([...level.path, key].join("."));
            level.keys.add(key);
            level.lastKey = key;
        }
        // Non-null: the branch above either pushed a level or found one, so the stack is never empty here.
        const path = [...levels[levels.length - 1]!.path, key].join(".");
        const value = (entry[2] ?? "").trim();
        if (BLOCK_SCALAR_HEADER.test(value)) blockScalarIndent = indent;
        else recordScalar(scalars, path, value);
    }
    return { duplicates, scalars };
}

/**
 * The answers whose value is a NUMBER, and whose literal shape the file must therefore state as plainly as
 * the flag does.
 */
const NUMERIC_ANSWER_KEYS = ["postgres.port", "resources.sharePct", "connection.auth.ttlMs"] as const satisfies readonly AnswerKey[];

/** Walk a dotted key path into the parsed document. Anything the path cannot be followed through is absent. */
function answerAt(document: unknown, key: string): unknown {
    let node: unknown = document;
    for (const segment of key.split(".")) {
        if (typeof node !== "object" || node === null) return undefined;
        // unknown in, unknown out: the document is unvalidated YAML, and an indexed read is the only way
        // into it. Nothing downstream treats the result as a checked value — the only question asked of it
        // below is `typeof === "number"`.
        node = (node as Record<string, unknown>)[segment];
    }
    return node;
}

/**
 * Reject a numeric answer whose raw literal is not a plain decimal integer, naming both spellings and the
 * text the author actually wrote — the same rule, and the same message, {@link wholeNumber} enforces on the
 * flag side. `Bun.YAML.parse` resolves `0x1F5B` to 8027 and `1e2` to 100 before zod can see either, so this
 * parity cannot live in the schema (design D4).
 *
 * Gated on the PARSED value already being a number, which keeps the check to exactly the hole it exists
 * for: a literal YAML turned into a number the author did not write. Anything else — a quoted `'5555'`, a
 * bare `abc` — is a plain type error the schema reports in the author's own terms, and reporting it here
 * too would be two messages for one mistake.
 */
function nonDecimalNumericProblems(scan: RawAnswerScan, document: unknown): string[] {
    const problems: string[] = [];
    for (const key of NUMERIC_ANSWER_KEYS) {
        const raw = scan.scalars.get(key);
        if (raw === undefined || DECIMAL_INTEGER.test(raw)) continue;
        if (typeof answerAt(document, key) !== "number") continue;
        problems.push(`${answerSpelling(key)} — must be a whole number (got "${raw}").`);
    }
    return problems;
}

/**
 * Load and strict-parse a `--config <file.yml>` answers file. Every failure mode names the path: an
 * unreadable file, a YAML syntax error, a key answered twice, and each schema violation (unknown keys
 * included) are all reported here — BEFORE any mutation — because a file is authored intent, and the worst
 * failure a fleet can have is a mistyped key that silently skips a step.
 *
 * Parsed with the runtime's native YAML (`Bun.YAML.parse`, Bun 1.3+), so the answers file costs no
 * dependency. Three things the parsed value cannot tell us are therefore checked around it: duplicate keys,
 * which YAML resolves last-wins before the value exists, numeric literals YAML has already normalized away
 * (both from {@link scanAnswersText}), and emptiness — a file that answers nothing is a broken deploy, not
 * an intent worth honoring silently, whether it spells that as no document at all or as an empty `{}`
 * mapping.
 */
export function readAnswersFile(path: string): Result<SetupAnswers, SetupAnswersError> {
    function invalid(problems: readonly string[]): Result<SetupAnswers, SetupAnswersError> {
        return err({ type: "answers_invalid", path, problems });
    }
    return Result.fromThrowable(
        () => readFileSync(path, "utf8"),
        (cause): SetupAnswersError => ({ type: "answers_file_unreadable", path, detail: causeMessage(cause) }),
    )()
        .andThen((text) =>
            Result.fromThrowable(
                // unknown: an on-disk YAML document, validated by the schema below.
                (): unknown => Bun.YAML.parse(text),
                (cause): SetupAnswersError => ({ type: "answers_file_unparseable", path, detail: causeMessage(cause) }),
            )().map((document) => ({ text, document })),
        )
        .andThen(({ text, document }) => {
            const scan = scanAnswersText(text);
            if (scan.duplicates.length > 0) {
                return invalid(
                    scan.duplicates.map(
                        (key) =>
                            `\`${key}\` is answered twice — YAML keeps only the LAST of two identical keys, so the earlier answer would be discarded without a word. Delete one.`,
                    ),
                );
            }
            // Bun.YAML.parse yields null for an empty (or comment-only) document; zod would report it as a
            // type error against the whole file, which reads as a schema problem rather than an empty file.
            if (document === null || document === undefined) return invalid([EMPTY_FILE_PROBLEM]);
            const numeric = nonDecimalNumericProblems(scan, document);
            const parsed = parseAnswers(document, path);
            // One pass over the file: a badly-shaped numeric literal and a schema violation elsewhere are
            // both things the author fixes in the same editor session, so both are reported together.
            if (parsed.isErr()) return invalid([...numeric, ...problemsIn(parsed.error)]);
            if (numeric.length > 0) return invalid(numeric);
            // A document that parses to `{}` — an explicit empty mapping, or blocks that are each empty —
            // answers nothing either, and provisioning every default off it is the same silent
            // misconfiguration an empty file is.
            return answersNothing(parsed.value) ? invalid([EMPTY_FILE_PROBLEM]) : ok(parsed.value);
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
    /** `--sandbox`: the bare presence flag whose consent pulls the container images. Commander hands over `true`, and it carries no value. */
    readonly sandbox?: boolean;
    /** `--runtime docker|podman`. */
    readonly runtime?: string;
};

/** Keep a block only when it actually answers something, so an absent block reads as "no answers here". */
function pruned<T extends Record<string, unknown>>(block: T): T | undefined {
    return Object.values(block).some((value) => value !== undefined) ? block : undefined;
}

/**
 * Read a numeric flag as the whole number its error message promises. The shape is matched BEFORE `Number`
 * rather than inferred from it, because `Number` also speaks JavaScript's other integer literals: it reads
 * `0x10` as 16 and `1e2` as 100, both `Number.isInteger`, so a `--postgres-port 0x10` would provision port
 * 16 while the author reads their file as naming 0x10. A value the CLI cannot echo back unchanged is a
 * value the author cannot verify, so it is an error instead. The file front-end holds the same line
 * ({@link nonDecimalNumericProblems}) — one question, one value grammar.
 */
function wholeNumber(raw: string | undefined, key: AnswerKey, problems: string[]): number | undefined {
    if (raw === undefined) return undefined;
    const text = raw.trim();
    if (!DECIMAL_INTEGER.test(text)) {
        problems.push(`${answerSpelling(key)} — must be a whole number (got "${raw}").`);
        return undefined;
    }
    return Number(text);
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
 *
 * ONE PASS (design D6): flag-level problems no longer short-circuit the schema. An author who mistyped a
 * port AND a sandbox variant is told about both in the same run, which is the same contract
 * {@link resolveSetupAnswers} holds within a single set.
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
    const parsed = parseAnswers(raw, undefined);
    if (problems.length === 0) return parsed;
    // A flag that could not even be turned into a candidate value (a non-numeric port, an incoherent
    // credential source) was DROPPED from `raw` above, so the schema never sees it and it cannot
    // double-report: its own message — which names the flag, not zod's view of a value we already know we
    // discarded — simply rides alongside whatever else the schema found.
    return err({ type: "answers_invalid", path: undefined, problems: [...problems, ...(parsed.isErr() ? problemsIn(parsed.error) : [])] });
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
    /**
     * Advisories the run must SHOW but that are not failures — today, the file leaves a mode-carrying flag
     * superseded (design D5).
     *
     * DATA, not output: this module never prints, which is what keeps it a pure function of its inputs, so
     * the ORCHESTRATOR owns rendering these exactly as it owns rendering {@link describeSetupAnswersError}.
     * An empty array is the normal case.
     */
    readonly notes: readonly string[];
};

/**
 * One leaf of one block, addressed by NAME. The generic merge cannot use the per-block object types (each
 * block owns a different leaf set), so the widening lives here, in one place: what makes it sound is
 * {@link ANSWER_QUESTIONS}'s `satisfies` link, which already proves every `block`/`leaf` pair handed over
 * is a real leaf of a real block.
 */
function leafOf(answers: SetupAnswers, block: AnswerBlock, leaf: string): unknown {
    return (answers[block] as Readonly<Record<string, unknown>> | undefined)?.[leaf];
}

/**
 * Merge the two front-ends one question at a time — the flag's answer when it has one, else the file's —
 * walking {@link ANSWER_QUESTIONS} so a new question joins the merge by its table entry alone.
 *
 * Per LEAF, so a file block survives a single overriding flag. The credential source is the apparent
 * exception that is really the rule: `connection.auth` is ONE leaf, because its fields are interlocked by
 * `kind`, so a flag-declared source replaces a file-declared one wholesale rather than merging across kinds.
 *
 * The one thing the table alone cannot express is the SUPERSEDE: when a mode-carrying flag moves a block to
 * a mode the file's leaves were not written for, those leaves are dropped here and named in
 * {@link ResolvedSetupAnswers.notes}. Both of this module's rules survive that only because the drop is
 * announced — "a flag overrides the file's answer for that question" and "no answer is silently ignored"
 * are simultaneously true only for an ANNOUNCED override. A same-source contradiction (a flag mode against
 * a flag leaf, a file mode against a file leaf) is untouched and still fails in validation: that is an
 * authoring mistake, not an override.
 */
function mergeAnswers(file: SetupAnswers, flags: SetupAnswers): { readonly answers: SetupAnswers; readonly notes: readonly string[] } {
    const notes: string[] = [];
    /** The `block.leaf` merge units a mode-carrying flag has made moot; they resolve to unanswered. */
    const superseded = new Set<string>();
    for (const block of MODE_GATED_BLOCKS) {
        const flagMode: string | undefined = flags[block]?.mode;
        if (flagMode === undefined) continue;
        const dropped: string[] = [];
        for (const leaf of keysOf(MODE_GATED_LEAVES[block])) {
            const consumer: string = MODE_GATED_LEAVES[block][leaf];
            if (consumer === flagMode) continue;
            // The flag answering the leaf TOO is a same-source contradiction, not an override: left in
            // place so validation reports it, exactly as an all-file mismatch is reported.
            if (leafOf(flags, block, leaf) !== undefined) continue;
            if (leafOf(file, block, leaf) === undefined) continue;
            superseded.add(`${block}.${leaf}`);
            dropped.push(`${block}.${leaf}`);
        }
        if (dropped.length > 0) {
            notes.push(
                `\`${ANSWER_QUESTIONS[`${block}.mode`].flag} ${flagMode}\` supersedes ${dropped.map((key) => `\`${key}\``).join(", ")} from the answers file — ` +
                    `those values answer a mode the flag replaced, so they are not applied on this machine.`,
            );
        }
    }

    const merged: Record<string, unknown> = {};
    const blocks = new Map<AnswerBlock, Record<string, unknown>>();
    for (const [key, question] of Object.entries(ANSWER_QUESTIONS)) {
        if (question.at === "leaf") {
            const leaves = blocks.get(question.block) ?? {};
            blocks.set(question.block, leaves);
            leaves[question.leaf] = superseded.has(key)
                ? undefined
                : (leafOf(flags, question.block, question.leaf) ?? leafOf(file, question.block, question.leaf));
        } else if (question.at === "top") {
            merged[question.leaf] = flags[question.leaf] ?? file[question.leaf];
        }
    }
    for (const [block, leaves] of blocks) merged[block] = pruned(leaves);

    // The loop writes exactly the keys the table declares, each with the value type its schema leaf owns —
    // a shape TypeScript cannot follow key-by-key out of a generic walk, but that the table's `satisfies`
    // link has already proven. Nothing else can reach this object, so the assertion cannot go stale
    // silently: a table entry naming a leaf the schema dropped is a compile error at the declaration.
    return { answers: merged as SetupAnswers, notes };
}

function isOAuthAccountKind(value: string): boolean {
    // The cast widens a readonly TUPLE of string literals to `readonly string[]` purely so `.includes`
    // accepts an arbitrary string — untouched, TS demands the argument already BE an OAuthAccountKind, which
    // is the very thing being tested. Type-level only: the array and the comparison are unchanged at runtime.
    return (OAUTH_ACCOUNT_KINDS as readonly string[]).includes(value);
}

/**
 * The connection questions only a DIRECT endpoint can consume, read off {@link MODE_GATED_LEAVES} so this
 * rule and the supersede drop can never disagree about which leaves those are. `provider` and `model` are
 * absent from that table for a reason worth repeating here: both are valid in either mode (cliproxy names
 * an OAuth account kind and pins a model too), so `--provider claude` on an interactive run must stay the
 * long-standing valid invocation it is.
 */
function directOnlyAnswers(connection: SetupAnswers["connection"]): readonly (readonly [AnswerKey, unknown])[] {
    return keysOf(MODE_GATED_LEAVES.connection).map((leaf) => [`connection.${leaf}`, connection?.[leaf]] as const);
}

/** Validate the connection questions against the mode they resolved to. */
function validateConnection(answers: SetupAnswers, mode: ConnectionMode | undefined, batch: boolean, problems: string[]): void {
    const connection = answers.connection;
    // Mode still unresolved: an interactive run whose first prompt decides it. The mode-keyed rules below
    // would be guessing — but a direct-only answer cannot wait for that prompt, because the prompt may well
    // resolve to cliproxy and then nothing consumes it. Demanding the mode is the only reading that keeps
    // the module's invariant true interactively: the answer is honored, or the author is told why not.
    if (mode === undefined) {
        for (const [key, answered] of directOnlyAnswers(connection)) {
            if (answered !== undefined) {
                problems.push(
                    `${answerSpelling(key)} answers a direct connection, but nothing answers ${answerSpelling("connection.mode")} — the prompt that decides it may still resolve to cliproxy, and then nothing consumes this. Pass \`--connection direct\` / \`connection.mode: direct\`, or drop the answer.`,
                );
            }
        }
        return;
    }

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
        if (connection?.provider !== undefined && !isVendorSlug(connection.provider)) {
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
        } else if (!isOAuthAccountKind(connection.provider)) {
            problems.push(`${answerSpelling("connection.provider")} — in cliproxy mode it is an OAuth account kind: ${OAUTH_ACCOUNT_KINDS.join(", ")}.`);
        }
    }
    for (const [key, answered] of directOnlyAnswers(connection)) {
        if (answered !== undefined) {
            problems.push(
                `${answerSpelling(key)} answers a direct connection, but the connection resolves to cliproxy — pass \`--connection direct\` / \`connection.mode: direct\`, or drop the answer.`,
            );
        }
    }
}

/** The embedding modes that actually CONSUME a value — `off` gates nothing, so it never needs a phrasing. */
type EmbeddingValueMode = (typeof MODE_GATED_LEAVES)["embedding"][keyof (typeof MODE_GATED_LEAVES)["embedding"]];

/**
 * How a mismatch error names an embedding VALUE: by the role it plays at the backend rather than by the
 * mode word, so the line reads as an explanation ("answers a local embedding model, but the mode resolves
 * to api-key") instead of a restatement. Keyed on the mode that consumes the value, so every gated leaf
 * has a phrasing by construction.
 */
const EMBEDDING_VALUE_ROLE: Readonly<Record<EmbeddingValueMode, string>> = {
    local: "a local embedding model",
    "api-key": "an api-key embedding endpoint",
};

/** Validate the embedding questions against the mode they resolved to, including the secret's environment channel. */
function validateEmbedding(answers: SetupAnswers, batch: boolean, readKey: () => string | undefined, problems: string[]): void {
    const embedding = answers.embedding;
    const mode = embedding?.mode;
    if (mode === undefined) {
        // An unanswered embedding mode means "leave the configured backend unchanged" — which DISCARDS any
        // endpoint/model/gguf answer, in every run, not only batch: on an already-configured machine the
        // interactive step keeps the existing backend and the value answer never reaches a writer, so the run
        // reports success having written nothing. The value can only be honored by the mode that consumes it,
        // so the mode is required wherever a value is answered.
        for (const leaf of keysOf(MODE_GATED_LEAVES.embedding)) {
            if (embedding?.[leaf] === undefined) continue;
            problems.push(
                `${answerSpelling(`embedding.${leaf}`)} names a value for an embedding backend, but nothing answers ${answerSpelling("embedding.mode")} — without it the configured backend is left as it is and this value is discarded. Add the mode, or drop the value.`,
            );
        }
        return;
    }
    for (const leaf of keysOf(MODE_GATED_LEAVES.embedding)) {
        const consumer = MODE_GATED_LEAVES.embedding[leaf];
        if (embedding?.[leaf] === undefined || consumer === mode) continue;
        problems.push(
            `${answerSpelling(`embedding.${leaf}`)} answers ${EMBEDDING_VALUE_ROLE[consumer]}, but ${answerSpelling("embedding.mode")} resolves to ${mode}.`,
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
    const { answers, notes } = mergeAnswers(file ?? {}, flags);
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
    return ok({ answers, batch, connectionMode, notes });
}

/**
 * One error's problem lines, attributed to the input they came from. Used where the two front-ends are
 * folded into ONE error: that error has no single `path`, so the header can no longer say which input a line
 * is about and each file problem carries its file inline instead.
 */
function attributedProblems(error: SetupAnswersError): readonly string[] {
    const path = error.type === "answers_invalid" ? error.path : undefined;
    const problems = problemsIn(error);
    return path === undefined ? problems : problems.map((problem) => `in \`${path}\`: ${problem}`);
}

/**
 * The orchestrator's one call: read the `--config` file when one was named, map the flags, merge, and
 * validate. Everything a caller needs to fail the run lives on the returned error
 * ({@link describeSetupAnswersError}).
 *
 * BOTH front-ends are evaluated before either is reported, so an author who mistyped a flag AND a file key
 * fixes both in one run instead of discovering the second only after fixing the first — the same
 * report-every-problem-in-one-pass contract {@link resolveSetupAnswers} holds within a single set.
 */
export function loadSetupAnswers(flags: SetupAnswerFlags, context: SetupAnswersContext): Result<ResolvedSetupAnswers, SetupAnswersError> {
    // Annotated so both branches meet at ONE Result type — a `Result<undefined, never> | Result<SetupAnswers, …>`
    // union has no callable `.andThen`.
    const file: Result<SetupAnswers | undefined, SetupAnswersError> = flags.config === undefined ? ok(undefined) : readAnswersFile(flags.config);
    // A file that could not be read or parsed is the terminal case: it yielded no answers at all, so there is
    // nothing to merge the flags with and nothing the combined list would add beyond the file to fix first.
    if (file.isErr() && file.error.type !== "answers_invalid") return err(file.error);

    const fromFlags = answersFromFlags(flags);
    if (file.isErr() && fromFlags.isErr()) {
        return err({ type: "answers_invalid", path: undefined, problems: [...attributedProblems(file.error), ...attributedProblems(fromFlags.error)] });
    }
    // One side failing keeps its own error whole — including the file's `path`, which is what makes the
    // rendered header name the file the author has to open.
    return file.andThen((fileAnswers) => fromFlags.andThen((flagAnswers) => resolveSetupAnswers(flagAnswers, fileAnswers, context)));
}
