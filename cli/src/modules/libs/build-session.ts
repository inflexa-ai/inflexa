/**
 * The build session of a source install — the CLI realization of the harness
 * `BuildSession` interface behind the `install_from_source` conversation tool.
 *
 * A walled session is TWO held provisioner containers. The WALL container
 * (`inflexa-build-<id>-wall`) holds `NET_ADMIN` and has no mount: its
 * entrypoint override sources the egress-allowlist function of the image,
 * applies the session's list, and then holds. The SESSION container
 * (`inflexa-build-<id>`) joins the network namespace of the wall with
 * `--network container:`, resolves names through the dnsmasq of the wall (its
 * hold command writes the resolver line itself, because the engines differ in
 * what a joined container gets), and holds no `NET_ADMIN`: it drops every
 * capability a root package install does not use, sets `no-new-privileges`,
 * and takes the memory, CPU, and process limits of one sandbox step. Thus no
 * session command can delete the nft rules of the shared namespace, and the
 * PID namespace hides dnsmasq. A folder exploration has no wall: its session
 * container runs with `--network none` and the same flags.
 *
 * The scratch volume lives in a private 0700 directory of its own: the volume
 * itself is 0755 so that the non-root execs traverse it, and the files of an
 * approved private folder are 0644, thus no other user of the host reaches
 * them through the shared temp directory. Every removal path removes that
 * parent.
 *
 * The session container gets no store mount, because the session builds and
 * never installs; one scratch volume holds the pristine snapshot of the source
 * and the working copy the commands mutate, and the pristine snapshot binds
 * READ-ONLY over the volume, so no session user can write the tree the clean
 * run reads. The exploration start walls the git host of the source alone (a
 * folder source gets no network at all); the first command that carries an
 * approved plan restarts both containers under the approved list over the same
 * scratch tree, and a later amended plan restarts them again. Each start —
 * the exploration one and every restart — first removes both names, so a
 * start that a failure left half-made never blocks the retry; a start that
 * fails removes what it made. Each start also pins apt to the dated Ubuntu
 * snapshot of the provisioner image first, so a plain `apt-get update` obeys
 * the pin.
 *
 * The host snapshots the source BEFORE the first command, through one-shot
 * containers over the volume: a clone at the resolved commit for a git source
 * (`ls-remote` answers first for EVERY ref — a hex-looking name can name a
 * branch — and only a ref no remote row answers resolves inside the clone
 * through `rev-parse --verify`, with one fetch for a sha the default branch
 * does not hold; the pin is the commit the checkout lands at, never the
 * tag-object id an annotated tag shows), and a copy of the folder for a local
 * one, hashed over that copy by the provisioner's own `tree_hash` in one short
 * container. The folder copy is an asynchronous walk with a byte budget and an
 * entry limit that refuses a special file. A private repository authenticates through a
 * `GIT_ASKPASS` helper script that lives in the scratch volume at mode 0700,
 * and ONLY an `https` source on `github.com` gets that helper: every other
 * source clones with no credential. The helper answers the token for the host
 * of the source alone — any other host git names fails its auth — and the
 * clone containers name its PATH through plain `-e` flags, the token never
 * appears in an argument or an environment list, and the helper is gone once
 * the clone lands.
 *
 * The approved build script reaches the clean run through a host directory
 * that no session container mounts, so a link that a session command plants in
 * the scratch volume cannot redirect the host write. An abort of the turn
 * stops the command inside the session container (a root scan of `/proc` for
 * the marker argument of the exec), the clone one-shot of an aborted start,
 * and the clean run.
 *
 * Every runner is injectable, so the tests pin the container arguments without
 * an engine.
 */

import { chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";
import PQueue from "p-queue";

import type {
    BuildCommitRequest,
    BuildCommitResult,
    BuildExecResult,
    BuildPlan,
    BuildSession,
    BuildSessionCommand,
    BuildSessionHandle,
    BuildSource,
} from "@inflexa-ai/harness";

import { ensureRuntime } from "../../lib/config.ts";
import { capture, type CaptureOpts, type CaptureResult, type ContainerRuntime, type ContainerRuntimeError } from "../../lib/container.ts";
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

/** The file name of the build script the host writes for the commit, inside a host directory of its own. */
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

/** The capabilities the session container keeps: apt, dpkg, the working-copy `chown`, and the kill of an aborted command use them. `NET_ADMIN` is not among them. */
const SESSION_CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"] as const;

/** The process limit of the session container. A fork storm of a root command stops here, far above the processes of a parallel compile. */
const SESSION_PIDS_LIMIT = 4096;

/** The most bytes of each output stream that an exec keeps (the first half and the last half). It equals the kept-output maximum of the harness, thus nothing the harness can keep is lost. */
const EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/** The marker argument prefix of an exec: `/bin/bash -c <command> inflexa-exec-<execId>` sets `$0`, and the abort scan finds the process by it. */
const EXEC_MARKER_PREFIX = "inflexa-exec-";

/** The most bytes of files that the folder copy reads before it refuses the folder. */
const FOLDER_COPY_BUDGET_BYTES = 2 * 1024 ** 3;

/** The most entries (files, directories, and links) that the folder copy walks before it refuses the folder. The byte budget alone does not bound a tree of empty files. */
const FOLDER_COPY_MAX_ENTRIES = 200_000;

/** The width of the queue of the folder copy, and the size of each read. */
const FOLDER_COPY_WIDTH = 8;
const FOLDER_COPY_CHUNK_BYTES = 64 * 1024;

/** The line the egress-allowlist function prints when the wall is up — the readiness signal of a walled start. */
const WALL_MARKER = "[egress-allowlist] active";

/** How long a start waits for the wall before it refuses. */
const READY_TIMEOUT_MS = 15_000;

/** The egress preamble every walled container command sources before its own work. */
const WALL_PREAMBLE = ". /usr/local/bin/egress-allowlist.sh && apply_egress_allowlist && ";

/** The held entrypoint of the wall container: apply the allowlist the provisioner entrypoint applies, then hold. */
const WALL_HOLD_COMMAND = `${WALL_PREAMBLE}exec sleep infinity`;

/** The held entrypoint of a walled session container: resolve through the dnsmasq of the wall, then hold. The engines differ in the `resolv.conf` that a joined container gets, thus the container writes the line itself. */
const WALLED_SESSION_HOLD_COMMAND = "printf 'nameserver 127.0.0.1\\n' > /etc/resolv.conf && exec sleep infinity";

/** The held entrypoint of a session container with no network. */
const OFFLINE_SESSION_HOLD_COMMAND = "exec sleep infinity";

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
type RuntimeCommand = (rt: ContainerRuntime, args: string[], opts?: CaptureOpts) => Promise<CaptureResult>;

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
    /** The CPU and memory ceilings of the session container. When absent, the session container gets no CPU and no memory flag. */
    readonly limits?: { readonly cpu: number; readonly memoryGb: number };
    /** How long a start waits for the wall before it refuses, in milliseconds. Default: {@link READY_TIMEOUT_MS}. */
    readonly readyTimeoutMs?: number;
    /** The most bytes of files the folder copy reads before it refuses. Default: {@link FOLDER_COPY_BUDGET_BYTES}. */
    readonly folderCopyBudgetBytes?: number;
    /** The most entries the folder copy walks before it refuses. Default: {@link FOLDER_COPY_MAX_ENTRIES}. */
    readonly folderCopyMaxEntries?: number;
};

