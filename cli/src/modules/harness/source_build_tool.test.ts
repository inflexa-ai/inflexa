/**
 * Unit tests for `install_from_source` — the four-operation input and the whole
 * ask flow over a stubbed `BuildSession`: the plan ask after exploration, the
 * per-command ask with its session-scoped grant key, the commit ask, the
 * rejections that end a session with no store change, and the exec/commit
 * result semantics (fresh-shell ids, the whole combined output, the
 * retry-in-session path).
 */

import { describe, expect, it } from "bun:test";

import { AskRejectedError, type AgentSession, type AskApproval, type AskRequest, type ToolContext } from "@inflexa-ai/harness";

import { createInstallFromSourceTool } from "./source_build_tool.ts";
import type { BuildCommitRequest, BuildCommitResult, BuildExecResult, BuildSession, BuildSessionCommand, BuildSource } from "../libs/build-session.ts";

const SHA = "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e";
const PIN = `SeedMatchR==2.0.0@git:${SHA}`;
const STORE_DIR = "/pool/seedmatchr-2.0.0-1e2b3d";

const START_ASK_TITLE = "Approve the source-build session";

/** The tool reads only `session.scope.analysisId`, so a cast avoids constructing the full value object. */
function sessionFor(analysisId: string): AgentSession {
    return { scope: { kind: "analysis", analysisId } } as unknown as AgentSession;
}

/** A `ToolContext` for the analysis `analysis-001` whose ask denies every request. */
function makeToolContext(signal?: AbortSignal): ToolContext {
    return {
        invocationId: "test-tool-call",
        session: sessionFor("analysis-001"),
        signal: signal ?? new AbortController().signal,
        emit: () => {},
        ask: () => Promise.reject(new AskRejectedError("denied in test")),
    };
}

/**
 * An `ask` that records each request and plays back a scripted reply per call.
 * The start ask approves itself and stays out of `requests` and `replies`, so a
 * test of the plan, command, and commit asks starts its sessions with no extra
 * script; `recordStartAsks` puts the start ask under the script like any other.
 */
function askRecording(
    replies: readonly ("once" | "always" | "reject")[],
    opts: { readonly recordStartAsks?: boolean; readonly signal?: AbortSignal } = {},
): { requests: AskRequest[]; ctx: ToolContext } {
    const requests: AskRequest[] = [];
    const base = makeToolContext(opts.signal);
    let next = 0;
    const ctx: ToolContext = {
        ...base,
        ask: (request): Promise<AskApproval> => {
            if (request.title === START_ASK_TITLE && opts.recordStartAsks !== true) return Promise.resolve({ kind: "once" });
            requests.push(request);
            const reply = replies[next];
            next += 1;
            if (reply === undefined || reply === "reject") return Promise.reject(new AskRejectedError("denied in test"));
            return Promise.resolve({ kind: reply });
        },
    };
    return { requests, ctx };
}

type StubCall =
    | { readonly op: "start"; readonly source: BuildSource; readonly analysisId: string }
    | { readonly op: "exec"; readonly handle: string; readonly command: BuildSessionCommand }
    | { readonly op: "commit"; readonly handle: string; readonly request: BuildCommitRequest }
    | { readonly op: "stop"; readonly handle: string };

type StubDeps = {
    /** Each started session gets its own id; defaults to `sess-1`, `sess-2`, ... */
    readonly exec?: (command: BuildSessionCommand) => Partial<BuildExecResult>;
    readonly commit?: () => BuildCommitResult;
    /** The fixed hosts of the class that the start of the realization reports; absent stands for a realization that names none. */
    readonly classHosts?: readonly string[];
};

/** A `BuildSession` that records every call, and the signal each long call received, and answers from small scripted results. */
function stubBuildSession(stub: StubDeps = {}): { calls: StubCall[]; signals: Record<"start" | "exec" | "commit", AbortSignal[]>; buildSession: BuildSession } {
    const calls: StubCall[] = [];
    const signals: Record<"start" | "exec" | "commit", AbortSignal[]> = { start: [], exec: [], commit: [] };
    let started = 0;
    const buildSession: BuildSession = {
        start: (source, analysisId, signal) => {
            signals.start.push(signal);
            calls.push({ op: "start", source, analysisId });
            started += 1;
            return Promise.resolve({
                sessionId: `sess-${started}`,
                commit: source.kind === "git" ? SHA : undefined,
                workingDir: "/work/src",
                classHosts: stub.classHosts,
            });
        },
        exec: (handle, command, signal) => {
            signals.exec.push(signal);
            calls.push({ op: "exec", handle, command });
            return Promise.resolve({ execId: command.execId, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...stub.exec?.(command) });
        },
        commit: (handle, request, signal) => {
            signals.commit.push(signal);
            calls.push({ op: "commit", handle, request });
            return Promise.resolve(stub.commit?.() ?? { kind: "committed" as const, pin: PIN, storeDir: STORE_DIR });
        },
        stop: (handle) => {
            calls.push({ op: "stop", handle });
            return Promise.resolve();
        },
    };
    return { calls, signals, buildSession };
}

