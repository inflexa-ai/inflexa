/**
 * The build session of a source install — the CLI realization of the harness
 * `BuildSession` interface behind the `install_from_source` conversation tool.
 *
 * A session is a HELD provisioner container: its entrypoint override sources the
 * egress-allowlist function of the image, applies the session's list, and then
 * holds. The container gets no store mount, because the session builds and
 * never installs; one scratch volume holds the pristine snapshot of the source
 * and the working copy the commands mutate, and the pristine snapshot binds
 * READ-ONLY over the volume, so no session user can write the tree the clean
 * run reads. The exploration start walls the git host of the source alone (a
 * folder source gets no network at all); the first command that carries an
 * approved plan restarts the container under the approved list over the same
 * scratch tree, and a later amended plan restarts it again. Each start — the
 * exploration one and every restart — pins apt to the dated Ubuntu snapshot of
 * the provisioner image first, so a plain `apt-get update` obeys the pin.
 *
 * The host snapshots the source BEFORE the first command, through one-shot
 * containers over the volume: a clone at the resolved commit for a git source
 * (`ls-remote` answers first for EVERY ref — a hex-looking name can name a
 * branch — and only a ref no remote row answers resolves inside the clone
 * through `rev-parse --verify`, with one fetch for a sha the default branch
 * does not hold; the pin is the commit the checkout lands at, never the
 * tag-object id an annotated tag shows), and a copy of the folder for a local
 * one, hashed over that copy by the provisioner's own `tree_hash` in one short
 * container. A private repository authenticates through a `GIT_ASKPASS`
 * helper script that lives in the scratch volume at mode 0700: it answers the
 * token for the host of the source alone — any other host git names fails its
 * auth — and the clone containers name its PATH through plain `-e` flags, the
 * token never appears in an argument or an environment list, and the helper is
 * gone once the clone lands.
 *
 * Every runner is injectable, so the tests pin the container arguments without
 * an engine.
 */

import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { randomUUIDv7 } from "bun";
import type { Result } from "neverthrow";

import type {
    BuildCommitResult,
    BuildExecResult,
    BuildPlan,
    BuildSession,
    BuildSessionCommand,
    BuildSessionHandle,
    BuildSource,
} from "@inflexa-ai/harness";

import { ensureRuntime } from "../../lib/config.ts";
import { capture, type CaptureResult, type ContainerRuntime, type ContainerRuntimeError } from "../../lib/container.ts";
import { readEnvCredentialVar } from "../../lib/env.ts";
import { provisionerImageFor } from "./images.ts";
import { ensureImagePresent, configuredSandboxImage, type ImageAbsentError } from "./pull.ts";
import { SESSION_CLASS_HOSTS, sessionEgressAllow } from "./provisioner.ts";
import { flySourceBuild, type SourceFlightDeps, type SourceFlightOutcome, type SourceFlightParams } from "./store_flight.ts";

/** Where the scratch tree of a session lives inside the container. */
const WORK_ROOT = "/work";

/** The pristine snapshot: the tree the clean run reads, never the working copy. */
const PRISTINE = `${WORK_ROOT}/src`;

/** The working copy: the tree the session commands mutate. Each exec defaults its cwd here. */
const WORKING = `${WORK_ROOT}/copy`;

/** The build script of the commit, written by the host beside the snapshot. */
const SCRIPT_NAME = "build.sh";

/** The `GIT_ASKPASS` helper of the clone: a 0700 script in the scratch volume that answers the token for the source host alone. */
const ASKPASS_NAME = ".git-askpass";
const ASKPASS_PATH = `${WORK_ROOT}/${ASKPASS_NAME}`;

/**
 * The uid of the non-root execs. The provisioner image creates this build user
 * (its Dockerfile), thus the execs resolve a home; the session start chowns
 * the working copy to this uid, so the build commands can write it.
 */
const SESSION_USER = "1000:1000";

/** The per-command timeout, in seconds. A command that outlives it is killed inside the container. */
const DEFAULT_EXEC_TIMEOUT_SECONDS = 900;

/** The grace between the TERM of an expired command and the KILL that ends a command that traps TERM, in seconds. A 137 counts as a timed-out command only past the deadline plus this grace, because the kill-after KILL cannot fire earlier — a 137 before it (an OOM kill) is a failure of its own. */
const TIMEOUT_KILL_AFTER_SECONDS = 5;

/** The grace of {@link TIMEOUT_KILL_AFTER_SECONDS} in milliseconds, the margin the timeout verdict keeps past the budget. */
const TIMEOUT_KILL_AFTER_MS = TIMEOUT_KILL_AFTER_SECONDS * 1000;

