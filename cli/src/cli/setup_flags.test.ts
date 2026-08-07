import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import { buildProgram } from "./index.ts";
import * as setupModule from "../modules/infra/setup.ts";
import { loadSetupAnswers, type SetupAnswerFlags, type SetupAnswers, type SetupAnswersContext } from "../modules/infra/setup_answers.ts";

// THE PIN: the registry hands `setup` a 23-field `flags` literal, one field per Batch-mode option. That
// literal is pure re-spelling — commander's camelCased option name → the same name on `SetupAnswerFlags` —
// which is exactly why it can rot without anyone noticing: an option added to the command declaration but
// forgotten in the literal parses, shows up in `--help`, and is then dropped on the floor. Neither
// setup_answers.test.ts (which starts FROM a `SetupAnswerFlags` object) nor setup.test.ts (same) can see
// that gap, because both begin on the far side of it.
//
// So this suite drives the REAL commander program with real argv, intercepts `setup` to capture what the
// registry actually forwarded, and asserts (a) the forwarded key set is exactly the declared Batch-mode
// option set, and (b) every one of those options carries its value all the way into the resolved answers.
//
// The action is intercepted rather than executed: `setup` provisions containers. Interception (rather than
// parse-only + `opts()`) is what makes the literal itself the thing under test — reading `opts()` directly
// would bypass the very mapping this file exists to pin.

/** The `optionsGroup` heading `src/cli/index.ts` files every answer-carrying option under. */
const BATCH_GROUP = "Batch mode:";

function setupCommand(program: Command): Command {
    const command = program.commands.find((child) => child.name() === "setup");
    if (command === undefined) throw new Error("the registry no longer declares a `setup` command");
    return command;
}

/** Commander's attribute name for every option declared in the Batch-mode group — the answer surface. */
function batchOptionNames(): string[] {
    return setupCommand(buildProgram())
        .options.filter((option) => option.helpGroupHeading === BATCH_GROUP)
        .map((option) => option.attributeName());
}

/**
 * The BATCH-mode attribute names the long flags in `argv` resolve to, so a case can prove which answers it
 * exercised. Run modifiers (`--yes`) are filtered out rather than banned from the argv: a realistic
 * invocation carries them, and they answer how the run behaves, never what the client looks like.
 */
function exercisedOptionNames(argv: readonly string[]): string[] {
    const options = setupCommand(buildProgram()).options;
    return argv
        .filter((token) => token.startsWith("--"))
        .map((token) => {
            const option = options.find((candidate) => candidate.long === token);
            if (option === undefined) throw new Error(`\`setup\` declares no ${token} option`);
            return option;
        })
        .filter((option) => option.helpGroupHeading === BATCH_GROUP)
        .map((option) => option.attributeName());
}

/**
 * Parse one argv through the real program and return the `flags` object the registry forwarded.
 *
 * `spyOn` on the module namespace — not `mock.module` — because the whole suite shares one bun process and
 * a module-registry swap of `modules/infra/setup.ts` would follow this file into setup.test.ts. The spy is
 * restored in `afterEach` for the same reason.
 */
async function forwardedFlags(argv: readonly string[]): Promise<SetupAnswerFlags> {
    let captured: SetupAnswerFlags | undefined;
    setupSpy = spyOn(setupModule, "setup").mockImplementation(async (options) => {
        captured = options.flags ?? {};
    });
    await buildProgram().parseAsync(["setup", ...argv], { from: "user" });
    expect(setupSpy).toHaveBeenCalledTimes(1);
    // Non-null: the assertion above proves the intercepted action ran, and it is the only writer.
    return captured!;
}

let setupSpy: ReturnType<typeof spyOn<typeof setupModule, "setup">> | undefined;

/** Resolve the forwarded flags the way `setup` itself would, with the embedding secret's seam supplied. */
function resolve(flags: SetupAnswerFlags): SetupAnswers {
    const context: SetupAnswersContext = { batch: true, embeddingApiKey: () => "sk-embed" };
    return loadSetupAnswers(flags, context)._unsafeUnwrap().answers;
}

/**
 * The connection block of a direct endpoint, plus a command credential source — one argv can only carry ONE
 * credential source and ONE embedding backend, so the value cases split along those two exclusions rather
 * than by convenience.
 */
