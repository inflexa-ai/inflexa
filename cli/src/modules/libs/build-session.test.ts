import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { runtimes, type CaptureResult, type ContainerRuntime } from "../../lib/container.ts";
import { ACQUIRE_EGRESS_ALLOW, SESSION_CLASS_HOSTS, sessionEgressAllow } from "./provisioner.ts";
import { createBuildSession } from "./build-session.ts";
import type { SourceFlightOutcome, SourceFlightParams } from "./store_flight.ts";

// The session module over pinned runners: every container command lands in a
// recorded engine, and the assertions read the recorded arguments. Nothing here
// starts an engine, clones a repository, or touches the store.

const IMAGE = "ghcr.io/inflexa-ai/sandbox-provisioner:test";
const DOCKER = runtimes.docker;

/** The commits of the fixture repository, in the `ls-remote` wire shape. */
const MAIN_SHA = "2fc0c4f6f2bd0f2a1a5ce7e16c8b1f1d0000000a";
const TOPIC_SHA = "abc1111111111111111111111111111111111bbb";
const CAFE_SHA = "def2222222222222222222222222222222222ccc";
/** An annotated tag answers `ls-remote` twice: the tag object, and the peeled commit behind `^{}`. */
const TAG_OBJECT_SHA = "aaa3333333333333333333333333333333333ddd";
const TAG_COMMIT_SHA = "bbb4444444444444444444444444444444444eee";
const REF_ROWS: readonly (readonly [string, string])[] = [
    [MAIN_SHA, "refs/heads/main"],
    [TOPIC_SHA, "refs/heads/topic"],
    [CAFE_SHA, "refs/heads/cafe"],
    [TAG_OBJECT_SHA, "refs/tags/v2.0.0"],
    [TAG_COMMIT_SHA, "refs/tags/v2.0.0^{}"],
    [MAIN_SHA, "HEAD"],
];
const LS_REMOTE = REF_ROWS.map(([sha, name]) => `${sha}\t${name}`).join("\n");

const TREE_HASH = "e".repeat(64);
const TOKEN = "ghp_secret-token";
const CREATED = "2026-02-14T09:30:00Z";
const APT_SNAPSHOT = "20260214T093000Z";
const BASE_DIGEST = `sha256:${"0".repeat(63)}b`;
const BASE_LABEL = `rocker/r-ver:4.6.0@${BASE_DIGEST}`;
const SOURCE = { kind: "git", url: "https://github.com/tacazares/SeedMatchR" } as const;
const PLAN = { hosts: ["snapshot.ubuntu.com", "github.com"], aptPackages: ["libcurl4-openssl-dev"], strategy: "pak lockfile resolve of the local tree" };
const ANALYSIS_ID = "analysis-1";

/** One recorded engine: every runtime command lands here, and each answer is scripted by kind. */
class Engine {
    readonly calls: string[][] = [];
    /** What each askpass-carrying command saw of the helper file, while the clone still held it. */
    readonly askpassSeen: { readonly path: string; readonly content: string; readonly mode: number }[] = [];
    /** The `{{.Created}}` answer of the image inspect — one engine spelling per test. */
    created: string = CREATED;
    /** The base-label answer of the image inspect. */
    baseLabel: string = BASE_LABEL;
    /** When true, each exec of a session command runs its command for real under the recorded `timeout` args, the way the container would. */
    execForReal: boolean = false;

    constructor(private readonly execOutput: { readonly code: number; readonly stdout: string } = { code: 0, stdout: "ran\n" }) {}