type ExecInput = Parameters<ReturnType<typeof createInstallFromSourceTool>["execute"]>[0];

const FIRST_BUILD: ExecInput = {
    op: "exec",
    sessionId: "sess-1",
    command: "R CMD build .",
    hosts: ["github.com", "snapshot.ubuntu.com"],
    aptPackages: ["libcurl4-openssl-dev"],
    strategy: "pak lockfile resolve of the local tree",
};

describe("install_from_source — the input schema", () => {
    const tool = createInstallFromSourceTool({ buildSession: stubBuildSession().buildSession });

    it("emits a top-level object schema for the model", () => {
        expect(tool.jsonSchema.type).toBe("object");
    });

    it("parses each valid operation shape", () => {
        expect(tool.inputSchema.safeParse({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR", gitRef: SHA }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ op: "start", folder: "/home/me/localpkg" }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ op: "exec", sessionId: "sess-1", command: "ls", root: true }).success).toBe(true);
        expect(tool.inputSchema.safeParse(FIRST_BUILD).success).toBe(true);
        expect(tool.inputSchema.safeParse({ op: "commit", sessionId: "sess-1", script: "set -e\nR CMD INSTALL ." }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ op: "stop", sessionId: "sess-1" }).success).toBe(true);
    });

    it("refuses a start with no source, and one with both sources", () => {
        expect(tool.inputSchema.safeParse({ op: "start" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: "start", gitUrl: "https://x", folder: "/y" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: "start", folder: "/y", gitRef: "main" }).success).toBe(false);
    });

    it("refuses an op that misses its own key field", () => {
        expect(tool.inputSchema.safeParse({ op: "exec", sessionId: "s" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: "exec", command: "ls" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: "commit", sessionId: "s" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: "stop" }).success).toBe(false);
    });

    it("refuses a partial plan", () => {
        expect(tool.inputSchema.safeParse({ ...FIRST_BUILD, aptPackages: undefined }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ ...FIRST_BUILD, strategy: undefined }).success).toBe(false);
    });

    describe("plan hosts", () => {
        it.each([
            "com",
            "pypi.org/evil.example",
            "10.0.0.1",
            "pypi.org,evil.example",
            "https://pypi.org",
            "pypi.org:443",
            "-bad.example.org",
            "example.org.",
            "a b.org",
        ])("refuses %p before any ask and names the value", (host) => {
            const parsed = tool.inputSchema.safeParse({ ...FIRST_BUILD, hosts: ["github.com", host] });
            expect(parsed.success).toBe(false);
            if (parsed.success) return;
            expect(parsed.error.issues.map((i) => i.message).join("\n")).toContain(`${host.toLowerCase()} is not a host name`);
        });

        it("accepts a host name and gives it in lower case, whatever the case of the input", () => {
            const parsed = tool.inputSchema.safeParse({
                ...FIRST_BUILD,
                hosts: ["PyPI.org", "files.pythonhosted.org", "packagemanager.posit.co", "Snapshot.Ubuntu.com"],
            });
            expect(parsed.success).toBe(true);
            if (!parsed.success) return;
            expect(parsed.data.hosts).toEqual(["pypi.org", "files.pythonhosted.org", "packagemanager.posit.co", "snapshot.ubuntu.com"]);
        });
    });

    describe("the git URL", () => {
        it.each([
            "file:///etc/passwd",
            "ssh://git@github.com/o/r",
            "https://com/o/r",
            "https://10.0.0.1/o/r",
            "https://[::1]/o/r",
            "github.com/o/r",
            "not a url",
        ])("refuses %p", (gitUrl) => {
            const parsed = tool.inputSchema.safeParse({ op: "start", gitUrl });
            expect(parsed.success).toBe(false);
            if (parsed.success) return;
            expect(parsed.error.issues.map((i) => i.message).join("\n")).toContain(`${gitUrl} is not a git URL`);
        });

        it.each(["https://gitlab.com/group/project.git", "http://git.example.org/o/r", "https://GitHub.com/o/r", "https://user@codeberg.org/o/r"])(
            "accepts %p",
            (gitUrl) => {
                expect(tool.inputSchema.safeParse({ op: "start", gitUrl }).success).toBe(true);
            },
        );
    });

    describe("the package directory", () => {
        it.each(["../other", "a/../b", "..", "/abs/path", "\\share\\dir", "C:\\dir", "pkg\\..\\x"])("refuses %p and names the value", (packageDir) => {
            const parsed = tool.inputSchema.safeParse({ op: "commit", sessionId: "sess-1", script: "true", packageDir });
            expect(parsed.success).toBe(false);
            if (parsed.success) return;
            expect(parsed.error.issues.map((i) => i.message).join("\n")).toContain(`${packageDir} is not a directory inside the source tree`);
        });

        it.each(["pkg", "packages/pkg", ".", "my..pkg"])("accepts %p", (packageDir) => {
            expect(tool.inputSchema.safeParse({ op: "commit", sessionId: "sess-1", script: "true", packageDir }).success).toBe(true);
        });
    });
});

describe("install_from_source — the description", () => {
    const description = createInstallFromSourceTool({ buildSession: stubBuildSession().buildSession }).description;

    it("carries the paths discipline of the fresh-shell contract", () => {
        expect(description).toContain("FRESH shell");
        expect(description).toContain("absolute paths");
        expect(description).toContain("`cd <dir> && <command>`");
        expect(description).not.toContain("the tree ROOT must hold the DESCRIPTION");
        expect(description).toContain("the default working directory is the working-copy root");
    });

    it("directs the standard path first, per ecosystem", () => {
        expect(description).toContain("TRY THE STANDARD PATH FIRST");
        expect(description).toContain("pak lockfile resolve");
        expect(description).toContain("wheel build");
        expect(description).toContain("hash-pinned resolve");
    });

    it("takes the identity from the package metadata", () => {
        expect(description).toContain("DESCRIPTION");
        expect(description).toContain("`.dist-info`");
        expect(description).toContain("never ask the user for a version");
    });

    it("states the script contract paths of the clean run", () => {
        expect(description).toContain("READ-ONLY /work/src");
        expect(description).toContain("copies it first");
        expect(description).toContain("/work/out");
    });

    it("tells the agent that a restart keeps /work alone", () => {
        expect(description).toContain("RESTARTS the session container and keeps /work alone");
        expect(description).toContain("each change outside /work is gone");
        expect(description).toContain("install them again");
    });

    it("tells the agent what the clean run installs and as whom it runs", () => {
        expect(description).toContain("installs the apt packages of the plan itself");
        expect(description).toContain("non-root user with no capability");
        expect(description).toContain("no `apt-get` and no root step");
    });

    it("names the package directory for an R package in a subdirectory, and no custom script for it", () => {
        expect(description).toContain("`packageDir`");
        expect(description).toContain("when the DESCRIPTION is not at the tree root");
        expect(description).not.toContain("needs a custom script that builds from there");
    });

    it("tells the agent that each start asks the user", () => {
        expect(description).toContain("the user approves each start");
    });

    it("carries the stop rule and the excerpt note", () => {
        expect(description).toContain("STOP the session");
        expect(description).toContain("when the build is done or the user refuses to continue");
        expect(description).toContain("read_tool_output");
    });
});

describe("install_from_source — start", () => {
    it("starts the exploration phase and reports the resolved source", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);

        const result = (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR", gitRef: SHA }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({
            status: "started",
            sessionId: "sess-1",
            source: `https://github.com/tacazares/SeedMatchR (ref ${SHA}) at commit ${SHA}`,
            commit: SHA,
            workingDir: "/work/src",
        });
        if (result.status !== "started") throw new Error("expected a started result");
        expect(result.note).toContain("exploration phase");
        expect(stub.calls).toEqual([
            { op: "start", source: { kind: "git", url: "https://github.com/tacazares/SeedMatchR", ref: SHA }, analysisId: "analysis-001" },
        ]);
    });

    it("start carries the analysis id of the conversation session, so the commit extends the farm of that analysis", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const ctx: ToolContext = { ...askRecording([]).ctx, session: sessionFor("analysis-7f") };

        const result = (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("started");
        expect(stub.calls).toEqual([{ op: "start", source: { kind: "git", url: "https://github.com/tacazares/SeedMatchR" }, analysisId: "analysis-7f" }]);
    });

    it("a folder source starts with no commit", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);

        const result = (await tool.execute({ op: "start", folder: "/home/me/localpkg" }, ctx))._unsafeUnwrap();

        if (result.status !== "started") throw new Error("expected a started result");
        expect(result.commit).toBeUndefined();
    });

    it("a folder start asks with the path and says that the session reads the whole folder, before any read", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once"], { recordStartAsks: true });

        const result = (await tool.execute({ op: "start", folder: "/Users/me/.ssh" }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("started");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.title).toBe(START_ASK_TITLE);
        expect(requests[0]?.command).toContain("/Users/me/.ssh");
        expect(requests[0]?.detail).toContain("/Users/me/.ssh");
        expect(requests[0]?.detail).toContain("whole folder");
        expect(requests[0]?.grantKey).toBeUndefined();
    });

    it("a rejected folder start rethrows, calls no start, and leaves no session", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording(["reject"], { recordStartAsks: true });

        await expect(tool.execute({ op: "start", folder: "/Users/me/.ssh" }, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(stub.calls).toEqual([]);
        const after = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, askRecording([]).ctx))._unsafeUnwrap();
        expect(after).toEqual({ status: "unknown_session", sessionId: "sess-1" });
    });

    it("a git start asks with the URL and the ref, before the clone", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once"], { recordStartAsks: true });

        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR", gitRef: "v2.0.0" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        expect(requests[0]?.detail).toContain("https://github.com/tacazares/SeedMatchR");
        expect(requests[0]?.detail).toContain("ref v2.0.0");
        expect(requests[1]?.detail).toContain("head of the default branch");
    });

    it("a rejected git start rethrows, calls no start, and leaves no session", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["reject"], { recordStartAsks: true });

        await expect(tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(requests).toHaveLength(1);
        expect(stub.calls).toEqual([]);
    });

    it("start, exec, and commit receive the abort signal of the tool context", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const controller = new AbortController();
        const { ctx } = askRecording(["once", "once", "once"], { signal: controller.signal });

        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx))._unsafeUnwrap();

        expect(stub.signals.start).toEqual([controller.signal]);
        expect(stub.signals.exec).toEqual([controller.signal]);
        expect(stub.signals.commit).toEqual([controller.signal]);
    });

    it("an aborted exec answers failed with the reason, and the session stays open", async () => {
        const inner = stubBuildSession();
        const controller = new AbortController();
        const buildSession: BuildSession = {
            ...inner.buildSession,
            exec: (_handle, _command, signal) =>
                new Promise((_resolve, reject) => {
                    if (signal.aborted) reject(new Error("the turn was canceled"));
                    signal.addEventListener("abort", () => reject(new Error("the turn was canceled")));
                }),
        };
        const tool = createInstallFromSourceTool({ buildSession });
        const { ctx } = askRecording([], { signal: controller.signal });
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const pending = tool.execute({ op: "exec", sessionId: "sess-1", command: "sleep 600" }, ctx);
        controller.abort();
        const result = (await pending)._unsafeUnwrap();

        expect(result).toEqual({ status: "failed", reason: "the turn was canceled" });
        const stopped = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(stopped).toEqual({ status: "stopped", sessionId: "sess-1" });
    });

    it("a failed start answers failed with the reason, and no session exists", async () => {
        const buildSession: BuildSession = {
            ...stubBuildSession().buildSession,
            start: () => Promise.reject(new Error("clone failed: repository not found")),
        };
        const tool = createInstallFromSourceTool({ buildSession });
        const { ctx } = askRecording([]);

        const result = (await tool.execute({ op: "start", gitUrl: "https://github.com/nope" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ status: "failed", reason: "clone failed: repository not found" });
        const after = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx))._unsafeUnwrap();
        expect(after).toEqual({ status: "unknown_session", sessionId: "sess-1" });
    });
});