/** The line the egress-allowlist function prints when the wall is up — the readiness signal of a walled start. */
const WALL_MARKER = "[egress-allowlist] active";

/** How long a start waits for the wall before it refuses. */
const READY_TIMEOUT_MS = 15_000;

/** The egress preamble every walled container command sources before its own work. */
const WALL_PREAMBLE = ". /usr/local/bin/egress-allowlist.sh && apply_egress_allowlist && ";

/** The held entrypoint: apply the allowlist the provisioner entrypoint applies, then hold. */
const HOLD_COMMAND = `${WALL_PREAMBLE}exec sleep infinity`;

/** The one-shot container command that hashes a folder snapshot with the provisioner's own function. The image ships the module extensionless at /usr/local/bin/provision, and `spec_from_file_location` answers no loader for an unknown suffix, thus an explicit `SourceFileLoader` loads it (the `sys.path` entry keeps its sibling `emit_deps` importable). */
const TREE_HASH_COMMAND =
    "import importlib.machinery, importlib.util, sys; sys.path.insert(0, '/usr/local/bin'); from pathlib import Path; " +
    "loader = importlib.machinery.SourceFileLoader('provision', '/usr/local/bin/provision'); " +
    "spec = importlib.util.spec_from_loader('provision', loader); " +
    "mod = importlib.util.module_from_spec(spec); loader.exec_module(mod); print(mod.tree_hash(Path('/work/src')))";

/** The label the provisioner image bakes its base reference into; the digest after the last `@` is the base the record names. */
const BASE_LABEL_FORMAT = '{{index .Config.Labels "org.opencontainers.image.base.name"}}';

/** The dated Ubuntu snapshot the apt pin writes every source of apt to. */
const APT_SNAPSHOT_URL_PREFIX = "https://snapshot.ubuntu.com/ubuntu/";

/** The apt sources file the session start and the clean run write before any apt command. */
const APT_SOURCES_FILE = "inflexa-snapshot.sources";

/** How one runtime command runs. The default is `capture` of `lib/container.ts`; a test records and answers. */
type RuntimeCommand = (rt: ContainerRuntime, args: string[]) => Promise<CaptureResult>;

/** The parts of the host a session runs on. Every piece is injectable, and each default is the real one. */
export type BuildSessionHost = {
    /** Resolves and pins the container runtime. Default: `ensureRuntime`. */
    readonly resolveRuntime?: () => Promise<Result<ContainerRuntime, ContainerRuntimeError>>;
    /** Runs one runtime command. Default: `capture`. */
    readonly run?: RuntimeCommand;
    /** The provisioner image the session holds. Default: `provisionerImageFor(configuredSandboxImage())`. */
    readonly provisionerImage?: string;
    /** Whether the engine holds the image. Default: `ensureImagePresent`. */
    readonly ensureImage?: (rt: ContainerRuntime, image: string) => Promise<Result<void, ImageAbsentError>>;
    /** The clean-run flight. Default: `flySourceBuild`. */
    readonly fly?: (params: SourceFlightParams, deps?: SourceFlightDeps) => Promise<SourceFlightOutcome>;
    /** The host environment the clone reads `GITHUB_PAT` from. Default: `process.env`. */
    readonly hostEnv?: Readonly<Record<string, string | undefined>>;
    /** The per-command timeout, in seconds. Default: {@link DEFAULT_EXEC_TIMEOUT_SECONDS}. */
    readonly execTimeoutSeconds?: number;
};

/** One live session: the container, the scratch tree, and the plan it runs under. */
type LiveSession = {
    readonly rt: ContainerRuntime;
    readonly image: string;
    readonly containerName: string;
    readonly scratch: string;
    readonly source: BuildSource;
    /** The analysis whose farm the commit extends, from the `start` call of the session. */
    readonly analysisId: string | null;
    /** The full commit the host resolved and cloned; set during `start` of a git source. */
    commit?: string;
    /** The tree hash of the pristine copy of a folder source, taken before the first command. */
    folderTreeHash?: string;
    plan?: BuildPlan;
};

/** `timeout` exits 124 when it stops the command itself, and 137 when `--kill-after` KILLs a command that ignored TERM — a KILL the deadline alone lets happen. The host clock also wraps the exec startup and return, thus a 137 counts only past the budget plus the kill-after grace: a KILL before the deadline (an OOM kill) stays a plain failure, whatever the startup overhead. */
const timedOut = (code: number, elapsedMs: number, budgetMs: number): boolean =>
    code === 124 || (code === 137 && elapsedMs >= budgetMs + TIMEOUT_KILL_AFTER_MS);