    readonly run = async (_rt: ContainerRuntime, args: readonly string[]): Promise<CaptureResult> => {
        const command = [...args];
        this.calls.push(command);
        if (command[0] === "logs") return { code: 0, stdout: "[egress-allowlist] active: github.com (1 host(s) resolve)\n", stderr: "" };
        if (command[0] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
        if (command[0] === "rm") return { code: 0, stdout: "", stderr: "" };
        if (command[0] === "run" && command[1] === "-d") return { code: 0, stdout: "container-id\n", stderr: "" };
        if (command[0] === "image" && command[1] === "inspect") {
            const format = command[3] ?? "";
            if (format === "{{.Id}}") return { code: 0, stdout: "sha256:provisioner\n", stderr: "" };
            if (format.includes("org.opencontainers.image.base.name")) return { code: 0, stdout: `${this.baseLabel}\n`, stderr: "" };
            return { code: 0, stdout: `${this.created}\n`, stderr: "" };
        }
        if (command[0] === "run") {
            const body = command[command.length - 1] ?? "";
            if (command.includes("GIT_ASKPASS=/work/.git-askpass")) {
                const at = command.indexOf("-v");
                const scratch = (command[at + 1] ?? "").split(":")[0] ?? "";
                const path = join(scratch, ".git-askpass");
                if (existsSync(path)) {
                    this.askpassSeen.push({ path, content: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 });
                }
            }
            // The one-shot hash of a folder snapshot: the provisioner module
            // loads through an explicit SourceFileLoader, because the image
            // ships it extensionless.
            if (body.includes("SourceFileLoader")) return { code: 0, stdout: `${TREE_HASH}\n`, stderr: "" };
            if (body.includes("git ls-remote")) return { code: 0, stdout: `${LS_REMOTE}\n`, stderr: "" };
            if (body.includes("git clone")) return { code: 0, stdout: `${this.commitCloneLandsAt(body)}\n`, stderr: "" };
            // The fallback scratch clear of a teardown the host user cannot do.
            if (body.includes("find /work -mindepth 1 -delete")) {
                this.clearScratchHostSide(command);
                return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
        }
        if (command[0] === "exec") {
            const body = command[command.length - 1] ?? "";
            // The host-driven setup execs of the start always succeed — the
            // scripted output belongs to the commands of the session.
            if (body.startsWith("set -e && codename=")) return { code: 0, stdout: "", stderr: "" };
            if (body.startsWith("cp -a ")) return { code: 0, stdout: "", stderr: "" };
            if (this.execForReal) return runUnderTimeout(command);
            return { code: this.execOutput.code, stdout: this.execOutput.stdout, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
    };

    /** The full sha a clone one-shot prints: the commit of what it detaches at, or the ref it verifies. */
    private commitCloneLandsAt(body: string): string {
        const detached = /--detach '([^']+)'/.exec(body);
        if (detached !== null) {
            const target = detached[1] ?? "";
            if (/^[0-9a-f]{40}$/.test(target)) return target;
            if (target === "HEAD") return this.remoteShaOf("HEAD");
            if (target.startsWith("origin/")) return this.remoteShaOf(`refs/heads/${target.slice("origin/".length)}`);
            const peeled = this.remoteShaOf(`refs/tags/${target}^{}`);
            return peeled !== "" ? peeled : this.remoteShaOf(`refs/tags/${target}`);
        }
        const verified = /--verify '([0-9a-f]{4,40})\^\{commit\}'/.exec(body);
        if (verified !== null) {
            const token = verified[1] ?? "";
            return token.length === 40 ? token : (REF_ROWS.find(([sha]) => sha.startsWith(token))?.[0] ?? token);
        }
        return "";
    }

    /** The sha of one `ls-remote` row, by its full name. */
    private remoteShaOf(name: string): string {
        return REF_ROWS.find(([, rowName]) => rowName === name)?.[0] ?? "";
    }

    /** Stand in for the container's root clear, so the host-side retry of the teardown succeeds. */
    private clearScratchHostSide(command: readonly string[]): void {
        const at = command.indexOf("-v");
        const host = (command[at + 1] ?? "").split(":")[0] ?? "";
        if (!existsSync(host)) return;
        for (const entry of readdirSync(host)) chmodSync(join(host, entry), 0o755);
    }

    /** Every recorded call whose first word is `word`, as plain strings. */
    of(word: string): string[][] {
        return this.calls.filter((call) => call[0] === word);
    }

    /** The one-shot `run --rm` calls. */
    oneShots(): string[][] {
        return this.of("run").filter((call) => call[1] === "--rm");
    }

    /** The one `exec` call whose command text starts with `head`. */
    execOf(head: string): string[] {
        return this.of("exec").find((call) => (call[call.length - 1] ?? "").startsWith(head)) ?? [];
    }
}

const SIGNAL_EXITS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** Run one command the way the session's `timeout` does — TERM at the deadline, then KILL one `--kill-after` later — and report the 128+n a reaper gives a signaled command. */
async function runUnderTimeout(args: readonly string[]): Promise<CaptureResult> {
    const at = args.indexOf("timeout");
    const budgetMs = Number(args[at + 3]) * 1000;
    const killAfterMs = Number(args[at + 2]) * 1000;
    const proc = Bun.spawn(["/bin/sh", "-c", args[args.length - 1] ?? ""], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), killAfterMs);
    }, budgetMs);
    await proc.exited;
    clearTimeout(timer);
    const signalExit = SIGNAL_EXITS[proc.signalCode ?? ""] ?? null;
    const code = proc.exitCode ?? (signalExit === null ? -1 : 128 + signalExit);
    return { code, stdout: "", stderr: "" };
}