describe("install_from_source — the ask flow", () => {
    it("an exploration exec runs with no ask", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["reject"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "cat DESCRIPTION" }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        expect(requests).toEqual([]);
        const last = stub.calls.at(-1);
        expect(last).toMatchObject({ op: "exec", handle: "sess-1", command: { command: "cat DESCRIPTION" } });
        if (last?.op !== "exec") throw new Error("expected an exec call");
        expect(last.command.plan).toBeUndefined();
    });

    it("the first build command asks the plan, then the command, and the plan names source, commit, hosts, apt, strategy", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        expect(requests).toHaveLength(2);
        const [planAsk, commandAsk] = requests;
        expect(planAsk?.title).toBe("Approve the source-build plan");
        expect(planAsk?.command).toContain("https://github.com/tacazares/SeedMatchR");
        expect(planAsk?.detail).toContain(SHA);
        expect(planAsk?.detail).toContain("github.com, snapshot.ubuntu.com");
        expect(planAsk?.detail).toContain("libcurl4-openssl-dev");
        expect(planAsk?.detail).toContain("pak lockfile resolve of the local tree");
        expect(commandAsk?.command).toBe("R CMD build .");
        expect(commandAsk?.grantKey).toBe("install_from_source:sess-1");
        expect(stub.calls.at(-1)).toMatchObject({ op: "exec", command: { plan: { hosts: ["github.com", "snapshot.ubuntu.com"] } } });
    });

    it("later build commands ask the command alone, under the same session-scoped grant key", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();

        (await tool.execute({ op: "exec", sessionId: "sess-1", command: "R CMD INSTALL --library=/work/out ." }, ctx))._unsafeUnwrap();

        expect(requests).toHaveLength(3);
        expect(requests.at(-1)?.title).toBe("Run build-session command");
        expect(requests.at(-1)?.grantKey).toBe("install_from_source:sess-1");
    });

    it("the grant key holds the session id, so an always never crosses sessions", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "start", gitUrl: "https://github.com/other/pkg" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        (await tool.execute({ ...FIRST_BUILD, sessionId: "sess-2" }, ctx))._unsafeUnwrap();

        const keys = requests.filter((r) => r.title === "Run build-session command").map((r) => r.grantKey);
        expect(keys).toEqual(["install_from_source:sess-1", "install_from_source:sess-2"]);
    });

    it("a root exec says so in its ask, and a plain exec does not", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        requests.length = 0;

        (await tool.execute({ op: "exec", sessionId: "sess-1", command: "apt-get update", root: true }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx))._unsafeUnwrap();

        expect(requests[0]?.detail).toContain("runs as root");
        expect(requests[1]?.detail).not.toContain("runs as root");
        expect(stub.calls.filter((c) => c.op === "exec").at(-2)).toMatchObject({ command: { root: true } });
    });

    it("the plan ask shows the COMPLETE host list the session will carry: the plan's hosts beside the fixed hosts of the class", async () => {
        const stub = stubBuildSession({ classHosts: ["snapshot.ubuntu.com", "pypi.org", "packagemanager.posit.co"] });
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ ...FIRST_BUILD, hosts: ["github.com"] }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        const [planAsk] = requests;
        expect(planAsk?.detail).toContain("Egress hosts of the session: github.com, snapshot.ubuntu.com, pypi.org, packagemanager.posit.co");
        // The plan the realization receives carries the same complete list, so the
        // wall it builds equals the list the user approved.
        expect(stub.calls.at(-1)).toMatchObject({
            op: "exec",
            command: { plan: { hosts: ["github.com", "snapshot.ubuntu.com", "pypi.org", "packagemanager.posit.co"] } },
        });
    });

    it("an exploration exec with the root marker refuses and points at the plan approval", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "apt-get update", root: true }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ status: "plan_required", sessionId: "sess-1" });
        if (result.status !== "plan_required") throw new Error("expected a plan_required result");
        expect(result.note).toContain("Root is a build-phase capability");
        expect(result.note).toContain("Approve the plan first");
        // No command reached the session, and nothing asked.
        expect(stub.calls.filter((c) => c.op === "exec")).toEqual([]);
        expect(requests).toEqual([]);
    });

    it("a root exec that carries the plan fields proceeds to the plan ask — the first build command is usually a root apt-get", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ ...FIRST_BUILD, command: "apt-get update", root: true }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        expect(requests[0]?.title).toBe("Approve the source-build plan");
        expect(requests[1]?.title).toBe("Run build-session command");
        expect(requests[1]?.detail).toContain("runs as root");
        expect(stub.calls.at(-1)).toMatchObject({ op: "exec", command: { command: "apt-get update", root: true } });
    });

    it("a wall failure routes through an amended plan ask that names the wider list", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();

        const amended = await tool.execute(
            { ...FIRST_BUILD, command: "curl https://apt.example.org/key", hosts: [...(FIRST_BUILD.hosts ?? []), "apt.example.org"] },
            ctx,
        );

        expect(amended._unsafeUnwrap().status).toBe("ran");
        expect(requests.at(-2)?.title).toBe("Approve the amended source-build plan");
        expect(requests.at(-2)?.detail).toContain("apt.example.org");
        expect(stub.calls.at(-1)).toMatchObject({
            op: "exec",
            command: { plan: { hosts: ["github.com", "snapshot.ubuntu.com", "apt.example.org"] } },
        });
    });

    it("a resent unchanged plan asks nothing and rides no exec", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        const asksBefore = requests.length;
        const execsBefore = stub.calls.filter((c) => c.op === "exec").length;

        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();

        expect(requests).toHaveLength(asksBefore + 1);
        expect(requests.at(-1)?.title).toBe("Run build-session command");
        expect(stub.calls.filter((c) => c.op === "exec")).toHaveLength(execsBefore + 1);
        const last = stub.calls.filter((c) => c.op === "exec").at(-1);
        if (last?.op !== "exec") throw new Error("expected an exec call");
        expect(last.command.plan).toBeUndefined();
    });
});

