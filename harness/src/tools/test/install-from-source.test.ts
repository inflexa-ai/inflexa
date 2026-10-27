/**
 * Unit tests for `install_from_source` — the four-operation input, the roster
 * gating, and the whole ask flow over a stubbed `BuildSession`: the plan ask
 * after exploration, the per-command ask with its session-scoped grant key, the
 * commit ask, the rejections that end a session with no store change, and the
 * exec/commit result semantics (fresh-shell ids, the excerpt cap, the
 * retry-in-session path).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { Pool } from "pg";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createInstallFromSourceTool } from "../install-from-source.js";
import { AskRejectedError, type AskApproval, type AskRequest } from "../approval/contract.js";
import type { ToolContext } from "../define-tool.js";
import type { KeptToolOutput, ToolOutputStore } from "../../loop/tool-output.js";
import type { BuildCommitResult, BuildExecResult, BuildSession, BuildSessionCommand, BuildSource } from "../../sandbox/types.js";
import { createConversationAgent } from "../../agents/conversation-agent.js";
import { unusedCitationResolver } from "../../citations/__fixtures__/resolver.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import type { EmbeddingProvider } from "../../providers/types.js";
import type { ExecuteAnalysisResult } from "../../workflows/execute-analysis.js";
import type { EnsureSessionStateResult } from "../../app/report-session-runtime.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import { makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";

const SHA = "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e";
const PIN = `SeedMatchR==2.0.0@git:${SHA}`;
const STORE_DIR = "/pool/seedmatchr-2.0.0-1e2b3d";

/** An `ask` that records each request and plays back a scripted reply per call. */
function askRecording(replies: readonly ("once" | "always" | "reject")[]): { requests: AskRequest[]; ctx: ToolContext } {
    const requests: AskRequest[] = [];
    const base = makeToolContext();
    let next = 0;
    const ctx: ToolContext = {
        ...base.ctx,
        ask: (request): Promise<AskApproval> => {
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
    | { readonly op: "commit"; readonly handle: string; readonly script: string }
    | { readonly op: "stop"; readonly handle: string };

type StubDeps = {
    /** Each started session gets its own id; defaults to `sess-1`, `sess-2`, ... */
    readonly exec?: (command: BuildSessionCommand) => Partial<BuildExecResult>;
    readonly commit?: () => BuildCommitResult;
    /** The fixed hosts of the class the embedder's start reports; absent stands for an embedder that names none. */
    readonly classHosts?: readonly string[];
};

/** A `BuildSession` that records every call and answers from small scripted results. */
function stubBuildSession(stub: StubDeps = {}): { calls: StubCall[]; buildSession: BuildSession } {
    const calls: StubCall[] = [];
    let started = 0;
    const buildSession: BuildSession = {
        start: (source, analysisId) => {
            calls.push({ op: "start", source, analysisId });
            started += 1;
            return Promise.resolve({
                sessionId: `sess-${started}`,
                commit: source.kind === "git" ? SHA : undefined,
                workingDir: "/work/src",
                classHosts: stub.classHosts,
            });
        },
        exec: (handle, command) => {
            calls.push({ op: "exec", handle, command });
            return Promise.resolve({ execId: command.execId, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...stub.exec?.(command) });
        },
        commit: (handle, script) => {
            calls.push({ op: "commit", handle, script });
            return Promise.resolve(stub.commit?.() ?? { kind: "committed" as const, pin: PIN, storeDir: STORE_DIR });
        },
        stop: (handle) => {
            calls.push({ op: "stop", handle });
            return Promise.resolve();
        },
    };
    return { calls, buildSession };
}

function recordingStore(): { puts: KeptToolOutput[]; store: ToolOutputStore } {
    const puts: KeptToolOutput[] = [];
    return {
        puts,
        store: {
            put: (output) => {
                puts.push(output);
                return okAsync(undefined);
            },
            get: () => okAsync(null),
        },
    };
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
});

describe("install_from_source — the description", () => {
    const description = createInstallFromSourceTool({ buildSession: stubBuildSession().buildSession }).description;

    it("carries the paths discipline of the fresh-shell contract", () => {
        expect(description).toContain("FRESH shell");
        expect(description).toContain("absolute paths");
        expect(description).toContain("`cd <dir> && <command>`");
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

    it("carries the stop rule and the excerpt note", () => {
        expect(description).toContain("STOP the session");
        expect(description).toContain("when the build is done or the user refuses to continue");
        expect(description).toContain("read_tool_output");
    });
});

describe("install_from_source — the roster gating", () => {
    const unusedEmbedding: EmbeddingProvider = {
        dimensions: 1536,
        embed() {
            throw new Error("not used at composition time");
        },
    };
    const refuseExecuteAnalysis = (): Promise<ExecuteAnalysisResult> => Promise.reject(new Error("not used at composition time"));
    const refuseAnchorReportSession: (threadId: string) => Promise<EnsureSessionStateResult> = () => {
        throw new Error("not used at composition time");
    };
    const refuseRunLauncher: RunLauncher = {
        launch() {
            throw new Error("not used at composition time");
        },
    };

    function buildAgent(buildSession?: BuildSession) {
        return createConversationAgent({
            provider: unusedChatProvider(),
            utilityProvider: unusedChatProvider(),
            pool: new Pool(),
            embedding: unusedEmbedding,
            workspaceFs: makeFakeWorkspaceFs(),
            model: "anthropic/claude-opus-4-7",
            utilityModel: "anthropic/claude-haiku-4-5",
            executeAnalysisWorkflow: refuseExecuteAnalysis,
            anchorReportSession: refuseAnchorReportSession,
            resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/sessions", id)),
            runAuthorizer: createLocalRunAuthorizer(),
            runLauncher: refuseRunLauncher,
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            skillsDir: "/skills",
            chrome: {},
            citationResolver: unusedCitationResolver,
            buildSession,
        });
    }

    it("an unbound interface leaves the tool off the roster", () => {
        expect(buildAgent().tools.map((t) => t.id)).not.toContain("install_from_source");
    });

    it("a bound interface adds exactly one tool to the conversation roster", () => {
        const ids = buildAgent(stubBuildSession().buildSession).tools.map((t) => t.id);
        expect(ids.filter((id) => id === "install_from_source")).toHaveLength(1);
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
        const base = makeToolContext();
        const ctx = { ...base.ctx, session: makeSession({ scope: { kind: "analysis", analysisId: "analysis-7f" } }) };

        const result = (await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("started");
        expect(stub.calls).toEqual([{ op: "start", source: { kind: "git", url: "https://github.com/tacazares/SeedMatchR" }, analysisId: "analysis-7f" }]);
    });

    it("a folder source starts with no commit and no ask", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["reject"]);

        const result = (await tool.execute({ op: "start", folder: "/home/me/localpkg" }, ctx))._unsafeUnwrap();

        if (result.status !== "started") throw new Error("expected a started result");
        expect(result.commit).toBeUndefined();
        expect(requests).toEqual([]);
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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);

        await tool.execute({ op: "exec", sessionId: "sess-1", command: "R CMD INSTALL --library=/work/out ." }, ctx);

        expect(requests).toHaveLength(3);
        expect(requests.at(-1)?.title).toBe("Run build-session command");
        expect(requests.at(-1)?.grantKey).toBe("install_from_source:sess-1");
    });

    it("the grant key holds the session id, so an always never crosses sessions", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once", "once"]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute({ op: "start", gitUrl: "https://github.com/other/pkg" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);
        await tool.execute({ ...FIRST_BUILD, sessionId: "sess-2" }, ctx);

        const keys = requests.filter((r) => r.title === "Run build-session command").map((r) => r.grantKey);
        expect(keys).toEqual(["install_from_source:sess-1", "install_from_source:sess-2"]);
    });

    it("a root exec says so in its ask, and a plain exec does not", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "once", "once"]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);
        requests.length = 0;

        await tool.execute({ op: "exec", sessionId: "sess-1", command: "apt-get update", root: true }, ctx);
        await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx);

        expect(requests[0]?.detail).toContain("runs as root");
        expect(requests[1]?.detail).not.toContain("runs as root");
        expect(stub.calls.filter((c) => c.op === "exec").at(-2)).toMatchObject({ command: { root: true } });
    });

    it("the plan ask shows the COMPLETE host list the session will carry: the plan's hosts beside the fixed hosts of the class", async () => {
        const stub = stubBuildSession({ classHosts: ["snapshot.ubuntu.com", "pypi.org", "packagemanager.posit.co"] });
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once"]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        const result = (await tool.execute({ ...FIRST_BUILD, hosts: ["github.com"] }, ctx))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        const [planAsk] = requests;
        expect(planAsk?.detail).toContain("Egress hosts of the session: github.com, snapshot.ubuntu.com, pypi.org, packagemanager.posit.co");
        // The plan the embedder receives carries the same complete list, so the
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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);
        const asksBefore = requests.length;
        const execsBefore = stub.calls.filter((c) => c.op === "exec").length;

        await tool.execute(FIRST_BUILD, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        await expect(tool.execute(FIRST_BUILD, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(requests.map((r) => r.title)).toEqual(["Approve the source-build plan", "Run build-session command"]);
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });
    });

    it("a rejected commit stops the session and the clean run never starts", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { requests, ctx } = askRecording(["once", "once", "reject"]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);

        await expect(tool.execute({ op: "commit", sessionId: "sess-1", script: "R CMD INSTALL ." }, ctx)).rejects.toBeInstanceOf(AskRejectedError);

        expect(requests.at(-1)?.title).toBe("Approve the source-build commit");
        expect(requests.at(-1)?.detail).toContain("R CMD INSTALL .");
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([]);
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });
    });
});