/** A session host over the recorded engine, with the image and the token pinned. */
function hostOf(engine: Engine, over: Record<string, unknown> = {}) {
    return {
        resolveRuntime: async () => ok(DOCKER),
        run: engine.run,
        provisionerImage: IMAGE,
        ensureImage: async () => ok(undefined),
        hostEnv: { GITHUB_PAT: TOKEN },
        ...over,
    };
}

/** The host path of the scratch tree, read from the one `-v` volume argument of the session start. */
function scratchOf(engine: Engine): string {
    const start = engine.of("run").find((call) => call[1] === "-d") ?? [];
    const volume = start[start.indexOf("-v") + 1] ?? "";
    return volume.split(":")[0] ?? "";
}

const created: string[] = [];

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A local folder source, with one file the hash covers. */
function folderSource(): string {
    const parent = mkdtempSync(join(tmpdir(), "inflexa-src-"));
    created.push(parent);
    const path = join(parent, "mypkg");
    mkdirSync(join(path, "mypkg"), { recursive: true });
    writeFileSync(join(path, "mypkg", "DESCRIPTION"), "Package: mypkg\nVersion: 0.1.0\n");
    return path;
}

describe("sessionEgressAllow", () => {
    test("adds the fixed class hosts — the apt snapshot host beside the index and pak hosts — to the plan's own hosts", () => {
        const allow = sessionEgressAllow(["snapshot.ubuntu.com", "github.com"]);

        expect(allow.split(",")).toEqual(expect.arrayContaining(["snapshot.ubuntu.com", "github.com", "pypi.org", "packagemanager.posit.co", "cran.r-project.org"]));
        // The list stays one of each host, whatever the plan repeats.
        expect(new Set(allow.split(",")).size).toBe(allow.split(",").length);
        expect(sessionEgressAllow([])).toBe(SESSION_CLASS_HOSTS.join(","));
        // The plan's own hosts ride unchanged, and the ask shows the same list the wall carries.
        expect(sessionEgressAllow(["apt.example.org"])).toContain("apt.example.org");
    });
});