/** A full commit sha. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Quote one word for a `bash -c` command string. */
function shellQuote(word: string): string {
    return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The image facts of one walled command's arguments: the egress preamble, the volume, and the entrypoint override. */
function oneShotArgs(
    rt: ContainerRuntime,
    image: string,
    scratch: string,
    over: { readonly egressAllow: string | null; readonly command: string; readonly askpass: boolean; readonly writable: boolean },
): string[] {
    return [
        "run",
        "--rm",
        ...(over.egressAllow === null ? ["--network", "none"] : ["--cap-add", "NET_ADMIN", "-e", `INFLEXA_EGRESS_ALLOW=${over.egressAllow}`]),
        ...(over.askpass ? ["-e", `GIT_ASKPASS=${ASKPASS_PATH}`, "-e", "GIT_TERMINAL_PROMPT=0"] : []),
        "-v",
        over.writable ? rt.mountArg(scratch, WORK_ROOT) : rt.mountArgRo(scratch, WORK_ROOT),
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        over.egressAllow === null ? over.command : `${WALL_PREAMBLE}${over.command}`,
    ];
}

/** The container arguments of one held session start. `egressAllow === null` gives the container no network at all, which is the wall of a folder exploration. The pristine snapshot binds read-only over the volume, so no session user writes the tree the clean run reads. */
function sessionStartArgs(rt: ContainerRuntime, image: string, containerName: string, scratch: string, egressAllow: string | null): string[] {
    return [
        "run",
        "-d",
        "--name",
        containerName,
        ...(egressAllow === null ? ["--network", "none"] : ["--cap-add", "NET_ADMIN", "-e", `INFLEXA_EGRESS_ALLOW=${egressAllow}`]),
        "-v",
        rt.mountArg(scratch, WORK_ROOT),
        "-v",
        rt.mountArgRo(join(scratch, "src"), PRISTINE),
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        HOLD_COMMAND,
    ];
}

/** The arguments of one exec into the session container: a fresh shell, its own timeout, and the user rule. */
function sessionExecArgs(
    containerName: string,
    options: { readonly command: string; readonly root?: boolean; readonly timeoutSeconds?: number; readonly workdir?: string },
    defaultTimeoutSeconds: number,
): string[] {
    const timeout = options.timeoutSeconds ?? defaultTimeoutSeconds;
    return [
        "exec",
        ...(options.root === true ? [] : ["--user", SESSION_USER]),
        ...(options.workdir === undefined ? [] : ["--workdir", options.workdir]),
        containerName,
        "timeout",
        "--kill-after",
        String(TIMEOUT_KILL_AFTER_SECONDS),
        `${timeout}`,
        "/bin/bash",
        "-c",
        options.command,
    ];
}

/** Wait until the held container is up and, when it is walled, until the allowlist reports itself active. */
async function awaitHeld(run: RuntimeCommand, rt: ContainerRuntime, containerName: string, walled: boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (walled) {
            const logs = await run(rt, ["logs", containerName]);
            if (logs.stdout.includes(WALL_MARKER)) return;
        }
        const inspect = await run(rt, ["inspect", "--format", "{{.State.Running}}", containerName]);
        if (inspect.stdout.trim() !== "true") {
            const logs = await run(rt, ["logs", containerName]);
            throw new Error(`the build-session container exited at start:\n${`${logs.stdout}\n${logs.stderr}`.trim()}`);
        }
        if (!walled) return;
        if (Date.now() > deadline) {
            const logs = await run(rt, ["logs", containerName]);
            throw new Error(`the build-session container did not install its egress allowlist:\n${`${logs.stdout}\n${logs.stderr}`.trim()}`);
        }
        await Promise.sleep(100);
    }
}

/** The apt pin: replace the live-archive sources with the dated Ubuntu snapshot, so a plain `apt-get update` obeys the pin. Runs before any apt command of the session. */
function aptPinCommand(snapshotTimestamp: string): string {
    const format =
        "Types: deb\\n" +
        `URIs: ${APT_SNAPSHOT_URL_PREFIX}${snapshotTimestamp}/\\n` +
        "Suites: %s %s-updates %s-backports %s-security\\n" +
        "Components: main restricted universe multiverse\\n" +
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\\n" +
        "Check-Valid-Until: no\\n";
    return [
        "set -e",
        'codename=$(. /etc/os-release && printf %s "$VERSION_CODENAME")',
        'dir=/etc/apt/sources.list.d',
        `printf '${format}' "$codename" "$codename" "$codename" "$codename" > "$dir"/${APT_SOURCES_FILE}`,
        `rm -f /etc/apt/sources.list "$dir"/ubuntu.sources "$dir"/*.list`,
    ].join(" && ");
}

