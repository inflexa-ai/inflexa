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
    test("`mcp add` is refused with the reason that it makes the host run a command", async () => {
        const { asked, spawned, result } = await run(["mcp", "add", "lims", "--", "lims-mcp"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([]);
        expect(blockedMessage(result)).toContain("makes the host run a command");
    });

    test.each([["auth"], ["logout"]])("`mcp %s` is refused with the reason that it needs a person at a browser", async (verb) => {
        const { asked, spawned, result } = await run(["mcp", verb, "remote"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([]);
        expect(blockedMessage(result)).toContain("a person at a browser");
    });

    test("`agent attach` asks the user before it runs", async () => {
        const { asked, spawned } = await run(["agent", "attach", "analyst", "skill", "lab-protocols"]);

        expect(asked.length).toBe(1);
        expect(asked[0]?.command).toBe("inflexa agent attach analyst skill lab-protocols");
        expect(spawned.length).toBe(1);
    });

    test("`agent ls --json` runs with no prompt", async () => {
        const { asked, spawned } = await run(["agent", "ls", "--json"]);

        expect(asked).toEqual([]);
        expect(spawned).toEqual([["/bin/bun", "/app/src/index.ts", "agent", "ls", "--json"]]);
    });
});