describe("the held container", () => {
    test("starts with the entrypoint override, the git host alone, the read-only snapshot, and no store mount", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        const handle = await session.start(SOURCE, ANALYSIS_ID);

        const start = engine.of("run").find((call) => call[1] === "-d") ?? [];
        expect(start).toContain("--name");
        expect(start).toContain(`inflexa-build-${handle.sessionId}`);
        expect(start).toContain("--cap-add");
        const allowAt = start.indexOf("INFLEXA_EGRESS_ALLOW=github.com");
        expect(allowAt).toBeGreaterThan(-1);
        // The exploration wall holds the git host of the source and no other host.
        expect(start.filter((arg) => arg.startsWith("INFLEXA_EGRESS_ALLOW="))).toEqual(["INFLEXA_EGRESS_ALLOW=github.com"]);
        expect(start[start.indexOf("--entrypoint") + 1]).toBe("/bin/sh");
        expect(start[start.length - 2]).toBe("-c");
        expect(start[start.length - 1]).toContain(". /usr/local/bin/egress-allowlist.sh");
        expect(start[start.length - 1]).toContain("apply_egress_allowlist");
        expect(start[start.length - 1]).toContain("exec sleep infinity");
        // The scratch volume is the writable mount, the pristine snapshot binds
        // read-only over it, and the store never mounts.
        const mounts = start.filter((_arg, at) => start[at - 1] === "-v");
        expect(mounts).toHaveLength(2);
        expect(mounts[0]).toMatch(/inflexa-build-\w+:\/work(:z)?$/);
        expect(mounts[1]).toMatch(/inflexa-build-\w+\/src:\/work\/src:ro(,z)?$/);
        expect(start.join(" ")).not.toContain("/mnt/libs");
        // The scratch root is traversable by the non-root execs (0755, not the 0700 of mkdtemp).
        expect(statSync(scratchOf(engine)).mode & 0o777).toBe(0o755);
    });

    test("pins apt to the dated snapshot of the provisioner image at each start, before any command", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        await session.start(SOURCE, ANALYSIS_ID);

        const pin = engine.execOf("set -e && codename=");
        expect(pin).not.toContain("--user");
        expect(pin[pin.length - 1]).toContain(`https://snapshot.ubuntu.com/ubuntu/${APT_SNAPSHOT}/`);
        expect(pin[pin.length - 1]).toContain("Suites: %s %s-updates %s-backports %s-security");
        expect(pin[pin.length - 1]).toContain("rm -f /etc/apt/sources.list");
    });

    test("reads the creation time of both engines — docker's RFC3339 and podman's Go layout — as one snapshot stamp", async () => {
        for (const [created, stamp] of [
            ["2026-02-14T09:30:00Z", APT_SNAPSHOT],
            ["2026-10-19T21:31:56.690123456Z", "20261019T213156Z"],
            ["2026-10-19 21:31:56.69 +0000 UTC", "20261019T213156Z"],
            // Podman prints the zone the time carries, thus an offset normalizes to UTC.
            ["2026-10-19 23:31:56.69 +0200 CEST", "20261019T213156Z"],
        ] as const) {
            const engine = new Engine();
            engine.created = created;
            const session = createBuildSession("/store/root", hostOf(engine));

            await session.start(SOURCE, ANALYSIS_ID);

            const pin = engine.execOf("set -e && codename=");
            expect(pin[pin.length - 1]).toContain(`https://snapshot.ubuntu.com/ubuntu/${stamp}/`);
        }
    });

    test("a creation time neither engine spells refuses the start rather than guessing a snapshot", async () => {
        const engine = new Engine();
        engine.created = "Oct 19, 2026";
        const session = createBuildSession("/store/root", hostOf(engine));

        await expect(session.start(SOURCE, ANALYSIS_ID)).rejects.toThrow("no readable creation time");
    });

    test("a base label without an @sha256: digest refuses the start, because a tag is no digest to record", async () => {
        const engine = new Engine();
        engine.baseLabel = "docker.io/library/ubuntu:noble";
        const session = createBuildSession("/store/root", hostOf(engine));

        await expect(session.start(SOURCE, ANALYSIS_ID)).rejects.toThrow("names no @sha256: digest");
    });

    test("an approval restarts the container under the approved list and pins apt again, over the same scratch", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        await session.exec(handle.sessionId, { command: "cat DESCRIPTION", execId: `${handle.sessionId}-1`, plan: PLAN });

        const starts = engine.of("run").filter((call) => call[1] === "-d");
        expect(starts).toHaveLength(2);
        const [exploration, build] = starts as [string[], string[]];
        // The same scratch volume, and the old container went away first.
        expect(build[build.indexOf("-v") + 1]).toBe(exploration[exploration.indexOf("-v") + 1]);
        expect(engine.of("rm").some((call) => call.includes(`inflexa-build-${handle.sessionId}`))).toBe(true);
        const allow = build.find((arg) => arg.startsWith("INFLEXA_EGRESS_ALLOW=")) ?? "";
        expect(allow).toContain("snapshot.ubuntu.com");
        expect(allow).toContain("github.com");
        expect(allow).toContain("pypi.org");
        expect(allow).toContain("packagemanager.posit.co");
        // The pin ran once per start.
        expect(engine.of("exec").filter((call) => (call[call.length - 1] ?? "").startsWith("set -e && codename="))).toHaveLength(2);
    });

    test("an unchanged plan on a later command restarts nothing", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        await session.exec(handle.sessionId, { command: "cat DESCRIPTION", execId: `${handle.sessionId}-1`, plan: PLAN });
        const startsBefore = engine.of("run").filter((call) => call[1] === "-d").length;

        // The harness tool passes the plan only when it is new or amended, thus a
        // command without one changes nothing.
        await session.exec(handle.sessionId, { command: "ls", execId: `${handle.sessionId}-2` });

        expect(engine.of("run").filter((call) => call[1] === "-d")).toHaveLength(startsBefore);
    });

    test("stop removes the container and the scratch tree", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        const scratch = scratchOf(engine);
        expect(existsSync(scratch)).toBe(true);

        await session.stop(handle.sessionId);

        expect(engine.of("rm").some((call) => call.includes(`inflexa-build-${handle.sessionId}`))).toBe(true);
        expect(existsSync(scratch)).toBe(false);
    });

    test("a scratch the host cannot remove clears through one one-shot container, then goes away", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        const scratch = scratchOf(engine);
        // A directory the host user cannot unlink stands in for the root-owned
        // bytes the container wrote into the volume.
        mkdirSync(join(scratch, "locked"));
        writeFileSync(join(scratch, "locked", "artifact.so"), "bytes");
        chmodSync(join(scratch, "locked"), 0o500);

        await session.stop(handle.sessionId);

        const clear = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("find /work -mindepth 1 -delete")) ?? [];
        expect(clear).toContain("--rm");
        expect(clear[clear.indexOf("-v") + 1]).toContain(scratch);
        expect(existsSync(scratch)).toBe(false);
    });
});