/** One live session: the container, the scratch tree, and the plan it runs under. */
type LiveSession = {
    readonly rt: ContainerRuntime;
    readonly image: string;
    readonly containerName: string;
    /** The wall container of a walled phase. A folder exploration has none, and `rm -f` of an absent name is a no-op. */
    readonly wallName: string;
    /** The host directory the containers mount at {@link WORK_ROOT}: a 0755 child of `scratchParent`. */
    readonly scratch: string;
    /** The private 0700 directory around the scratch directory. Every removal path removes this one. */
    readonly scratchParent: string;
    readonly source: BuildSource;
    /** The analysis whose farm the commit extends, from the `start` call of the session. */
    readonly analysisId: string | null;
    /** The full commit the host resolved and cloned; set during `start` of a git source. */
    commit?: string;
    /** The tree hash of the pristine copy of a folder source, taken before the first command. */
    folderTreeHash?: string;
    plan?: BuildPlan;
    /** Whether the held container answers: a failed plan restart leaves it false, and the next exec retries the start. */
    containerLive?: boolean;
    /** The host directory of the commit script while a commit runs; the exit sweep removes it. */
    scriptDir?: string;
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

/** The image facts of one walled command's arguments: the container name, the egress preamble, the volume, and the entrypoint override. */
function oneShotArgs(
    rt: ContainerRuntime,
    image: string,
    scratch: string,
    over: { readonly name: string; readonly egressAllow: string | null; readonly command: string; readonly askpass: boolean; readonly writable: boolean },
): string[] {
    return [
        "run",
        "--rm",
        "--name",
        over.name,
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

/** The arguments of the wall container: `NET_ADMIN`, the egress list, and no mount. It joins no network; the session container joins it. */
function wallStartArgs(image: string, wallName: string, egressAllow: string): string[] {
    return [
        "run",
        "-d",
        "--name",
        wallName,
        "--cap-add",
        "NET_ADMIN",
        "-e",
        `INFLEXA_EGRESS_ALLOW=${egressAllow}`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        WALL_HOLD_COMMAND,
    ];
}

/**
 * The hardening flags of every session container: each capability dropped except the install set, no new
 * privileges, and the process limit. The CPU and memory ceilings come from the resource policy of the CLI,
 * and the swap equals the memory so that a fork storm meets the OOM killer instead of thrashing.
 */
function sessionHardeningArgs(limits: BuildSessionHost["limits"]): string[] {
    return [
        "--cap-drop",
        "ALL",
        ...SESSION_CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(SESSION_PIDS_LIMIT),
        ...(limits === undefined
            ? []
            : [
                  "--cpus",
                  String(limits.cpu),
                  "--memory",
                  String(Math.round(limits.memoryGb * 1024 ** 3)),
                  "--memory-swap",
                  String(Math.round(limits.memoryGb * 1024 ** 3)),
              ]),
    ];
}

/**
 * The container arguments of one held session container. `walled` joins the network of the wall container;
 * otherwise the container has no network at all, which is the folder exploration. The pristine snapshot binds
 * read-only over the volume, so no session user writes the tree the clean run reads.
 */
function sessionStartArgs(
    rt: ContainerRuntime,
    image: string,
    session: { readonly containerName: string; readonly wallName: string; readonly scratch: string },
    walled: boolean,
    limits: BuildSessionHost["limits"],
): string[] {
    return [
        "run",
        "-d",
        "--name",
        session.containerName,
        ...(walled ? ["--network", `container:${session.wallName}`] : ["--network", "none"]),
        ...sessionHardeningArgs(limits),
        "-v",
        rt.mountArg(session.scratch, WORK_ROOT),
        "-v",
        rt.mountArgRo(join(session.scratch, "src"), PRISTINE),
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        walled ? WALLED_SESSION_HOLD_COMMAND : OFFLINE_SESSION_HOLD_COMMAND,
    ];
}

/** The arguments of one exec into the session container: a fresh shell, its own timeout, the user rule, and the marker argument that the abort scan finds the process by. */
function sessionExecArgs(
    containerName: string,
    options: { readonly command: string; readonly root?: boolean; readonly timeoutSeconds?: number; readonly workdir?: string; readonly marker?: string },
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
        ...(options.marker === undefined ? [] : [options.marker]),
    ];
}

/**
 * The arguments of the exec that stops an aborted command. Killing the `docker exec` client does not stop
 * the process inside the container, so one root exec walks `/proc/<pid>/cmdline` and sends TERM to each process
 * that holds the marker as an argument. Each argument is compared whole with `[ = ]` in `sh`, thus the scan
 * never matches its own arguments (its command line holds the marker only inside the longer script text),
 * and it needs no `grep` or `procps`. `timeout` forwards TERM to its process group and sends KILL after its
 * grace.
 */
function killExecArgs(containerName: string, marker: string): string[] {
    const script = [
        "for f in /proc/[0-9]*/cmdline; do",
        'pid="${f#/proc/}"; pid="${pid%/cmdline}";',
        `tr '\\0' '\\n' < "$f" 2>/dev/null | while IFS= read -r a; do`,
        `if [ "$a" = ${shellQuote(marker)} ]; then kill -TERM "$pid"; break; fi;`,
        "done;",
        "done",
    ].join(" ");
    return ["exec", "--user", "0", containerName, "/bin/sh", "-c", script];
}

/** Wait until the held container is up and, when it is the wall, until the allowlist reports itself active. An abort ends the wait at the next step and rejects with the abort. */
async function awaitHeld(
    run: RuntimeCommand,
    rt: ContainerRuntime,
    containerName: string,
    walled: boolean,
    readyTimeoutMs: number,
    signal: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    // A command that the abort killed reports the exit code of the kill, thus the abort is checked before its output is read.
    const runChecked = async (args: string[]): Promise<CaptureResult> => {
        const captured = await run(rt, args, { signal });
        signal.throwIfAborted();
        return captured;
    };
    for (;;) {
        signal.throwIfAborted();
        if (walled) {
            const logs = await runChecked(["logs", containerName]);
            if (logs.stdout.includes(WALL_MARKER)) return;
        }
        const inspect = await runChecked(["inspect", "--format", "{{.State.Running}}", containerName]);
        if (inspect.stdout.trim() !== "true") {
            const logs = await runChecked(["logs", containerName]);
            throw new Error(`the build-session container exited at start:\n${`${logs.stdout}\n${logs.stderr}`.trim()}`);
        }
        if (!walled) return;
        if (Date.now() > deadline) {
            const logs = await runChecked(["logs", containerName]);
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
        "dir=/etc/apt/sources.list.d",
        `printf '${format}' "$codename" "$codename" "$codename" "$codename" > "$dir"/${APT_SOURCES_FILE}`,
        `rm -f /etc/apt/sources.list`,
        // Every other entry of sources.list.d dies, the same rule the clean
        // run's pin applies: a base image that ships a live repo must not
        // serve the session builds versions the dated snapshot cannot
        // reproduce.
        `find "$dir" -mindepth 1 -maxdepth 1 ! -name '${APT_SOURCES_FILE}' -exec rm -rf {} +`,
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

// --- The folder copy ------------------------------------------------------------

/** Why the copy of a folder source refused. */
type FolderCopyError =
    | { readonly type: "relative_path"; readonly path: string }
    | { readonly type: "not_directory"; readonly path: string }
    | { readonly type: "special_file"; readonly path: string; readonly kind: string }
    | { readonly type: "too_large"; readonly path: string; readonly limitBytes: number }
    | { readonly type: "too_many_entries"; readonly path: string; readonly limit: number }
    | { readonly type: "aborted" }
    | { readonly type: "io_failed"; readonly path: string; readonly cause: unknown };

/** The sentence a refused folder copy puts in the error of the start. */
function describeFolderCopyError(error: FolderCopyError): string {
    switch (error.type) {
        case "relative_path":
            return `the folder source ${error.path} is a relative path; name an absolute path.`;
        case "not_directory":
            return `the folder source ${error.path} is not a directory.`;
        case "special_file":
            return `the folder holds a ${error.kind} at ${error.path}; the copy takes regular files, directories, and links alone.`;
        case "too_large":
            return `the folder ${error.path} holds more than ${error.limitBytes} bytes of files, which is the limit of a source copy.`;
        case "too_many_entries":
            return `the folder ${error.path} holds more than ${error.limit} entries, which is the limit of a source copy.`;
        case "aborted":
            return "the copy of the folder was aborted.";
        case "io_failed":
            return `could not copy ${error.path}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
        default: {
            const exhaustive: never = error;
            throw new Error(`unhandled folder copy error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The name of a file type that the copy refuses, or `null` for a regular file, a directory, and a link. */
function specialKindOf(stats: { isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): string | null {
    if (stats.isFIFO()) return "FIFO";
    if (stats.isSocket()) return "socket";
    if (stats.isCharacterDevice()) return "character device";
    if (stats.isBlockDevice()) return "block device";
    return null;
}

/**
 * Copy a local folder into the pristine snapshot, off the event loop and under a byte budget.
 *
 * The walk iterates a directory entry by entry with `opendir`, so no directory loads whole, and it counts every
 * entry against an entry limit, because the byte budget does not bound a tree of empty files. It copies the
 * files through a queue of fixed width. A path that `lstat`
 * shows as a FIFO, socket, or device is refused before it opens. A file opens with `O_NOFOLLOW` and
 * `O_NONBLOCK`, and the opened handle is checked again with `fstat`: a swap after the `lstat` (a link, or a
 * FIFO that a writer waits on) can neither be followed nor block the open. The bytes that the copy READS
 * count against the budget, not the sizes that `lstat` shows, because a file can grow while it is read.
 * A symbolic link stays a link and is never followed. The session user is uid 1000, so each directory gets
 * 0755 and each file gets 0755 when any executable bit is set and 0644 otherwise; the tree hash covers the
 * executable bit alone. A refusal or an abort stops the queue and removes the partial copy.
 */
async function copyFolder(
    source: string,
    dest: string,
    signal: AbortSignal,
    limits: { readonly budgetBytes: number; readonly maxEntries: number },
): Promise<Result<void, FolderCopyError>> {
    const budgetBytes = limits.budgetBytes;
    if (!isAbsolute(source)) return err({ type: "relative_path", path: source });
    // An object holder, not a `let`: the closures below set it, and a `let` would narrow to `null` in this scope.
    const state: { failure: FolderCopyError | null } = { failure: null };
    const fail = (error: FolderCopyError): void => {
        state.failure ??= error;
    };
    const stopped = (): boolean => state.failure !== null || signal.aborted;
    try {
        const root = await stat(source);
        if (!root.isDirectory()) return err({ type: "not_directory", path: source });
        const queue = new PQueue({ concurrency: FOLDER_COPY_WIDTH });
        let bytesRead = 0;
        let entries = 0;

        const copyFile = async (from: string, to: string): Promise<void> => {
            if (stopped()) return;
            const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const opened = await input.stat();
                if (!opened.isFile()) {
                    fail({ type: "special_file", path: from, kind: specialKindOf(opened) ?? "non-regular file" });
                    return;
                }
                const mode = (opened.mode & 0o111) === 0 ? 0o644 : 0o755;
                const output = await open(to, "wx", mode);
                try {
                    const buffer = Buffer.allocUnsafe(FOLDER_COPY_CHUNK_BYTES);
                    while (!stopped()) {
                        const { bytesRead: count } = await input.read(buffer, 0, buffer.length, null);
                        if (count === 0) break;
                        bytesRead += count;
                        if (bytesRead > budgetBytes) {
                            fail({ type: "too_large", path: source, limitBytes: budgetBytes });
                            return;
                        }
                        await output.write(buffer, 0, count);
                    }
                } finally {
                    await output.close();
                }
                // The mode of `open` passes through the umask, thus the final mode is set outright.
                await chmod(to, mode);
            } finally {
                await input.close();
            }
        };

        const walk = async (from: string, to: string): Promise<void> => {
            const directory = await opendir(from);
            try {
                for await (const dirent of directory) {
                    if (stopped()) return;
                    entries += 1;
                    if (entries > limits.maxEntries) {
                        fail({ type: "too_many_entries", path: source, limit: limits.maxEntries });
                        return;
                    }
                    const entryFrom = join(from, dirent.name);
                    const entryTo = join(to, dirent.name);
                    const entry = await lstat(entryFrom);
                    if (entry.isSymbolicLink()) {
                        await symlink(await readlink(entryFrom), entryTo);
                    } else if (entry.isDirectory()) {
                        await mkdir(entryTo, { mode: 0o755 });
                        await chmod(entryTo, 0o755);
                        await walk(entryFrom, entryTo);
                    } else if (entry.isFile()) {
                        // The backlog is bounded, so a directory of a million files never queues a million closures.
                        await queue.onSizeLessThan(FOLDER_COPY_WIDTH * 4);
                        void queue.add(async () => {
                            try {
                                await copyFile(entryFrom, entryTo);
                            } catch (cause) {
                                fail({ type: "io_failed", path: entryFrom, cause });
                            }
                        });
                    } else {
                        fail({ type: "special_file", path: entryFrom, kind: specialKindOf(entry) ?? "non-regular file" });
                    }
                }
            } finally {
                // An early return can leave the handle open, and a handle that the iteration closed throws on a second close.
                await directory.close().catch(() => undefined);
            }
        };

        await mkdir(dest, { mode: 0o755 });
        await chmod(dest, 0o755);
        await walk(source, dest).catch((cause: unknown) => fail({ type: "io_failed", path: source, cause }));
        // The queue drains on every path, so no task of the copy outlives the call that removes the partial tree.
        // A stopped copy makes each waiting task return at once.
        await queue.onIdle();
        if (state.failure === null && signal.aborted) fail({ type: "aborted" });
        if (state.failure !== null) {
            await rm(dest, { recursive: true, force: true }).catch(() => undefined);
            return err(state.failure);
        }
        return ok(undefined);
    } catch (cause) {
        await rm(dest, { recursive: true, force: true }).catch(() => undefined);
        return err({ type: "io_failed", path: source, cause });
    }
}

// --- The exit cleanup -----------------------------------------------------------

const liveAtExit = new Map<string, LiveSession>();
let exitCleanupHooked = false;

/** How the exit sweep runs a host command. Default: `Bun.spawnSync`; a test records the command instead. */
export type ExitSweepOpts = {
    readonly spawnSync?: (command: string[]) => void;
};

/**
 * Remove each live session container, private scratch parent, and script directory when the host process
 * dies, so nothing holds a container after it. Exported so a test drives it without an exit.
 */
export function sweepAtExit(opts: ExitSweepOpts = {}): void {
    const spawnSync =
        opts.spawnSync ??
        ((command: string[]): void => {
            Bun.spawnSync(command);
        });
    for (const entry of liveAtExit.values()) {
        try {
            // The session container joins the wall, thus it leaves first.
            spawnSync([entry.rt.bin, "rm", "-f", entry.containerName, entry.wallName]);
        } catch {
            // A dead engine names a host that stopped; the containers are removable as debris.
        }
        for (const path of [entry.scratchParent, entry.scriptDir]) {
            if (path === undefined) continue;
            try {
                rmSync(path, { recursive: true, force: true });
            } catch {
                // The tree is a temp directory the OS reclaims.
            }
        }
    }
    liveAtExit.clear();
}

function registerAtExit(session: LiveSession): void {
    if (!exitCleanupHooked) {
        process.once("exit", () => sweepAtExit());
        exitCleanupHooked = true;
    }
    liveAtExit.set(session.containerName, session);
}

// --- The session ----------------------------------------------------------------

/**
 * The CLI realization of the harness `BuildSession`. Its `start` admits a null
 * analysis beside the interface's string, and the commit refuses that null as
 * a binding fault — a source build never lands with no farm to extend.
 */
export type CliBuildSession = BuildSession & { start(source: BuildSource, analysisId: string | null, signal: AbortSignal): Promise<BuildSessionHandle> };

/**
 * Make the CLI realization of the harness `BuildSession` interface. The
 * analysis id arrives with each `start` call, and the commit extends the farm
 * of that analysis.
 */
export function createBuildSession(storeRoot: string, host: BuildSessionHost = {}): CliBuildSession {
    const run: RuntimeCommand = host.run ?? capture;
    const execTimeout = host.execTimeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    const readyTimeout = host.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const sessions = new Map<string, LiveSession>();

    /** Run one exec in the container of the session and give back the capture. */
    const execIn = async (
        session: LiveSession,
        options: { command: string; root?: boolean; timeoutSeconds?: number; workdir?: string; marker?: string },
        captureOpts?: CaptureOpts,
    ): Promise<CaptureResult> => run(session.rt, sessionExecArgs(session.containerName, options, execTimeout), captureOpts);

    /**
     * Run one walled one-shot container over the scratch volume, and give back the capture. An abort kills
     * the engine client, which leaves the container running, thus the named container is removed and the
     * call rejects with the abort.
     */
    const oneShot = async (
        session: LiveSession,
        over: { readonly name: string; readonly egressAllow: string | null; readonly command: string; readonly askpass: boolean; readonly writable: boolean },
        what: string,
        signal: AbortSignal,
    ): Promise<CaptureResult> => {
        const captured = await run(session.rt, oneShotArgs(session.rt, session.image, session.scratch, over), { signal });
        if (signal.aborted) {
            await run(session.rt, ["rm", "-f", over.name]).catch(() => undefined);
            signal.throwIfAborted();
        }
        if (captured.code !== 0) throw new Error(`could not ${what}:\n${tailOf(captured)}`);
        return captured;
    };

    /** Remove the session container and the wall container. The session leaves first, because it joins the network of the wall. A missing name is no failure. */
    const removeContainers = async (session: LiveSession): Promise<void> => {
        await run(session.rt, ["rm", "-f", session.containerName, session.wallName]).catch(() => undefined);
    };

    /** The digests and the apt snapshot stamp of the pair, read from the engine for the build record and the apt pin. */
    const imageFacts = async (
        session: LiveSession,
        signal: AbortSignal,
    ): Promise<{ readonly provisioner: string; readonly base: string; readonly aptSnapshotTimestamp: string }> => {
        const inspect = async (format: string): Promise<string> => {
            const captured = await run(session.rt, ["image", "inspect", "--format", format, session.image], { signal });
            // A command that the abort killed reports the exit code of the kill, not a fault of the image.
            signal.throwIfAborted();
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

    /**
     * Start the held containers of the session under one egress list, over the same scratch tree, and pin apt
     * to the dated snapshot before any command of the session can run. A walled start makes the wall
     * container first, and the session container joins its network. Both names are removed before the start
     * and after a failure of it, because a container that a failed start left behind would make every retry
     * fail on the name. An abort ends the start at its next step, removes both containers, and rejects with
     * the abort; every runtime command of the start carries the signal.
     */
    const startContainer = async (session: LiveSession, egressAllow: string | null, signal: AbortSignal): Promise<void> => {
        await removeContainers(session);
        try {
            signal.throwIfAborted();
            if (egressAllow !== null) {
                const wall = await run(session.rt, wallStartArgs(session.image, session.wallName, egressAllow), { signal });
                signal.throwIfAborted();
                if (wall.code !== 0) throw new Error(`could not start the egress-wall container:\n${tailOf(wall)}`);
                await awaitHeld(run, session.rt, session.wallName, true, readyTimeout, signal);
            }
            const started = await run(session.rt, sessionStartArgs(session.rt, session.image, session, egressAllow !== null, host.limits), { signal });
            signal.throwIfAborted();
            if (started.code !== 0) throw new Error(`could not start the build-session container:\n${tailOf(started)}`);
            await awaitHeld(run, session.rt, session.containerName, false, readyTimeout, signal);
            const facts = await imageFacts(session, signal);
            const pinned = await execIn(session, { command: aptPinCommand(facts.aptSnapshotTimestamp), root: true }, { signal });
            signal.throwIfAborted();
            if (pinned.code !== 0) throw new Error(`could not pin apt to the snapshot of ${facts.aptSnapshotTimestamp}:\n${tailOf(pinned)}`);
        } catch (cause) {
            await removeContainers(session);
            throw cause;
        }
    };

    /**
     * Remove the scratch tree with its private parent. The session commands ran as the container's
     * root for the host-driven setup steps, thus the tree can hold bytes the
     * host user cannot unlink; one one-shot container over the volume clears
     * them, then the host removes the emptied tree.
     */
    const clearScratch = async (session: LiveSession): Promise<void> => {
        try {
            rmSync(session.scratchParent, { recursive: true, force: true });
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
        rmSync(session.scratchParent, { recursive: true, force: true });
    };

    const teardown = async (sessionId: string): Promise<void> => {
        const session = sessions.get(sessionId);
        if (session !== undefined) {
            sessions.delete(sessionId);
            await removeContainers(session);
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
    const landSource = async (
        session: LiveSession,
        url: string,
        ref: string | undefined,
        gitHost: string,
        askpass: boolean,
        signal: AbortSignal,
    ): Promise<string> => {
        const pattern = ref ?? "HEAD";
        const captured = await oneShot(
            session,
            {
                name: `${session.containerName}-ls`,
                egressAllow: gitHost,
                command: `git ls-remote ${shellQuote(url)} ${shellQuote(pattern)}`,
                askpass,
                writable: false,
            },
            `resolve the source ref of ${url}`,
            signal,
        );
        const row = parseLsRemote(captured.stdout, ref);
        if (row === null && ref === undefined) {
            throw new Error(`the source ${url} holds no default-branch HEAD, thus no commit to build at.`);
        }
        if (row === null) {
            return cloneSource(session, url, { checkout: ref ?? "", resolve: true, gitHost, askpass }, signal);
        }
        // The checkout lands by name and the pin is the HEAD it lands at, never
        // the `ls-remote` sha: an annotated tag's row names its tag object.
        const checkout =
            row.name === "HEAD"
                ? "HEAD"
                : row.name.startsWith("refs/heads/")
                  ? `origin/${row.name.slice("refs/heads/".length)}`
                  : row.name.slice("refs/tags/".length);
        return cloneSource(session, url, { checkout, resolve: false, gitHost, askpass }, signal);
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
        signal: AbortSignal,
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
        const captured = await oneShot(
            session,
            { name: `${session.containerName}-clone`, egressAllow: over.gitHost, command, askpass: over.askpass, writable: true },
            `clone ${url}`,
            signal,
        );
        const landed = captured.stdout.trim().split("\n").at(-1) ?? "";
        if (!FULL_SHA.test(landed)) throw new Error(`the clone of ${url} named no full commit sha:\n${tailOf(captured)}`);
        return landed;
    };

    /** Give the session its working copy of the pristine tree, writable by the non-root user of the execs. */
    const makeWorkingCopy = async (session: LiveSession, signal: AbortSignal): Promise<void> => {
        const captured = await execIn(
            session,
            { command: `cp -a ${shellQuote(PRISTINE)} ${shellQuote(WORKING)} && chown -R ${SESSION_USER} ${shellQuote(WORKING)}`, root: true },
            { signal },
        );
        signal.throwIfAborted();
        if (captured.code !== 0) throw new Error(`could not make the working copy of the source:\n${tailOf(captured)}`);
    };

    /** The tree hash of a folder snapshot, from the provisioner's own function over the copy. */
    const hashSnapshot = async (session: LiveSession, signal: AbortSignal): Promise<string> => {
        const captured = await run(
            session.rt,
            [
                "run",
                "--rm",
                "--name",
                `${session.containerName}-hash`,
                "--network",
                "none",
                "-v",
                session.rt.mountArgRo(join(session.scratch, "src"), "/work/src"),
                "--entrypoint",
                "/usr/bin/python3",
                session.image,
                "-c",
                TREE_HASH_COMMAND,
            ],
            { signal },
        );
        if (signal.aborted) {
            await run(session.rt, ["rm", "-f", `${session.containerName}-hash`]).catch(() => undefined);
            signal.throwIfAborted();
        }
        if (captured.code !== 0 || !/^[0-9a-f]{64}$/.test(captured.stdout.trim())) {
            throw new Error(`could not hash the folder snapshot with the provisioner:\n${tailOf(captured)}`);
        }
        return captured.stdout.trim();
    };

    /** The repository name of a git URL, which names the source flight row the commit claims. */
    const repoNameOf = (url: string): string => {
        const last =
            new URL(url).pathname
                .split("/")
                .filter((part) => part !== "")
                .at(-1) ?? "";
        const name = last.endsWith(".git") ? last.slice(0, -4) : last;
        if (name === "") throw new Error(`the source URL ${url} names no repository, thus no name for its flight row.`);
        return name;
    };

    return {
        async start(source, analysisId: string | null, signal: AbortSignal): Promise<BuildSessionHandle> {
            signal.throwIfAborted();
            const rtResult = await (host.resolveRuntime ?? ensureRuntime)();
            if (rtResult.isErr()) throw new Error(rtResult.error.message);
            const rt = rtResult.value;
            const image = host.provisionerImage ?? provisionerImageFor(configuredSandboxImage());
            const present = await (host.ensureImage ?? ensureImagePresent)(rt, image);
            if (present.isErr()) throw new Error(present.error.message);

            const sessionId = `bs-${randomUUIDv7()}`;
            const gitHost = source.kind === "git" ? gitHostOf(source.url) : null;
            // The parent keeps the 0700 of mkdtemp, and it is the only entry in the shared temp
            // directory. The mounted child is 0755 because the non-root execs must traverse it to
            // reach the working copy, and the folder copy writes files at 0644: the private parent
            // keeps every other host user out of both.
            const scratchParent = mkdtempSync(join(tmpdir(), "inflexa-build-"));
            const scratch = join(scratchParent, "work");
            try {
                mkdirSync(scratch, { mode: 0o755 });
                chmodSync(scratch, 0o755);
            } catch (cause) {
                rmSync(scratchParent, { recursive: true, force: true });
                throw cause;
            }
            const session: LiveSession = {
                rt,
                image,
                containerName: containerNameOf(sessionId),
                wallName: wallNameOf(sessionId),
                scratch,
                scratchParent,
                source,
                analysisId,
            };
            sessions.set(sessionId, session);
            registerAtExit(session);
            try {
                if (source.kind === "git") {
                    // The token rides the clone steps alone: a helper script the
                    // clone containers name by path, never an argument or an
                    // environment list that holds the value. Only an https
                    // GitHub source gets the helper; any other source clones
                    // with no credential.
                    const token = host.hostEnv === undefined ? readEnvCredentialVar("GITHUB_PAT") : host.hostEnv["GITHUB_PAT"];
                    // `gitHost` is the git source's host, non-null inside this branch.
                    const sourceHost = gitHostOf(source.url);
                    const askpassHost =
                        token === undefined || token === "" || !receivesToken(source.url) ? undefined : writeAskpass(session.scratch, token, sourceHost);
                    try {
                        session.commit = await landSource(session, source.url, source.ref, sourceHost, askpassHost !== undefined, signal);
                    } finally {
                        if (askpassHost !== undefined) rmSync(askpassHost, { force: true });
                    }
                } else {
                    const copied = await copyFolder(source.path, join(session.scratch, "src"), signal, {
                        budgetBytes: host.folderCopyBudgetBytes ?? FOLDER_COPY_BUDGET_BYTES,
                        maxEntries: host.folderCopyMaxEntries ?? FOLDER_COPY_MAX_ENTRIES,
                    });
                    if (copied.isErr()) {
                        // An abort rejects with the signal reason, as the other aborted steps do.
                        signal.throwIfAborted();
                        throw new Error(describeFolderCopyError(copied.error));
                    }
                    session.folderTreeHash = await hashSnapshot(session, signal);
                }
                signal.throwIfAborted();
                await startContainer(session, gitHost, signal);
                session.containerLive = true;
                await makeWorkingCopy(session, signal);
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

        async exec(handle: string, command: BuildSessionCommand, signal: AbortSignal): Promise<BuildExecResult> {
            signal.throwIfAborted();
            const session = sessions.get(handle);
            if (session === undefined) throw new Error(`no build session ${handle}`);
            if (command.plan !== undefined) {
                // The plan binds before the restart: a failed restart must not
                // drop the list the user approved, because the tool binds the
                // plan at ask time and resends it unchanged.
                session.plan = command.plan;
                await removeContainers(session);
                session.containerLive = false;
            }
            // A failed restart leaves no container. The next exec retries the
            // start under the approved plan, so a resend recovers instead of
            // execing against a removed container.
            if (session.containerLive !== true && session.plan !== undefined) {
                try {
                    await startContainer(session, sessionEgressAllow(session.plan.hosts), signal);
                    session.containerLive = true;
                } catch (cause) {
                    session.containerLive = false;
                    // An abort removed both containers; the session stays open and the next exec retries the start.
                    signal.throwIfAborted();
                    throw new Error(
                        `the session container is gone and the restart under the approved plan failed (${cause instanceof Error ? cause.message : String(cause)}). Stop the session and start a new one`,
                        { cause },
                    );
                }
            }
            const marker = `${EXEC_MARKER_PREFIX}${command.execId}`;
            const startedAt = Date.now();
            const captured = await execIn(
                session,
                { command: command.command, root: command.root === true, workdir: WORKING, marker },
                { signal, maxBytesPerStream: EXEC_OUTPUT_LIMIT_BYTES },
            );
            if (signal.aborted) {
                // The abort killed the exec client, not the command: the scan stops the command inside the container.
                await run(session.rt, killExecArgs(session.containerName, marker)).catch(() => undefined);
                signal.throwIfAborted();
            }
            return {
                execId: command.execId,
                exitCode: captured.code,
                stdout: captured.stdout,
                stderr: captured.stderr,
                timedOut: timedOut(captured.code, Date.now() - startedAt, execTimeout * 1000),
            };
        },

        async commit(handle: string, request: BuildCommitRequest, signal: AbortSignal): Promise<BuildCommitResult> {
            signal.throwIfAborted();
            const session = sessions.get(handle);
            if (session === undefined) throw new Error(`no build session ${handle}`);
            // A null analysis is a miswired binding, not a mode: the flight would
            // land a package that no farm extends.
            if (session.analysisId === null) {
                throw new Error(
                    `the commit of session ${handle} has no analysis, thus no farm to extend — a binding that answers no analysis is a binding fault`,
                );
            }
            if (session.plan === undefined) throw new Error(`the commit of session ${handle} needs an approved plan first`);
            // The script lives in a host directory that no session container
            // mounts, and it is created with `wx`: a link that a session command
            // planted in the scratch volume cannot redirect this write, and the
            // clean run binds the file read-only.
            const scriptDir = mkdtempSync(join(tmpdir(), "inflexa-build-script-"));
            session.scriptDir = scriptDir;
            const scriptHost = join(scriptDir, SCRIPT_NAME);
            try {
                writeFileSync(scriptHost, request.script, { flag: "wx", mode: 0o644 });
                const facts = await imageFacts(session, signal);
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
                    ...(request.packageDir === undefined ? {} : { packageDir: request.packageDir }),
                    signal,
                });
                if (outcome.kind === "committed") {
                    await teardown(handle);
                    return { kind: "committed", pin: outcome.pin, storeDir: outcome.storeDir };
                }
                // An aborted commit rejects with the abort, and the session stays open.
                signal.throwIfAborted();
                return { kind: "failed", reason: outcome.reason };
            } finally {
                rmSync(scriptDir, { recursive: true, force: true });
                session.scriptDir = undefined;
            }
        },

        async stop(handle: string): Promise<void> {
            const session = sessions.get(handle);
            if (session !== undefined) {
                await teardown(handle);
                return;
            }
            // A session this process lost (a restart of the host) still names its
            // containers, thus the stop removes them as debris.
            const rtResult = await (host.resolveRuntime ?? ensureRuntime)();
            if (rtResult.isOk()) await run(rtResult.value, ["rm", "-f", containerNameOf(handle), wallNameOf(handle)]).catch(() => undefined);
        },
    };
}

/** The container name of one session id — derived, so a stop after a host restart still reaches the container. */
function containerNameOf(sessionId: string): string {
    return `inflexa-build-${sessionId}`;
}

/** The wall container name of one session id. */
function wallNameOf(sessionId: string): string {
    return `${containerNameOf(sessionId)}-wall`;
}

/** The hostname of a git URL, which is the one host the exploration wall holds. */
function gitHostOf(url: string): string {
    const host = new URL(url).hostname;
    if (host === "") throw new Error(`the source URL ${url} names no host.`);
    return host;
}

/**
 * Whether the clone of this source may carry the token: an `https` URL on `github.com` alone. `new URL`
 * folds the case of the host, thus `GitHub.com` counts and a look-alike such as `github.com.evil.example`
 * does not.
 */
function receivesToken(url: string): boolean {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
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
 * the source alone. The caller writes it only for an `https` source on
 * `github.com` (`receivesToken`); the host check here is the second line. A
 * prompt of any other host gets no token and a nonzero exit, so git fails that
 * auth instead of leaking the token onward. Readable and runnable by its
 * owner alone.
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