/** The `<sha>` and full `<name>` of a `git ls-remote` answer: the row of a named ref — a branch before a tag, as git's own checkout picks — or of `HEAD` when the source names no ref. */
function parseLsRemote(out: string, ref: string | undefined): { readonly sha: string; readonly name: string } | null {
    const rows = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
            const tab = line.indexOf("\t");
            return tab < 0 ? null : ([line.slice(0, tab).trim(), line.slice(tab + 1).trim()] as const);
        })
        .filter((row): row is readonly [string, string] => row !== null);
    const wanted = ref === undefined ? ["HEAD"] : [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const name of wanted) {
        const hit = rows.find(([, rowName]) => rowName === name);
        if (hit !== undefined) return { sha: hit[0], name };
    }
    return null;
}

/**
 * The dated Ubuntu snapshot stamp of the image creation time — `YYYYMMDDTHHMMSSZ`,
 * the form snapshot.ubuntu.com spells. Docker prints RFC3339
 * (`2026-10-19T21:31:56.690123456Z`); podman prints the Go time layout
 * (`2026-10-19 21:31:56.69 +0000 UTC`). Anything else refuses: a guessed date
 * would pin apt to a snapshot that does not exist.
 */
function snapshotTimestampOf(created: string): string {
    const parts = createdAtOf(created.trim());
    if (parts === null) {
        throw new Error(`the provisioner image names no readable creation time ("${created}"), thus no apt snapshot to pin.`);
    }
    const [day, time, fraction, zone] = parts;
    // The fraction trims to millis, because `new Date` reads at most three
    // digits and the stamp needs the second alone.
    const date = new Date(`${day}T${time}.${fraction.slice(0, 3).padEnd(3, "0")}${zone}`);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`the provisioner image names no readable creation time ("${created}"), thus no apt snapshot to pin.`);
    }
    const two = (part: number): string => String(part).padStart(2, "0");
    return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

/** Docker's RFC3339 spelling of a creation time. */
const RFC3339 = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** Podman's spelling: the Go time layout, `2026-10-19 21:31:56.69 +0000 UTC`, with the zone name behind the offset. */
const GO_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-])(\d{2})(\d{2})(?: .+)?$/;

/** One creation time as its parts: the day, the time, the fraction, and the zone offset (`Z` or `±hh:mm`). */
function createdAtOf(value: string): readonly [string, string, string, string] | null {
    const iso = RFC3339.exec(value);
    if (iso !== null) return [iso[1] ?? "", iso[2] ?? "", iso[3] ?? "", iso[4] ?? ""];
    const go = GO_TIME.exec(value);
    if (go !== null) return [go[1] ?? "", go[2] ?? "", go[3] ?? "", `${go[4] ?? ""}${go[5] ?? ""}:${go[6] ?? ""}`];
    return null;
}

/**
 * The base digest of the label value: the `@sha256:` digest behind the last
 * `@`. A value without one — the rocker base ships `base.name` as a bare
 * `docker.io/library/ubuntu:noble` — names a tag, and a tag in the record's
 * digest slot would lie about the base the build ran on. The provisioner
 * Dockerfile bakes the digest into the label, thus its absence is a build
 * fault, not a shape to fall back from.
 */
function baseDigestOf(label: string): string {
    const value = label.trim();
    const at = value.lastIndexOf("@sha256:");
    const digest = at < 0 ? "" : value.slice(at + "@sha256:".length);
    if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`the org.opencontainers.image.base.name label "${value}" names no @sha256: digest, thus the build record names no base digest.`);
    }
    return `sha256:${digest}`;
}

/** The tail of one capture, for an error that names the real cause. */
function tailOf(captured: CaptureResult): string {
    return `${captured.stdout}\n${captured.stderr}`.trim().split("\n").slice(-8).join("\n");
}

// --- The exit cleanup -----------------------------------------------------------

const liveAtExit = new Map<string, { readonly bin: string; readonly containerName: string; readonly scratch: string }>();
let exitCleanupHooked = false;

/** Remove each live session container and scratch tree when the host process dies, so nothing holds a container after it. */
function sweepAtExit(): void {
    for (const entry of liveAtExit.values()) {
        try {
            Bun.spawnSync([entry.bin, "rm", "-f", entry.containerName]);
        } catch {
            // A dead engine names a host that stopped; the container is removable as debris.
        }
        try {
            rmSync(entry.scratch, { recursive: true, force: true });
        } catch {
            // The scratch tree is a temp directory the OS reclaims.
        }
    }
}

