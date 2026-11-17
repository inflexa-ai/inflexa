import type { AskRequest, ToolContext } from "@inflexa-ai/harness";
import { describe, expect, test } from "bun:test";

import { createRunInflexaTool, type RunInflexaResult, type RunSubprocess } from "../../modules/harness/inflexa_tool.ts";
import { buildAgentSession, buildToolContext } from "../../test_support/builders.ts";

// The agent policy of the customization commands, through the `run_inflexa` tool itself: the classifier reads the
// real registry, thus a command that the registry reclassifies changes the result here.

function makeCtx(): ToolContext {
    return buildToolContext(buildAgentSession({ scope: { kind: "analysis", analysisId: "an-test" } }));
}

/** Run one call as the loop does: the approval hook first, then `execute`. Each approval is granted and recorded. */
async function run(argv: string[]): Promise<{ readonly asked: AskRequest[]; readonly spawned: (readonly string[])[]; readonly result: RunInflexaResult }> {
    const spawned: (readonly string[])[] = [];
    const runSubprocess: RunSubprocess = (cmd) => {
        spawned.push(cmd);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", endedBy: "exit" });
    };
    const tool = createRunInflexaTool({ runSubprocess, isDevelopment: true, execPath: "/bin/bun", scriptPath: "/app/src/index.ts" });
    const ctx = makeCtx();
    const asked: AskRequest[] = [];
    const request = await tool.approval?.({ argv }, { invocationId: ctx.invocationId, session: ctx.session });
    if (request !== undefined) asked.push(request);
    const result = (await tool.execute({ argv }, ctx))._unsafeUnwrap();
    return { asked, spawned, result };
}

/** The message of a refusal, or a marker that names the status when the call was not refused. */
function blockedMessage(result: RunInflexaResult): string {
    return result.status === "blocked" ? result.message : `not blocked: ${result.status}`;
}

describe("run_inflexa — the customization commands", () => {
    test("`mcp add` asks, and its approval grants only the exact command, because the host runs what the entry names", async () => {
        const { asked, spawned } = await run(["mcp", "add", "lims", "--", "lims-mcp"]);

        expect(asked.length).toBe(1);
        expect(asked[0]?.command).toBe("inflexa mcp add lims -- lims-mcp");
        expect(asked[0]?.grantKey).toBeUndefined();
        expect(spawned.length).toBe(1);
    });

    test("`credential set --env` runs with no prompt, and `--command` asks for the exact command", async () => {
        const fromEnv = await run(["credential", "set", "ncbi-key", "--env", "NCBI_API_KEY"]);
        const fromCommand = await run(["credential", "set", "ncbi-key", "--command", "op read op://lab/ncbi"]);

        expect(fromEnv.asked).toEqual([]);
        expect(fromEnv.spawned.length).toBe(1);
        expect(fromCommand.asked.map((request) => request.grantKey)).toEqual([undefined]);
    });

    test("`connector set` turns a connector on with no prompt, and a new endpoint asks for the exact command", async () => {
        const enable = await run(["connector", "set", "pubmed", "--enable"]);
        const endpoint = await run(["connector", "set", "pubmed", "--endpoint", "https://mirror.example"]);

        expect(enable.asked).toEqual([]);
        expect(endpoint.asked.map((request) => request.grantKey)).toEqual([undefined]);
    });

    test.each([["auth"], ["logout"]])("`mcp %s` is refused with the reason that it needs a person at a browser", async (verb) => {
        const { asked, spawned, result } = await run(["mcp", verb, "remote"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([]);
        expect(blockedMessage(result)).toContain("a person at a browser");
    });

    test("`agent attach` runs with no prompt, because it changes only the state of Inflexa", async () => {
        const { asked, spawned } = await run(["agent", "attach", "analyst", "skill", "lab-protocols"]);

        expect(asked).toEqual([]);
        expect(spawned.length).toBe(1);
    });

    test("`agent detach` with many skills is one call with no prompt", async () => {
        const { asked, spawned } = await run(["agent", "detach", "analyst", "skill", "single-cell", "spatial-omics", "proteomics"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([["/bin/bun", "/app/src/index.ts", "agent", "detach", "analyst", "skill", "single-cell", "spatial-omics", "proteomics"]]);
    });

    test("`mcp rm` with many servers asks one time for the whole command", async () => {
        const { asked, spawned } = await run(["mcp", "rm", "lims", "notes"]);

        expect(asked.map((request) => request.command)).toEqual(["inflexa mcp rm lims notes"]);
        expect(spawned.length).toBe(1);
    });

    test("`agent rm` asks, and an approval can cover each later removal", async () => {
        const { asked } = await run(["agent", "rm", "lipid-analyst"]);

        expect(asked.map((request) => request.grantKey)).toEqual(["inflexa agent rm"]);
    });

    test("`skill import` of a relative path runs with no prompt, and the tool adds the analysis of the chat", async () => {
        const { asked, spawned } = await run(["skill", "import", "skills/lipidomics-lcms"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([["/bin/bun", "/app/src/index.ts", "skill", "import", "skills/lipidomics-lcms", "--analysis", "an-test"]]);
    });

    test("`skill import --analysis` with the analysis of the chat runs with no prompt, and the analysis goes once", async () => {
        const { asked, spawned } = await run(["skill", "import", "--analysis", "an-test", "skills/lipidomics-lcms"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([["/bin/bun", "/app/src/index.ts", "skill", "import", "skills/lipidomics-lcms", "--analysis", "an-test"]]);
    });

    test("`skill import --analysis` with a different analysis asks, because it reads a workspace that is not the one of the chat", async () => {
        const { asked } = await run(["skill", "import", "--analysis", "other", "skills/x"]);

        expect(asked.map((request) => request.command)).toEqual(["inflexa skill import --analysis other skills/x"]);
    });

    test.each([["/home/u/.claude/skills/x"], ["~/skills/x"], ["../x"]])(
        "`skill import %s` asks for the exact command, because it names a folder of the host",
        async (path) => {
            const { asked } = await run(["skill", "import", path]);

            expect(asked.map((request) => request.grantKey)).toEqual([undefined]);
        },
    );

    test("`skill import --replace` and `agent import --replace` ask, because each overwrites a custom copy", async () => {
        const skill = await run(["skill", "import", "skills/x", "--replace"]);
        const agent = await run(["agent", "import", "agents/x.md", "--replace"]);

        expect(skill.asked.length).toBe(1);
        expect(agent.asked.length).toBe(1);
    });

    test("`agent ls --json` runs with no prompt", async () => {
        const { asked, spawned } = await run(["agent", "ls", "--json"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([["/bin/bun", "/app/src/index.ts", "agent", "ls", "--json"]]);
    });
});
