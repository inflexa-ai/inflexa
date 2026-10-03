import { ESLint } from "eslint";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The cut between a client and the local server is a `no-restricted-imports` rule in eslint.config.js. These
// runs lint a snippet against the REAL flat config, untyped for the reason in agent_policy_tree.test.ts: the
// rule is AST-only, and the type-aware program is fragile inside a loaded test process.
const cliRoot = join(import.meta.dir, "../..");

function untypedEslint(): ESLint {
    return new ESLint({
        cwd: cliRoot,
        overrideConfig: {
            languageOptions: { parserOptions: { projectService: false, project: false } },
            rules: {
                "@typescript-eslint/no-floating-promises": "off",
                "@typescript-eslint/no-misused-promises": "off",
                "@typescript-eslint/switch-exhaustiveness-check": "off",
                "neverthrow/must-use-result": "off",
            },
        },
    });
}

/** The import specifiers of `specifiers` that the rule bans in a file at `filePath`. */
async function banned(filePath: string, specifiers: readonly string[]): Promise<string[]> {
    const text = specifiers.map((s, i) => `import * as m${i} from "${s}";\nvoid m${i};`).join("\n");
    const [result] = await untypedEslint().lintText(text, { filePath: join(cliRoot, filePath) });
    const lines = new Set((result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.line));
    return specifiers.filter((_, i) => lines.has(i * 2 + 1));
}

const SERVER_SIDE = [
    "../db/primary_query.ts",
    "../server/app.ts",
    "../lib/bus.ts",
    "@inflexa-ai/harness",
    "@inflexa-ai/harness/app/chat-turn.js",
    "../modules/harness/runtime.ts",
    "../../modules/analysis/analysis.ts",
];

const CLIENT_SAFE = [
    "../api/server.ts",
    "../client/api.ts",
    "../lib/env.ts",
    "@inflexa-ai/harness/contracts/index.js",
    "@inflexa-ai/harness/app/data-profile-view",
    "../modules/harness/plan_dag.ts",
    "../../modules/harness/chat_printer.ts",
    "../../modules/prov/verify_file.ts",
];

describe("the client import boundary", () => {
    test.each([["src/tui/probe.tsx"], ["src/client/probe.ts"]])("%s cannot import the server side", async (filePath) => {
        expect(await banned(filePath, SERVER_SIDE)).toEqual(SERVER_SIDE);
    });

    test.each([["src/tui/probe.tsx"], ["src/client/probe.ts"]])("%s can import the wire types and the pure helpers", async (filePath) => {
        expect(await banned(filePath, CLIENT_SAFE)).toEqual([]);
    });

    test("a type-only import of a module is banned too: a client takes each wire type from src/api/", async () => {
        const [result] = await untypedEslint().lintText('import type { AgentName } from "../modules/harness/agent_switch.ts";\n', {
            filePath: join(cliRoot, "src/tui/probe.ts"),
        });
        expect(result?.messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
    });

    test("the client block keeps the dev-channel ban, which its own rule options replace", async () => {
        expect(await banned("src/tui/probe.ts", ["./dev/chat.ts"])).toEqual(["./dev/chat.ts"]);
    });

    test("the server side itself is outside the rule", async () => {
        expect(await banned("src/server/probe.ts", SERVER_SIDE)).toEqual([]);
    });
});