function registerAtExit(session: LiveSession): void {
    if (!exitCleanupHooked) {
        process.once("exit", sweepAtExit);
        exitCleanupHooked = true;
    }
    liveAtExit.set(session.containerName, { bin: session.rt.bin, containerName: session.containerName, scratch: session.scratch });
}

// --- The session ----------------------------------------------------------------

/**
 * The CLI realization of the harness `BuildSession`. Its `start` admits a null
 * analysis beside the interface's string, and the commit refuses that null as
 * a binding fault — a source build never lands with no farm to extend.
 */
export type CliBuildSession = BuildSession & { start(source: BuildSource, analysisId: string | null): Promise<BuildSessionHandle> };

/**
 * Make the CLI realization of the harness `BuildSession` interface. The
 * analysis id arrives with each `start` call, and the commit extends the farm
 * of that analysis.
 */
export function createBuildSession(storeRoot: string, host: BuildSessionHost = {}): CliBuildSession {
    const run: RuntimeCommand = host.run ?? capture;
    const execTimeout = host.execTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    const sessions = new Map<string, LiveSession>();

    /** Run one exec in the container of the session and give back the capture. */
    const execIn = async (
        session: LiveSession,
        options: { command: string; root?: boolean; timeoutSeconds?: number; workdir?: string },
    ): Promise<CaptureResult> => run(session.rt, sessionExecArgs(session.containerName, options, execTimeout));

    /** Run one walled one-shot container over the scratch volume, and give back the capture. */
    const oneShot = async (
        session: LiveSession,
        over: { readonly egressAllow: string | null; readonly command: string; readonly askpass: boolean; readonly writable: boolean },
        what: string,
    ): Promise<CaptureResult> => {
        const captured = await run(session.rt, oneShotArgs(session.rt, session.image, session.scratch, over));
        if (captured.code !== 0) throw new Error(`could not ${what}:\n${tailOf(captured)}`);
        return captured;
    };

    /** The digests and the apt snapshot stamp of the pair, read from the engine for the build record and the apt pin. */
    const imageFacts = async (session: LiveSession): Promise<{ readonly provisioner: string; readonly base: string; readonly aptSnapshotTimestamp: string }> => {
        const inspect = async (format: string): Promise<string> => {
            const captured = await run(session.rt, ["image", "inspect", "--format", format, session.image]);
            if (captured.code !== 0) throw new Error(`could not read the ${format} of the image ${session.image}:\n${tailOf(captured)}`);
            return captured.stdout.trim();
        };
        // The base digest rides a label the image bakes from its own build
        // argument, because a process in the container cannot read the digest
        // of the image it runs in, and the sandbox image id would name the
        // wrong base: the two images share the base, not the layers.
        return {
            provisioner: await inspect("{{.Id}}"),
            base: baseDigestOf(await inspect(BASE_LABEL_FORMAT)),
            aptSnapshotTimestamp: snapshotTimestampOf(await inspect("{{.Created}}")),
        };
    };

    /** Start the held container of the session under one egress list, over the same scratch tree, and pin apt to the dated snapshot before any command of the session can run. */
    const startContainer = async (session: LiveSession, egressAllow: string | null): Promise<void> => {
        const started = await run(session.rt, sessionStartArgs(session.rt, session.image, session.containerName, session.scratch, egressAllow));
        if (started.code !== 0) throw new Error(`could not start the build-session container:\n${tailOf(started)}`);
        await awaitHeld(run, session.rt, session.containerName, egressAllow !== null);
        const facts = await imageFacts(session);
        const pinned = await execIn(session, { command: aptPinCommand(facts.aptSnapshotTimestamp), root: true });
        if (pinned.code !== 0) throw new Error(`could not pin apt to the snapshot of ${facts.aptSnapshotTimestamp}:\n${tailOf(pinned)}`);
    };

    const stopContainer = async (session: LiveSession): Promise<void> => {
        await run(session.rt, ["rm", "-f", session.containerName]);
    };

    /**
     * Remove the scratch tree. The session commands ran as the container's
     * root for the host-driven setup steps, thus the tree can hold bytes the
     * host user cannot unlink; one one-shot container over the volume clears
     * them, then the host removes the emptied tree.
     */
    const clearScratch = async (session: LiveSession): Promise<void> => {
        try {
            rmSync(session.scratch, { recursive: true, force: true });
            return;
        } catch {
            // The bytes below belong to the container's root, not to this user.
        }
        await run(session.rt, [
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            session.rt.mountArg(session.scratch, WORK_ROOT),
            "--entrypoint",
            "/bin/sh",
            session.image,
            "-c",
            "find /work -mindepth 1 -delete",
        ]).catch(() => undefined);
        rmSync(session.scratch, { recursive: true, force: true });
    };

    const teardown = async (sessionId: string): Promise<void> => {
        const session = sessions.get(sessionId);
        if (session !== undefined) {
            sessions.delete(sessionId);
            await stopContainer(session).catch(() => undefined);
            await clearScratch(session);
        }
        liveAtExit.delete(containerNameOf(sessionId));
    };

    /**
     * Resolve the source to the commit the build pins: one walled one-shot
     * `ls-remote` first, then the clone it feeds. `ls-remote` answers for EVERY
     * name — a hex-looking name can name a branch, and a bare `rev-parse` of a
     * remote branch resolves nothing — and only a name no remote row answers
     * resolves inside the clone as a sha.
     */
    const landSource = async (session: LiveSession, url: string, ref: string | undefined, gitHost: string, askpass: boolean): Promise<string> => {
        const pattern = ref ?? "HEAD";
        const captured = await oneShot(
            session,
            { egressAllow: gitHost, command: `git ls-remote ${shellQuote(url)} ${shellQuote(pattern)}`, askpass, writable: false },
            `resolve the source ref of ${url}`,
        );
        const row = parseLsRemote(captured.stdout, ref);
        if (row === null && ref === undefined) {
            throw new Error(`the source ${url} holds no default-branch HEAD, thus no commit to build at.`);
        }
        if (row === null) {
            return cloneSource(session, url, { checkout: ref ?? "", resolve: true, gitHost, askpass });
        }
        // The checkout lands by name and the pin is the HEAD it lands at, never
        // the `ls-remote` sha: an annotated tag's row names its tag object.
        const checkout = row.name === "HEAD" ? "HEAD" : row.name.startsWith("refs/heads/") ? `origin/${row.name.slice("refs/heads/".length)}` : row.name.slice("refs/tags/".length);
        return cloneSource(session, url, { checkout, resolve: false, gitHost, askpass });
    };

    /**
     * Clone the source into the pristine snapshot through one walled one-shot
     * container, and print the full commit the checkout lands at — `rev-parse
     * HEAD` after the detach, so an annotated tag reports its commit, not its
     * tag object. `checkout` names what the clone detaches at: a resolved sha,
     * `HEAD`, a local tag, or `origin/<branch>`. `resolve` instead resolves
     * `checkout` INSIDE the clone through `rev-parse --verify`, with one fetch
     * for a sha the default branch does not hold.
     */
    const cloneSource = async (
        session: LiveSession,
        url: string,
        over: { readonly checkout: string; readonly resolve: boolean; readonly gitHost: string; readonly askpass: boolean },
    ): Promise<string> => {
        const clone = `git clone --quiet ${shellQuote(url)} ${shellQuote(PRISTINE)}`;
        const landAt = (target: string): string =>
            `git -C ${shellQuote(PRISTINE)} checkout --quiet --detach ${target} && ` +
            `sha=$(git -C ${shellQuote(PRISTINE)} rev-parse HEAD) && ` +
            `rm -rf ${shellQuote(`${PRISTINE}/.git`)} && printf '%s\\n' "$sha"`;
        let command: string;
        if (over.resolve) {
            const verify = shellQuote(`${over.checkout}^{commit}`);
            command =
                `${clone} && sha=$(git -C ${shellQuote(PRISTINE)} rev-parse --verify ${verify} || ` +
                `{ git -C ${shellQuote(PRISTINE)} fetch --quiet origin ${shellQuote(over.checkout)} && git -C ${shellQuote(PRISTINE)} rev-parse --verify ${verify}; }) && ` +
                landAt('"$sha"');
        } else {
            command = `${clone} && ${landAt(shellQuote(over.checkout))}`;
        }
        const captured = await oneShot(session, { egressAllow: over.gitHost, command, askpass: over.askpass, writable: true }, `clone ${url}`);
        const landed = captured.stdout.trim().split("\n").at(-1) ?? "";
        if (!FULL_SHA.test(landed)) throw new Error(`the clone of ${url} named no full commit sha:\n${tailOf(captured)}`);
        return landed;
    };

    /** Give the session its working copy of the pristine tree, writable by the non-root user of the execs. */
    const makeWorkingCopy = async (session: LiveSession): Promise<void> => {
        const captured = await execIn(session, { command: `cp -a ${shellQuote(PRISTINE)} ${shellQuote(WORKING)} && chown -R ${SESSION_USER} ${shellQuote(WORKING)}`, root: true });
        if (captured.code !== 0) throw new Error(`could not make the working copy of the source:\n${tailOf(captured)}`);
    };

    /** The tree hash of a folder snapshot, from the provisioner's own function over the copy. */
    const hashSnapshot = async (session: LiveSession): Promise<string> => {
        const captured = await run(session.rt, [
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            session.rt.mountArgRo(join(session.scratch, "src"), "/work/src"),
            "--entrypoint",
            "/usr/bin/python3",
            session.image,
            "-c",
            TREE_HASH_COMMAND,
        ]);
        if (captured.code !== 0 || !/^[0-9a-f]{64}$/.test(captured.stdout.trim())) {
            throw new Error(`could not hash the folder snapshot with the provisioner:\n${tailOf(captured)}`);
        }
        return captured.stdout.trim();
    };

    /** The repository name of a git URL, which names the source flight row the commit claims. */
    const repoNameOf = (url: string): string => {
        const last = new URL(url).pathname.split("/").filter((part) => part !== "").at(-1) ?? "";
        const name = last.endsWith(".git") ? last.slice(0, -4) : last;
        if (name === "") throw new Error(`the source URL ${url} names no repository, thus no name for its flight row.`);
        return name;
    };

    return {
        async start(source, analysisId: string | null): Promise<BuildSessionHandle> {
            const rtResult = await (host.resolveRuntime ?? ensureRuntime)();
            if (rtResult.isErr()) throw new Error(rtResult.error.message);
            const rt = rtResult.value;
            const image = host.provisionerImage ?? provisionerImageFor(configuredSandboxImage());
            const present = await (host.ensureImage ?? ensureImagePresent)(rt, image);
            if (present.isErr()) throw new Error(present.error.message);

            const sessionId = `bs-${randomUUIDv7()}`;
            const gitHost = source.kind === "git" ? gitHostOf(source.url) : null;
            const session: LiveSession = {
                rt,
                image,
                containerName: containerNameOf(sessionId),
                scratch: mkdtempSync(join(tmpdir(), "inflexa-build-")),
                source,
                analysisId,
            };
            // 0755, not the 0700 of mkdtemp: the non-root execs must traverse
            // the scratch root to reach the working copy under it.
            chmodSync(session.scratch, 0o755);
            sessions.set(sessionId, session);
            registerAtExit(session);
            try {
                if (source.kind === "git") {
                    // The token rides the clone steps alone: a helper script the
                    // clone containers name by path, never an argument or an
                    // environment list that holds the value.
                    const token = host.hostEnv === undefined ? readEnvCredentialVar("GITHUB_PAT") : host.hostEnv["GITHUB_PAT"];
                    // `gitHost` is the git source's host, non-null inside this branch.
                    const sourceHost = gitHostOf(source.url);
                    const askpassHost = token === undefined || token === "" ? undefined : writeAskpass(session.scratch, token, sourceHost);
                    try {
                        session.commit = await landSource(session, source.url, source.ref, sourceHost, askpassHost !== undefined);
                    } finally {
                        if (askpassHost !== undefined) rmSync(askpassHost, { force: true });
                    }
                } else {
                    cpSync(source.path, join(session.scratch, "src"), { recursive: true });
                    session.folderTreeHash = await hashSnapshot(session);
                }
                await startContainer(session, gitHost);
                await makeWorkingCopy(session);
            } catch (cause) {
                await teardown(sessionId);
                throw cause;
            }
            return {
                sessionId,
                ...(session.commit === undefined ? {} : { commit: session.commit }),
                workingDir: WORKING,
                classHosts: SESSION_CLASS_HOSTS,
            };
        },

        async exec(handle: string, command: BuildSessionCommand): Promise<BuildExecResult> {
            const session = sessions.get(handle);
            if (session === undefined) throw new Error(`no build session ${handle}`);
            if (command.plan !== undefined) {
                await stopContainer(session).catch(() => undefined);
                await startContainer(session, sessionEgressAllow(command.plan.hosts));
                session.plan = command.plan;
            }
            const startedAt = Date.now();
            const captured = await execIn(session, { command: command.command, root: command.root === true, workdir: WORKING });
            return {
                execId: command.execId,
                exitCode: captured.code,
                stdout: captured.stdout,
                stderr: captured.stderr,
                timedOut: timedOut(captured.code, Date.now() - startedAt, execTimeout * 1000),
            };
        },

        async commit(handle: string, script: string): Promise<BuildCommitResult> {
            const session = sessions.get(handle);
            if (session === undefined) throw new Error(`no build session ${handle}`);
            // A null analysis is a miswired binding, not a mode: the flight would
            // land a package that no farm extends.
            if (session.analysisId === null) {
                throw new Error(`the commit of session ${handle} has no analysis, thus no farm to extend — a binding that answers no analysis is a binding fault`);
            }
            if (session.plan === undefined) throw new Error(`the commit of session ${handle} needs an approved plan first`);
            const scriptHost = join(session.scratch, SCRIPT_NAME);
            writeFileSync(scriptHost, script);
            const facts = await imageFacts(session);
            const outcome = await (host.fly ?? flySourceBuild)({
                storeRoot,
                analysisId: session.analysisId,
                snapshotHost: join(session.scratch, "src"),
                scriptHost,
                egressAllow: sessionEgressAllow(session.plan.hosts),
                git: session.source.kind === "git" && session.commit !== undefined ? { url: session.source.url, commit: session.commit } : null,
                // The flight row is claimed before the run launches, and the
                // run resolves the metadata version only after it built, thus
                // the qualified source — the qualifier plus the spelling —
                // keys the row.
                pinQualifier: sourceQualifierOf(session),
                sourceSpelling: session.source.kind === "git" ? repoNameOf(session.source.url) : basename(session.source.path),
                aptSnapshotDate: facts.aptSnapshotTimestamp,
                aptPackages: session.plan.aptPackages,
                imageDigests: { provisioner: facts.provisioner, base: facts.base },
            });
            if (outcome.kind === "committed") await teardown(handle);
            return outcome.kind === "committed" ? { kind: "committed", pin: outcome.pin, storeDir: outcome.storeDir } : { kind: "failed", reason: outcome.reason };
        },

        async stop(handle: string): Promise<void> {
            const session = sessions.get(handle);
            if (session !== undefined) {
                await teardown(handle);
                return;
            }
            // A session this process lost (a restart of the host) still names its
            // container, thus the stop removes it as debris.
            const rtResult = await (host.resolveRuntime ?? ensureRuntime)();
            if (rtResult.isOk()) await run(rtResult.value, ["rm", "-f", containerNameOf(handle)]).catch(() => undefined);
        },
    };
}