describe("install_from_source — exec semantics", () => {
    it("each exec derives its id from the session id and a per-session sequence", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute({ op: "start", gitUrl: "https://github.com/other/pkg" }, ctx);

        await tool.execute({ op: "exec", sessionId: "sess-1", command: "cat DESCRIPTION" }, ctx);
        await tool.execute({ op: "exec", sessionId: "sess-2", command: "cat README" }, ctx);
        await tool.execute({ op: "exec", sessionId: "sess-1", command: "ls" }, ctx);

        const execIds = stub.calls.filter((c) => c.op === "exec").map((c) => c.command.execId);
        expect(execIds).toEqual(["sess-1-1", "sess-2-1", "sess-1-2"]);
    });

    it("a short log returns whole, with no kept reference", async () => {
        const stub = stubBuildSession({ exec: () => ({ stdout: "built ok", stderr: "" }) });
        const recorder = recordingStore();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession, toolOutputStore: recorder.store });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "R CMD build ." }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ status: "ran", execId: "sess-1-1", exitCode: 0, timedOut: false, output: "built ok" });
        if (result.status !== "ran") throw new Error("expected a ran result");
        expect(result.kept).toBeUndefined();
        expect(recorder.puts).toEqual([]);
    });

    it("a long log is cut under the tool-result cap and the whole text is kept for read_tool_output", async () => {
        const long = "x".repeat(64 * 1024);
        const stub = stubBuildSession({ exec: () => ({ stdout: long, stderr: "tail error" }) });
        const recorder = recordingStore();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession, toolOutputStore: recorder.store });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "make" }, ctx))._unsafeUnwrap();

        if (result.status !== "ran") throw new Error("expected a ran result");
        expect(result.output.length).toBeGreaterThan(0);
        expect(result.output.length).toBeLessThan(long.length);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(32 * 1024);
        expect(result.kept).toBeDefined();
        const put = recorder.puts[0];
        expect(put?.toolName).toBe("install_from_source");
        expect(put?.content).toBe(`${long}\n--- stderr ---\ntail error`);
        expect(put?.totalLength).toBe(`${long}\n--- stderr ---\ntail error`.length);
        expect(put?.ref).toBe(result.kept?.ref);
    });

    it("a long log without a store is cut and carries no reference", async () => {
        const long = "y".repeat(64 * 1024);
        const stub = stubBuildSession({ exec: () => ({ stdout: long, stderr: "" }) });
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        const result = (await tool.execute({ op: "exec", sessionId: "sess-1", command: "make" }, ctx))._unsafeUnwrap();

        if (result.status !== "ran") throw new Error("expected a ran result");
        expect(result.output.length).toBeLessThan(long.length);
        expect(result.kept).toBeUndefined();
    });
});