describe("the exec channel", () => {
    test("each command is one exec: a fresh shell, its own timeout, and the non-root user by default", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        await session.exec(handle.sessionId, { command: "cat DESCRIPTION", execId: `${handle.sessionId}-1` });
        await session.exec(handle.sessionId, { command: "R CMD INSTALL .", execId: `${handle.sessionId}-2` });

        const first = engine.execOf("cat DESCRIPTION");
        expect(first).toEqual([
            "exec",
            "--user",
            "1000:1000",
            "--workdir",
            "/work/copy",
            `inflexa-build-${handle.sessionId}`,
            "timeout",
            "--kill-after",
            "5",
            "900",
            "/bin/bash",
            "-c",
            "cat DESCRIPTION",
        ]);
        // The expiry sends TERM first, and the KILL stays bounded behind
        // `--kill-after`; a 137 counts as a timeout only past the deadline
        // plus that grace, because the kill-after KILL cannot fire earlier.
        expect(first).not.toContain("--signal=KILL");
        // The second command is its own exec in its own shell — no state of the first rides it.
        expect(engine.execOf("R CMD INSTALL .")).not.toContain("cat DESCRIPTION");
        // The result reports the exit code of the command.
        const ran = await session.exec(handle.sessionId, { command: "true", execId: `${handle.sessionId}-3` });
        expect(ran).toMatchObject({ execId: `${handle.sessionId}-3`, exitCode: 0, timedOut: false });
    });

    test("a command marked as root drops the user flag, and the timeout exit reads as timed out", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        await session.exec(handle.sessionId, { command: "apt-get update", execId: `${handle.sessionId}-1`, root: true });
        expect(engine.execOf("apt-get update")).not.toContain("--user");

        const timeoutEngine = new Engine({ code: 124, stdout: "" });
        const timeoutSession = createBuildSession("/store/root", hostOf(timeoutEngine));
        const other = await timeoutSession.start(SOURCE, ANALYSIS_ID);
        const timedOut = await timeoutSession.exec(other.sessionId, { command: "sleep 9999", execId: `${other.sessionId}-1` });
        expect(timedOut.timedOut).toBe(true);
        expect(timedOut.exitCode).toBe(124);
    });

    test("exit 137 alone is a failed command, never a timed-out one", async () => {
        const engine = new Engine({ code: 137, stdout: "" });
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        const killed = await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1` });

        expect(killed.exitCode).toBe(137);
        expect(killed.timedOut).toBe(false);
    });

    test("a command that ignores TERM is KILLed past its deadline and reads as timed out", async () => {
        const engine = new Engine();
        engine.execForReal = true;
        const session = createBuildSession("/store/root", hostOf(engine, { execTimeoutSeconds: 1 }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        const killed = await session.exec(handle.sessionId, { command: 'trap "" TERM; sleep 8', execId: `${handle.sessionId}-1` });

        expect(killed.exitCode).toBe(137);
        expect(killed.timedOut).toBe(true);
    }, 15_000);

    test("a 137 that arrives before the deadline — a command that kills itself — is a plain failure", async () => {
        const engine = new Engine();
        engine.execForReal = true;
        const session = createBuildSession("/store/root", hostOf(engine, { execTimeoutSeconds: 1 }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        const killed = await session.exec(handle.sessionId, { command: "kill -9 $$", execId: `${handle.sessionId}-1` });

        expect(killed.exitCode).toBe(137);
        expect(killed.timedOut).toBe(false);
    });

    test("the per-command timeout comes from the host, thus a test or an embedder can bound it", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine, { execTimeoutSeconds: 60 }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1` });

        expect(engine.execOf("make")).toContain("60");
    });
});