const DIRECT_ARGV = [
    "--connection",
    "direct",
    "--provider",
    "deepseek",
    "--base-url",
    "https://gw.corp/v1",
    "--protocol",
    "openai-compatible",
    "--model",
    "d-1",
] as const;

const COMMAND_AUTH_ARGV = ["--auth-command", "/opt/mint-token", "--auth-scheme", "bearer", "--auth-format", "exec-credential"] as const;

const REST_ARGV = [
    "--postgres-user",
    "alice",
    "--postgres-password",
    "s3cret",
    "--postgres-port",
    "6000",
    "--postgres-database",
    "atlas",
    "--postgres-host",
    "db.internal",
    "--resource-share",
    "37",
    "--embeddings",
    "api-key",
    "--embeddings-url",
    "https://embeds.internal/v1",
    "--embeddings-model",
    "text-embedding-3-large",
    "--refs",
    "collectri,gtex-v10",
    "--sandbox",
    "yes",
    "--runtime",
    "podman",
] as const;

const API_KEY_ARGV = ["--yes", ...DIRECT_ARGV, ...COMMAND_AUTH_ARGV, ...REST_ARGV];

const LOCAL_ARGV = [
    "--yes",
    ...DIRECT_ARGV,
    "--auth-env",
    "MY_GATEWAY_TOKEN",
    "--auth-scheme",
    "x-api-key",
    "--embeddings",
    "local",
    "--embeddings-gguf",
    "/models/m.gguf",
];

describe("setup registry — every declared batch option reaches the answers layer", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-setup-flags-"));
    });
    afterEach(() => {
        setupSpy?.mockRestore();
        setupSpy = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    test("the forwarded flag object carries exactly the Batch-mode options — nothing dropped, nothing invented", async () => {
        // The failure this catches: an option declared on the command but missing from the registry's
        // `flags:` literal. It parses, it appears in `--help`, and its value is silently discarded.
        const forwarded = await forwardedFlags(["--yes"]);
        expect(Object.keys(forwarded).toSorted()).toEqual(batchOptionNames().toSorted());
    });

    test("a direct connection with a command credential source lands whole", async () => {
        const answers = resolve(await forwardedFlags(API_KEY_ARGV));
        expect(answers).toEqual({
            connection: {
                mode: "direct",
                provider: "deepseek",
                baseURL: "https://gw.corp/v1",
                protocol: "openai-compatible",
                model: "d-1",
                auth: { kind: "command", command: "/opt/mint-token", scheme: "bearer", format: "exec-credential" },
            },
            postgres: { user: "alice", password: "s3cret", port: 6000, database: "atlas", host: "db.internal" },
            resources: { sharePct: 37 },
            embedding: { mode: "api-key", baseURL: "https://embeds.internal/v1", model: "text-embedding-3-large", gguf: undefined },
            refs: ["collectri", "gtex-v10"],
            sandbox: "yes",
            runtime: "podman",
        });
    });

    test("the mutually-exclusive half — an env credential source and a local GGUF — lands too", async () => {
        // `--auth-env` excludes `--auth-command`, and `--embeddings-gguf` excludes the api-key endpoint
        // answers, so these four options are unreachable from the case above by construction, not by taste.
        const answers = resolve(await forwardedFlags(LOCAL_ARGV));
        expect(answers.connection?.auth).toEqual({ kind: "env", var: "MY_GATEWAY_TOKEN", scheme: "x-api-key" });
        expect(answers.embedding).toEqual({ mode: "local", baseURL: undefined, model: undefined, gguf: "/models/m.gguf" });
    });

    test("--config names a file whose answers reach the same resolution", async () => {
        const path = join(dir, "fleet.yml");
        writeFileSync(path, "postgres:\n  database: from-file\nrefs: recommended\n");
        const answers = resolve(await forwardedFlags(["--yes", "--config", path]));
        expect(answers.postgres?.database).toBe("from-file");
        expect(answers.refs).toBe("recommended");
    });

    test("the cases above exercise EVERY batch option — a new one cannot ship with no value case", () => {
        // Without this, the key-set test alone would pass for a flag that is forwarded but never proven to
        // survive parsing, merging, and validation with its value intact.
        const exercised = new Set([...exercisedOptionNames(API_KEY_ARGV), ...exercisedOptionNames(LOCAL_ARGV), "config"]);
        expect([...exercised].toSorted()).toEqual(batchOptionNames().toSorted());
    });
});