describe("install_from_source — rejections end the session with no store change", () => {
    it("a rejected plan stops the session, and the id answers session_ended", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording(["once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        await expect(tool.execute(FIRST_BUILD, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
        const after = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, askRecording([]).ctx))._unsafeUnwrap();
        expect(after).toEqual({ status: "session_ended", sessionId: "sess-1" });
    });

    it("a rejected command stops the session and commits nothing", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "reject"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        await expect(tool.execute(FIRST_BUILD, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(requests.map((r) => r.title)).toEqual(["Approve the source-build plan", "Run build-session command"]);
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });
    });

    it("a rejected commit stops the session and the clean run never starts", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "reject"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();

        await expect(tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(requests.at(-1)?.title).toBe("Approve the source-build commit");
        expect(requests.at(-1)?.detail).toContain("R CMD INSTALL .");
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });
    });
});

describe("install_from_source — an abort during an ask keeps the session", () => {
    const cancel = new Error("turn cancelled");

    /** A context whose ask of the named title rejects with the abort reason, as a cancel of a pending ask does; every other ask is approved once. */
    function askAbortingAt(title: string): ToolContext {
        const base = askRecording([]).ctx;
        return { ...base, ask: (request) => (request.title === title ? Promise.reject(cancel) : Promise.resolve({ kind: "once" })) };
    }

    const cases: ReadonlyArray<{ readonly name: string; readonly title: string; readonly prepare: "none" | "plan"; readonly call: ExecInput }> = [
        { name: "the plan ask", title: "Approve the source-build plan", prepare: "none", call: FIRST_BUILD },
        { name: "the command ask", title: "Run build-session command", prepare: "plan", call: { op: "exec", sessionId: "sess-1", command: "make" } },
        {
            name: "the commit ask",
            title: "Approve the source-build commit",
            prepare: "plan",
            call: { op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." },
        },
    ];

    for (const entry of cases) {
        it(`an abort of ${entry.name} rethrows the reason, stops nothing, and a later exec on the session still runs`, async () => {
            const stub = stubBuildSession();
            const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
            const approving: ToolContext = { ...askRecording([]).ctx, ask: () => Promise.resolve({ kind: "once" }) };
            (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, approving))._unsafeUnwrap();
            if (entry.prepare === "plan") (await tool.execute(FIRST_BUILD, approving))._unsafeUnwrap();

            await expect(tool.execute(entry.call, askAbortingAt(entry.title))).rejects.toBe(cancel);

            expect(stub.calls.some((c) => c.op === "stop")).toBe(false);
            const execsBefore = stub.calls.filter((c) => c.op === "exec").length;
            const later = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, approving))._unsafeUnwrap();
            expect(later.status).toBe("ran");
            expect(stub.calls.filter((c) => c.op === "exec")).toHaveLength(execsBefore + 1);
        });
    }
});