describe("the ref resolution and the clone", () => {
    test("a named ref answers one walled one-shot ls-remote, and the clone detaches by name — never by the sha the row shows", async () => {
        for (const [ref, checkout] of [
            ["v2.0.0", "v2.0.0"],
            ["topic", "origin/topic"],
            ["refs/heads/main", "origin/main"],
        ] as const) {
            const engine = new Engine();
            const session = createBuildSession("/store/root", hostOf(engine));
            const handle = await session.start({ kind: "git", url: SOURCE.url, ref }, ANALYSIS_ID);
            const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
            expect(clone[clone.length - 1]).toContain(`checkout --quiet --detach '${checkout}'`);
            // The pin is the HEAD the checkout lands at, read after the detach.
            expect(clone[clone.length - 1]).toContain("sha=$(git -C '/work/src' rev-parse HEAD)");
            expect(clone[clone.length - 1]).toContain(`rm -rf '/work/src/.git'`);
            expect(handle.commit).toMatch(/^[0-9a-f]{40}$/);
        }

        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        expect(handle.commit).toBe(MAIN_SHA);
        expect(handle.workingDir).toBe("/work/copy");
        expect(handle.classHosts).toEqual(SESSION_CLASS_HOSTS);
    });

    test("an annotated tag reports the commit its checkout lands at, never the tag object the ls-remote row shows", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        const handle = await session.start({ kind: "git", url: SOURCE.url, ref: "v2.0.0" }, ANALYSIS_ID);

        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        expect(clone[clone.length - 1]).toContain("checkout --quiet --detach 'v2.0.0'");
        expect(handle.commit).toBe(TAG_COMMIT_SHA);
        expect(handle.commit).not.toBe(TAG_OBJECT_SHA);
    });

    test("a hex-looking branch name resolves through ls-remote first — a bare rev-parse cannot name a remote branch", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        const handle = await session.start({ kind: "git", url: SOURCE.url, ref: "cafe" }, ANALYSIS_ID);

        const lsRemote = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git ls-remote")) ?? [];
        expect(lsRemote[lsRemote.length - 1]).toContain("'cafe'");
        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        expect(clone[clone.length - 1]).toContain("checkout --quiet --detach 'origin/cafe'");
        expect(clone[clone.length - 1]).not.toContain("rev-parse --verify");
        expect(handle.commit).toBe(CAFE_SHA);
    });

    test("a ref no ls-remote row answers resolves inside the clone as a sha: a short sha through rev-parse", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        const handle = await session.start({ kind: "git", url: SOURCE.url, ref: "2fc0c4f" }, ANALYSIS_ID);

        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        expect(clone[clone.length - 1]).toContain(`rev-parse --verify '2fc0c4f^{commit}'`);
        expect(handle.commit).toBe(MAIN_SHA);
    });

    test("a full sha resolves inside the clone too, with one fetch for a sha the clone holds", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));

        const handle = await session.start({ kind: "git", url: SOURCE.url, ref: MAIN_SHA }, ANALYSIS_ID);

        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        expect(clone[clone.length - 1]).toContain(`rev-parse --verify '${MAIN_SHA}^{commit}'`);
        expect(clone[clone.length - 1]).toContain(`fetch --quiet origin '${MAIN_SHA}'`);
        expect(handle.commit).toBe(MAIN_SHA);
    });

    test("the clone runs in a walled one-shot container over the volume, never as an exec of the held session", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        await session.start(SOURCE, ANALYSIS_ID);

        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        expect(clone).toContain("--rm");
        expect(clone).toContain("--cap-add");
        expect(clone).toContain("INFLEXA_EGRESS_ALLOW=github.com");
        expect(clone[clone.indexOf("-v") + 1]).toMatch(/:\/work(:z)?$/);
        // The held container answered no git command at all.
        expect(engine.of("exec").some((call) => (call[call.length - 1] ?? "").includes("git "))).toBe(false);
    });

    test("the working copy is a copy of the read-only snapshot, owned by the user the execs run as", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        await session.start(SOURCE, ANALYSIS_ID);

        const copy = engine.execOf("cp -a");
        expect(copy[copy.length - 1]).toContain("cp -a '/work/src' '/work/copy'");
        expect(copy[copy.length - 1]).toContain("chown -R 1000:1000 '/work/copy'");
    });
});