/** The container name of one session id — derived, so a stop after a host restart still reaches the container. */
function containerNameOf(sessionId: string): string {
    return `inflexa-build-${sessionId}`;
}

/** The hostname of a git URL, which is the one host the exploration wall holds. */
function gitHostOf(url: string): string {
    const host = new URL(url).hostname;
    if (host === "") throw new Error(`the source URL ${url} names no host.`);
    return host;
}

/** The qualified source of a session — `@git:<full sha>` or `@tree:<sha16>` — which keys its flight row before the run resolves the version. */
function sourceQualifierOf(session: LiveSession): string {
    if (session.source.kind === "git") {
        if (session.commit === undefined) throw new Error("a git source holds no resolved commit, thus no qualifier for its flight row.");
        return `@git:${session.commit}`;
    }
    if (session.folderTreeHash === undefined) throw new Error("a folder source holds no tree hash, thus no qualifier for its flight row.");
    return `@tree:${session.folderTreeHash.slice(0, 16)}`;
}

/**
 * Write the `GIT_ASKPASS` helper of the clone: a script that parses the host
 * out of the URL git shows in its prompt and answers the token for the host of
 * the source alone. A prompt of any other host gets no token and a nonzero
 * exit, so git fails that auth instead of leaking the token onward. Readable
 * and runnable by its owner alone.
 */
function writeAskpass(scratch: string, token: string, host: string): string {
    const path = join(scratch, ASKPASS_NAME);
    const script = [
        "#!/bin/sh",
        // The prompt holds the URL in single quotes (`Username for
        // 'https://user@host:port/path':`); the expansions leave the bare
        // hostname in `host`. Each apostrophe of a pattern stays escaped,
        // because an unquoted one would swallow the rest of the line under
        // dash and sh, and the parsed host would keep its quote.
        "url=${1#*\\'}",
        "url=${url%%\\'*}",
        "host=${url#*://}",
        "host=${host#*@}",
        "host=${host%%[:/]*}",
        `[ "$host" = ${shellQuote(host)} ] || exit 1`,
        `printf '%s\\n' ${shellQuote(token)}`,
        "",
    ].join("\n");
    writeFileSync(path, script, { mode: 0o700 });
    return path;
}