describe("install_from_source — exec semantics", () => {
    it("each exec derives its id from the session id and a per-session sequence", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "start", gitUrl: "https://github.com/other/pkg" }, ctx))._unsafeUnwrap();

        (await tool.execute({ op: "exec", sessionId: "sess-1", command: "cat DESCRIPTION" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "exec", sessionId: "sess-2", command: "cat README" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx))._unsafeUnwrap();

        const execIds = stub.calls.filter((c) => c.op === "exec").map((c) => c.command.execId);
        expect(execIds).toEqual(["sess-1-1", "sess-2-1", "sess-1-2"]);
    });

    it("an exec returns the whole combined output past the tool-result cap, with no kept reference", async () => {
        const long = "x".repeat(64 * 1024);
        const full = `${long}\n--- stderr ---\ntail error`;
        const stub = stubBuildSession({ exec: () => ({ stdout: long, stderr: "tail error" }) });
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "make" }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ status: "ran", execId: "sess-1-1", exitCode: 0, timedOut: false });
        if (result.status !== "ran") throw new Error("expected a ran result");
        expect(result.output).toBe(full);
        expect(result.output.length).toBeGreaterThan(32768);
        expect("kept" in result).toBe(false);
    });
});

describe("install_from_source — commit semantics", () => {
    async function sessionInBuildPhase(tool: ReturnType<typeof createInstallFromSourceTool>) {
        // The third "once" is the commit ask of the caller's test.
        const { requests, ctx } = askRecording(["once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        return { requests, ctx };
    }

    it("a commit before any plan refuses with the plan direction and no clean run", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ status: "plan_required", sessionId: "sess-1" });
        if (result.status !== "plan_required") throw new Error("expected a plan_required result");
        expect(result.note).toContain("hosts");
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
    });

    it("an approved commit runs once, reports the qualified pin, and ends the session", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = await sessionInBuildPhase(tool);

        const result = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL --library=/work/out ." }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ status: "committed", pin: PIN, storeDir: STORE_DIR });
        if (result.status !== "committed") throw new Error("expected a committed result");
        expect(typeof result.note).toBe("string");
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([
            { op: "commit", handle: "sess-1", request: { script: "R CMD INSTALL --library=/work/out ." } },
        ]);
        const after = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, askRecording([]).ctx))._unsafeUnwrap();
        expect(after).toEqual({ status: "session_ended", sessionId: "sess-1" });
    });

    it("a failed clean run returns to the same session for a corrected script", async () => {
        let commitAttempts = 0;
        const stub = stubBuildSession({
            commit: () =>
                commitAttempts === 0 ? { kind: "failed", reason: "the script installs no artifact" } : { kind: "committed", pin: PIN, storeDir: STORE_DIR },
        });
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const first = await sessionInBuildPhase(tool);

        const failed = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "bad script" }, first.ctx))._unsafeUnwrap();
        expect(failed).toMatchObject({ status: "clean_run_failed", sessionId: "sess-1", reason: "the script installs no artifact" });
        if (failed.status !== "clean_run_failed") throw new Error("expected a clean_run_failed result");
        expect(failed.note).toContain("same session");

        // The session stays open: an exec still asks and still runs.
        const { requests, ctx } = askRecording(["once"]);
        const exec = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "R CMD INSTALL --library=/work/out ." }, ctx))._unsafeUnwrap();
        expect(exec.status).toBe("ran");
        expect(requests.map((r) => r.title)).toEqual(["Run build-session command"]);

        const second = askRecording(["once"]);
        commitAttempts += 1;
        const committed = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "fixed script" }, second.ctx))._unsafeUnwrap();
        expect(committed).toMatchObject({ status: "committed", pin: PIN, storeDir: STORE_DIR });
        if (committed.status !== "committed") throw new Error("expected a committed result");
        expect(typeof committed.note).toBe("string");
        expect(stub.calls.filter((c) => c.op === "stop")).toEqual([]);
    });

    it("the request carries the package directory, and the ask shows it", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = await sessionInBuildPhase(tool);

        (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL .", packageDir: "pkg" }, ctx))._unsafeUnwrap();

        expect(requests.at(-1)?.title).toBe("Approve the source-build commit");
        expect(requests.at(-1)?.detail).toContain("Package directory: pkg");
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([
            { op: "commit", handle: "sess-1", request: { script: "R CMD INSTALL .", packageDir: "pkg" } },
        ]);
    });

    it("a commit with no package directory shows none in the ask and sends none", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = await sessionInBuildPhase(tool);

        (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx))._unsafeUnwrap();

        expect(requests.at(-1)?.detail).not.toContain("Package directory");
        const commit = stub.calls.find((c) => c.op === "commit");
        if (commit?.op !== "commit") throw new Error("expected a commit call");
        expect(commit.request).toEqual({ script: "R CMD INSTALL ." });
        expect("packageDir" in commit.request).toBe(false);
    });

    it("stop removes the container and the id answers session_ended", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const stopped = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(stopped).toEqual({ status: "stopped", sessionId: "sess-1" });
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });

        const again = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(again).toEqual({ status: "session_ended", sessionId: "sess-1" });
        const unknown = (await tool.execute({ op: "stop", sessionId: "nope" }, ctx))._unsafeUnwrap();
        expect(unknown).toEqual({ status: "unknown_session", sessionId: "nope" });
    });
});