describe("the token of a private source", () => {
    test("rides a 0700 GIT_ASKPASS helper of the clone containers alone, and never an argument or a later exec", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        // The helper answers the token for the source host alone, and no one
        // but its owner reads or runs it.
        expect(engine.askpassSeen).toHaveLength(2);
        // Both clone steps carried one identical script; the next test runs it.
        expect(new Set(engine.askpassSeen.map((seen) => seen.content)).size).toBe(1);
        for (const seen of engine.askpassSeen) {
            expect(seen.mode).toBe(0o700);
            expect(seen.path.endsWith("/.git-askpass")).toBe(true);
        }
        const lsRemote = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git ls-remote")) ?? [];
        const clone = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("git clone")) ?? [];
        for (const call of [lsRemote, clone]) {
            expect(call).toContain("GIT_ASKPASS=/work/.git-askpass");
            expect(call).toContain("GIT_TERMINAL_PROMPT=0");
        }
        // The helper is gone once the clone lands, and no argument of any command holds the token.
        for (const seen of engine.askpassSeen) expect(existsSync(seen.path)).toBe(false);
        for (const call of engine.calls) expect(call.join(" ")).not.toContain(TOKEN);
        // Every later exec names no askpass at all.
        await session.exec(handle.sessionId, { command: "cat README", execId: `${handle.sessionId}-1` });
        const agent = engine.execOf("cat README");
        expect(agent.join(" ")).not.toContain("GIT_ASKPASS");
    });

    test("a host without the token clones with no askpass at all", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine, { hostEnv: {} }));

        await session.start(SOURCE, ANALYSIS_ID);

        expect(engine.calls.every((call) => !call.includes("GIT_ASKPASS"))).toBe(true);
    });

    test("the generated helper answers the token for the source host alone, and nothing for any other host", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        await session.start(SOURCE, ANALYSIS_ID);
        const generated = engine.askpassSeen[0]?.content;
        expect(generated).toBeDefined();

        const dir = mkdtempSync(join(tmpdir(), "inflexa-askpass-"));
        created.push(dir);
        const helper = join(dir, ".git-askpass");
        writeFileSync(helper, generated ?? "", { mode: 0o700 });
        const ask = (prompt: string): { readonly code: number | null; readonly out: string } => {
            const run = Bun.spawnSync(["/bin/sh", helper, prompt]);
            return { code: run.exitCode, out: run.stdout.toString() };
        };

        const plain = ask("Username for 'https://github.com':");
        expect(plain).toEqual({ code: 0, out: `${TOKEN}\n` });
        const credentialed = ask("Username for 'https://user@github.com:443/tacazares/SeedMatchR.git':");
        expect(credentialed).toEqual({ code: 0, out: `${TOKEN}\n` });

        const other = ask("Username for 'https://gitlab.example.com':");
        expect(other.code).toBe(1);
        expect(other.out).toBe("");
    });
});

describe("a local folder source", () => {
    test("holds no network, copies in, and hashes the copy with the provisioner loaded by file path", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const folder = folderSource();

        const handle = await session.start({ kind: "folder", path: folder }, ANALYSIS_ID);

        // The exploration container has no egress at all: a folder source holds no host.
        const start = engine.of("run").find((call) => call[1] === "-d") ?? [];
        expect(start).toContain("--network");
        expect(start[start.indexOf("--network") + 1]).toBe("none");
        expect(start.some((arg) => arg.startsWith("INFLEXA_EGRESS_ALLOW="))).toBe(false);
        // The original folder never mounts: the host copied it into the scratch.
        expect(engine.calls.every((call) => !call.join(" ").includes(folder))).toBe(true);
        // One short provisioner run hashes the pristine copy; the module ships
        // extensionless, thus the load goes through an explicit SourceFileLoader
        // and never through `import provision`.
        const hashRun = engine.oneShots().find((call) => (call[call.length - 1] ?? "").includes("SourceFileLoader")) ?? [];
        expect(hashRun).toContain("--rm");
        expect(hashRun[hashRun.indexOf("--network") + 1]).toBe("none");
        expect(hashRun[hashRun.indexOf("--entrypoint") + 1]).toBe("/usr/bin/python3");
        expect(hashRun[hashRun.indexOf("-v") + 1]).toMatch(/inflexa-build-\w+\/src:\/work\/src:ro(,z)?$/);
        expect(hashRun[hashRun.length - 1]).toContain("SourceFileLoader('provision', '/usr/local/bin/provision')");
        expect(hashRun[hashRun.length - 1]).not.toContain("import provision");
        expect(handle.commit).toBeUndefined();
        expect(handle.classHosts).toEqual(SESSION_CLASS_HOSTS);
    });
});