describe("install_from_source — commit semantics", () => {
    async function sessionInBuildPhase(tool: ReturnType<typeof createInstallFromSourceTool>) {
        // The third "once" is the commit ask of the caller's test.
        const { requests, ctx } = askRecording(["once", "once", "once"]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);
        await tool.execute(FIRST_BUILD, ctx);
        return { requests, ctx };
    }

    it("a commit before any plan refuses with the plan direction and no clean run", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

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
        expect(stub.calls.filter((c) => c.op === "commit")).toEqual([{ op: "commit", handle: "sess-1", script: "R CMD INSTALL --library=/work/out ." }]);
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

    it("stop removes the container and the id answers session_ended", async () => {
        const stub = stubBuildSession();
        const tool = createInstallFromSourceTool({ buildSession: stub.buildSession });
        const { ctx } = askRecording([]);
        await tool.execute({ op: "start", gitUrl: "https://github.com/tacazares/SeedMatchR" }, ctx);

        const stopped = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(stopped).toEqual({ status: "stopped", sessionId: "sess-1" });
        expect(stub.calls.at(-1)).toEqual({ op: "stop", handle: "sess-1" });

        const again = (await tool.execute({ op: "stop", sessionId: "sess-1" }, ctx))._unsafeUnwrap();
        expect(again).toEqual({ status: "session_ended", sessionId: "sess-1" });
        const unknown = (await tool.execute({ op: "stop", sessionId: "nope" }, ctx))._unsafeUnwrap();
        expect(unknown).toEqual({ status: "unknown_session", sessionId: "nope" });
    });
});