describe("install_from_source — a live engine throw", () => {
    it("a thrown exec answers failed and names the cause", async () => {
        const inner = stubBuildSession();
        const failFirst = { on: true };
        const buildSession: BuildSession = {
            ...inner.buildSession,
            exec: (handle, command, signal) => (failFirst.on ? Promise.reject(new Error("engine gone")) : inner.buildSession.exec(handle, command, signal)),
        };
        const tool = createInstallFromSourceTool({ buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("failed");
        if (result.status === "failed") expect(result.reason).toContain("engine gone");
        // The session survives the throw: a later exec reaches the engine again.
        failFirst.on = false;
        const retried = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx))._unsafeUnwrap();
        expect(retried.status).toBe("ran");
    });

    it("a thrown commit answers failed, and the session stays open for a retry", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording(["once", "once", "once", "once"]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute(FIRST_BUILD, ctx))._unsafeUnwrap();
        stub.buildSession.commit = () => Promise.reject(new Error("store write lost"));

        const result = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("failed");
        if (result.status === "failed") expect(result.reason).toContain("store write lost");

        stub.buildSession.commit = () => Promise.resolve({ kind: "committed" as const, pin: PIN, storeDir: STORE_DIR });
        const retried = (await tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx))._unsafeUnwrap();
        expect(retried.status).toBe("committed");
    });

    it("a thrown stop answers failed and leaves the session stoppable again", async () => {
        const stub = stubBuildSession();
        stub.buildSession.stop = () => Promise.reject(new Error("engine gone"));
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const result = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(result.status).toBe("failed");

        stub.buildSession.stop = () => Promise.resolve();
        const again = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(again).toEqual({ status: "stopped", sessionId: "sess-1" });
    });
});