describe("the commit", () => {
    /** A flight stub that records its params and the approved script, and answers as scripted. */
    function flightOf(outcome: SourceFlightOutcome = { kind: "committed", pin: "SeedMatchR==2.0.0@git:2fc0c4f", storeDir: "seedmatchr-2.0.0-0000", storeDirs: [] }) {
        const seen: (SourceFlightParams & { readonly script: string })[] = [];
        return {
            seen,
            fly: async (params: SourceFlightParams): Promise<SourceFlightOutcome> => {
                // The scratch tree goes away on a green commit, thus the stub
                // reads the script while it still exists.
                seen.push({ ...params, script: readFileSync(params.scriptHost, "utf8") });
                return outcome;
            },
        };
    }

    test("launches the flight with the approved egress, the snapshot, the script, the base label digest, and the flight-row key", async () => {
        const engine = new Engine();
        const flight = flightOf();
        const session = createBuildSession("/store/root", hostOf(engine, { fly: flight.fly }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1`, plan: PLAN });

        const committed = await session.commit(handle.sessionId, "R CMD INSTALL .\n");

        expect(committed).toEqual({ kind: "committed", pin: "SeedMatchR==2.0.0@git:2fc0c4f", storeDir: "seedmatchr-2.0.0-0000" });
        const params = flight.seen[0];
        expect(params).toMatchObject({
            storeRoot: "/store/root",
            analysisId: ANALYSIS_ID,
            git: { url: SOURCE.url, commit: "2fc0c4f6f2bd0f2a1a5ce7e16c8b1f1d0000000a" },
            // The row is claimed before the run resolves the metadata version,
            // thus the qualified source keys it.
            pinQualifier: "@git:2fc0c4f6f2bd0f2a1a5ce7e16c8b1f1d0000000a",
            sourceSpelling: "SeedMatchR",
            aptSnapshotDate: APT_SNAPSHOT,
            aptPackages: PLAN.aptPackages,
            // The base digest is the label's @sha256: digest, not the sandbox image id.
            imageDigests: { provisioner: "sha256:provisioner", base: BASE_DIGEST },
        });
        expect(params?.egressAllow).toContain("snapshot.ubuntu.com");
        expect(params?.egressAllow).toContain("pypi.org");
        // The clean run reads the pristine snapshot, and the script is the approved bytes.
        expect(params?.snapshotHost).toMatch(/inflexa-build-\w+\/src$/);
        expect(params?.scriptHost).toMatch(/inflexa-build-\w+\/build\.sh$/);
        expect(params?.script).toBe("R CMD INSTALL .\n");
    });

    test("a folder source keys its flight row by the tree qualifier and the folder name", async () => {
        const engine = new Engine();
        const flight = flightOf({ kind: "committed", pin: "mypkg==0.1.0@tree:e5e5e5e5e5e5e5e5", storeDir: "mypkg-0.1.0-0000", storeDirs: [] });
        const session = createBuildSession("/store/root", hostOf(engine, { fly: flight.fly }));
        const folder = folderSource();
        const handle = await session.start({ kind: "folder", path: folder }, ANALYSIS_ID);
        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1`, plan: PLAN });

        await session.commit(handle.sessionId, "R CMD INSTALL .\n");

        expect(flight.seen[0]).toMatchObject({ pinQualifier: `@tree:${TREE_HASH.slice(0, 16)}`, sourceSpelling: "mypkg", git: null });
    });

    test("a green commit ends the session: the container goes away with the scratch tree", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine, { fly: flightOf().fly }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1`, plan: PLAN });

        await session.commit(handle.sessionId, "R CMD INSTALL .\n");

        expect(engine.of("rm").some((call) => call.includes(`inflexa-build-${handle.sessionId}`))).toBe(true);
        await expect(session.exec(handle.sessionId, { command: "ls", execId: `${handle.sessionId}-2` })).rejects.toThrow("no build session");
    });

    test("a failed clean run keeps the session open, container and scratch tree with it", async () => {
        const engine = new Engine();
        const failed: SourceFlightOutcome = { kind: "failed", reason: "resolve: the build script exited non-zero (exit 1)." };
        const session = createBuildSession("/store/root", hostOf(engine, { fly: flightOf(failed).fly }));
        const handle = await session.start(SOURCE, ANALYSIS_ID);
        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1`, plan: PLAN });
        const rmBefore = engine.of("rm").length;

        const outcome = await session.commit(handle.sessionId, "R CMD INSTALL .\n");

        expect(outcome).toEqual({ kind: "failed", reason: "resolve: the build script exited non-zero (exit 1)." });
        // The restart of the build phase removed one container; the failed commit removed none after it.
        expect(engine.of("rm")).toHaveLength(rmBefore);
        // The session still answers: a corrected script commits again.
        const again = await session.commit(handle.sessionId, "R CMD INSTALL . --clean\n");
        expect(again.kind).toBe("failed");
    });

    test("a commit without an approved plan refuses, and the session stays", async () => {
        const engine = new Engine();
        const session = createBuildSession("/store/root", hostOf(engine));
        const handle = await session.start(SOURCE, ANALYSIS_ID);

        await expect(session.commit(handle.sessionId, "make\n")).rejects.toThrow("approved plan");
        const ran = await session.exec(handle.sessionId, { command: "ls", execId: `${handle.sessionId}-1` });
        expect(ran.exitCode).toBe(0);
    });

    test("a binding that answers no analysis refuses the commit, and no flight launches", async () => {
        const engine = new Engine();
        const flight = flightOf();
        const session = createBuildSession("/store/root", hostOf(engine, { fly: flight.fly }));
        const handle = await session.start(SOURCE, null);
        await session.exec(handle.sessionId, { command: "make", execId: `${handle.sessionId}-1`, plan: PLAN });

        await expect(session.commit(handle.sessionId, "R CMD INSTALL .\n")).rejects.toThrow("no analysis");
        expect(flight.seen).toEqual([]);
    });
});