/** A promise whose settlement the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: Error) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let every continuation that waits on an already settled promise run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** A gate that a test opens by hand. */
function gate(): { promise: Promise<unknown>; open: () => void } {
    const d = deferred<true>();
    return { promise: d.promise, open: () => d.resolve(true) };
}

describe("install_from_source — one lock for each session", () => {
    /** A stub whose exec holds each call until the test releases it, and records the order of starts and ends. */
    function gatedSession() {
        const inner = stubBuildSession();
        const events: string[] = [];
        const gates = new Map<string, ReturnType<typeof gate>>();
        const buildSession: BuildSession = {
            ...inner.buildSession,
            exec: async (handle, command, signal) => {
                events.push(`start ${command.command}`);
                const held = gate();
                gates.set(command.command, held);
                await held.promise;
                events.push(`end ${command.command}`);
                return inner.buildSession.exec(handle, command, signal);
            },
        };
        return { inner, events, gates, buildSession };
    }

    it("two calls on one session run in sequence", async () => {
        const g = gatedSession();
        const tool = createInstallFromSourceTool({ buildSession: g.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const first = tool.execute({ op: "exec", sessionId: "sess-1", command: "first" }, ctx);
        const second = tool.execute({ op: "exec", sessionId: "sess-1", command: "second" }, ctx);
        await settle();
        expect(g.events).toEqual(["start first"]);

        g.gates.get("first")?.open();
        await settle();
        expect(g.events).toEqual(["start first", "end first", "start second"]);

        g.gates.get("second")?.open();
        expect((await first)._unsafeUnwrap().status).toBe("ran");
        expect((await second)._unsafeUnwrap().status).toBe("ran");
        expect(g.events).toEqual(["start first", "end first", "start second", "end second"]);
    });

    it("calls on two sessions do not wait for each other", async () => {
        const g = gatedSession();
        const tool = createInstallFromSourceTool({ buildSession: g.buildSession });
        const { ctx } = askRecording([]);
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();
        (await tool.execute({ op: "start", gitUrl: "https://github.com/other/pkg" }, ctx))._unsafeUnwrap();

        const one = tool.execute({ op: "exec", sessionId: "sess-1", command: "one" }, ctx);
        const two = tool.execute({ op: "exec", sessionId: "sess-2", command: "two" }, ctx);
        await settle();

        expect(g.events).toEqual(["start one", "start two"]);
        g.gates.get("two")?.open();
        g.gates.get("one")?.open();
        await Promise.all([one, two]);
    });

    it("a call waits for the ask of the earlier call on its session, and a stop waits for a running exec", async () => {
        const g = gatedSession();
        const tool = createInstallFromSourceTool({ buildSession: g.buildSession });
        const askGate = deferred<AskApproval>();
        const asked: string[] = [];
        const base = askRecording([]).ctx;
        const ctx: ToolContext = {
            ...base,
            ask: (request) => {
                asked.push(request.title);
                return request.title === "Approve the source-build plan" ? askGate.promise : Promise.resolve({ kind: "once" });
            },
        };
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const planCall = tool.execute({ ...FIRST_BUILD, command: "build" }, ctx);
        const exploration = tool.execute({ op: "exec", sessionId: "sess-1", command: "later" }, ctx);
        await settle();
        expect(asked).toContain("Approve the source-build plan");
        expect(g.events).toEqual([]);

        askGate.resolve({ kind: "once" });
        await settle();
        expect(g.events).toEqual(["start build"]);

        const stop = tool.execute({ op: "stop", sessionId: "sess-1" }, ctx);
        await settle();
        expect(g.inner.calls.some((c) => c.op === "stop")).toBe(false);

        g.gates.get("build")?.open();
        await settle();
        g.gates.get("later")?.open();
        await Promise.all([planCall, exploration]);
        expect((await stop)._unsafeUnwrap()).toEqual({ status: "stopped", sessionId: "sess-1" });
        expect(g.events).toEqual(["start build", "end build", "start later", "end later"]);
    });

    it("a call queued behind a rejected ask sees the ended session", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const askGate = deferred<AskApproval>();
        const base = askRecording([]).ctx;
        const ctx: ToolContext = {
            ...base,
            ask: (request) => (request.title === "Approve the source-build plan" ? askGate.promise : Promise.resolve({ kind: "once" })),
        };
        (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        const planCall = tool.execute(FIRST_BUILD, ctx);
        const queued = tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx);
        await settle();
        askGate.reject(new AskRejectedError("denied in test"));
        await expect(planCall).rejects.toBeInstanceOf(AskRejectedError);

        expect((await queued)._unsafeUnwrap()).toEqual({ status: "session_ended", sessionId: "sess-1" });
    });
});
