import { ESLint } from "eslint";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { PolicyRow } from "../test_support/agent_policy_report.ts";

const REPORT_ENTRY = join(import.meta.dir, "../test_support/agent_policy_report.ts");

/**
 * Walk the command tree under a forced build channel and return its action-policy rows.
 *
 * The dev-channel gate (`devCommandsEnabled`) reads a channel frozen at env-import time — undefined in a
 * `bun test` process, which means dev-ON always — so the dev-OFF tree is unreachable in-process. Baking
 * the channel BEFORE the import means a subprocess, exactly as scripts/gen_docs.ts forces a production
 * channel for the release-surface docs. Both channels go through a subprocess so neither depends on the
 * ambient test-process channel. Forward the sandbox env (XDG dirs + marker) like runCli so env.ts's
 * data-loss guard passes; override only the two channel signals.
 */
function runReport(channel: "development" | "production"): PolicyRow[] {
    // Widened to a plain string map so `delete` is legal and the whole sandbox env forwards intact.
    const childEnv: Record<string, string | undefined> = { ...Bun.env, INFLEXA_BUILD_CHANNEL: channel };
    delete childEnv.INFLEXA_DEV;
    const proc = Bun.spawnSync(["bun", "run", REPORT_ENTRY], { env: childEnv });
    if (proc.exitCode !== 0) throw new Error(`agent_policy_report failed (channel=${channel}, exit ${proc.exitCode}):\n${proc.stderr.toString()}`);
    // The `as PolicyRow[]` is sound because both ends of this JSON are owned by the same module pair: the
    // subprocess is `agent_policy_report.ts` printing `JSON.stringify(reportAgentPolicies())`, whose return
    // type IS `PolicyRow[]`. The shape is fixed end-to-end by this code — not external input — so no runtime
    // validation is warranted; a drift here would be a same-repo type change caught by tsc, not a wire skew.
    return JSON.parse(proc.stdout.toString()) as PolicyRow[];
}

/** Compact each row to its audit value: `auto(flag,flag)` for auto, otherwise the bare kind. */
function policyTable(rows: readonly PolicyRow[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of rows) out[row.grantKey] = row.kind === "auto" ? `auto(${(row.safeFlags ?? []).join(",")})` : String(row.kind);
    return out;
}

// The release surface (dev channel OFF). This literal table is the human audit surface: any policy-kind
// or safeFlags change surfaces here as a one-file diff that a reviewer must consciously accept. Sorted by
// grantKey.
const EXPECTED_DEV_OFF: Record<string, string> = {
    inflexa: "blocked",
    "inflexa analysis set-project": "approval",
    "inflexa auth login": "approval",
    "inflexa auth logout": "approval",
    "inflexa auth whoami": "auto()",
    "inflexa config": "blocked",
    "inflexa down": "blocked",
    "inflexa inputs add": "blocked",
    "inflexa inputs ls": "auto(analysis)",
    "inflexa inputs remove": "blocked",
    "inflexa ls": "auto(project)",
    "inflexa new": "blocked",
    "inflexa open": "approval",
    "inflexa project ls": "auto()",
    "inflexa project new": "approval",
    "inflexa prov export": "approval",
    "inflexa prov lineage": "auto(forward,depth,format)",
    "inflexa prov verify": "auto()",
    "inflexa prov verify-file": "auto()",
    "inflexa prune": "approval",
    "inflexa refs download": "approval",
    "inflexa refs list": "auto(urls,json)",
    "inflexa refs path": "auto()",
    "inflexa refs verify": "auto(json)",
    "inflexa relocate": "approval",
    "inflexa repair": "approval",
    "inflexa resume": "blocked",
    "inflexa sandbox pull": "approval",
    "inflexa sandbox status": "auto()",
    "inflexa sessions": "auto()",
    "inflexa setup": "blocked",
    "inflexa status": "approval",
    "inflexa up": "blocked",
};

// The full surface (dev channel ON) — the release table plus the three dev-only harness entry points.
// `chat` is a blocked TUI launcher; `profile`/`run` boot the embedded runtime and stay approval.
const EXPECTED_DEV_ON: Record<string, string> = {
    inflexa: "blocked",
    "inflexa analysis set-project": "approval",
    "inflexa auth login": "approval",
    "inflexa auth logout": "approval",
    "inflexa auth whoami": "auto()",
    "inflexa chat": "blocked",
    "inflexa config": "blocked",
    "inflexa down": "blocked",
    "inflexa inputs add": "blocked",
    "inflexa inputs ls": "auto(analysis)",
    "inflexa inputs remove": "blocked",
    "inflexa ls": "auto(project)",
    "inflexa new": "blocked",
    "inflexa open": "approval",
    "inflexa profile": "approval",
    "inflexa project ls": "auto()",
    "inflexa project new": "approval",
    "inflexa prov export": "approval",
    "inflexa prov lineage": "auto(forward,depth,format)",
    "inflexa prov verify": "auto()",
    "inflexa prov verify-file": "auto()",
    "inflexa prune": "approval",
    "inflexa refs download": "approval",
    "inflexa refs list": "auto(urls,json)",
    "inflexa refs path": "auto()",
    "inflexa refs verify": "auto(json)",
    "inflexa relocate": "approval",
    "inflexa repair": "approval",
    "inflexa resume": "blocked",
    "inflexa run": "approval",
    "inflexa sandbox pull": "approval",
    "inflexa sandbox status": "auto()",
    "inflexa sessions": "auto()",
    "inflexa setup": "blocked",
    "inflexa status": "approval",
    "inflexa up": "blocked",
};

describe("agent policy — tree-walk exhaustiveness (both channels)", () => {
    test.each([["development"], ["production"]] as const)("every action-carrying command in the %s channel carries a policy", (channel) => {
        const rows = runReport(channel);
        const unclassified = rows.filter((r) => !r.hasPolicy).map((r) => r.grantKey);
        expect(unclassified).toEqual([]);
        // Guard against a walk that found nothing (a broken subprocess), which would pass the filter vacuously.
        expect(rows.length).toBeGreaterThan(0);
    });

    test.each([["development"], ["production"]] as const)("every safeFlags entry names a declared option in the %s channel", (channel) => {
        const rows = runReport(channel);
        for (const row of rows) {
            if (row.kind !== "auto") continue;
            for (const flag of row.safeFlags ?? []) {
                // A stale safeFlag (option renamed/removed) must be a loud failure — until fixed it is
                // fail-safe (the invocation escalates to approval), but it should never sit undetected.
                expect(row.declaredOptions).toContain(flag);
            }
        }
    });
});

describe("agent policy — snapshot audit surface", () => {
    test("the dev-OFF (release) policy table matches the pinned snapshot", () => {
        expect(policyTable(runReport("production"))).toEqual(EXPECTED_DEV_OFF);
    });

    test("the dev-ON policy table matches the pinned snapshot (adds the dev-only entries)", () => {
        expect(policyTable(runReport("development"))).toEqual(EXPECTED_DEV_ON);
    });
});

// The lint ban is the static half of the same audit surface: it stops a raw `command.action(fn)` from ever
// registering an action with no policy in the first place. Exercising it here through ESLint's own Node API
// against the REAL flat config (not a hand-rolled selector) pins the spec scenario "A raw `.action()` in the
// registry is a lint error".
//
// Typed parsing is EXPLICITLY disabled for these lint runs: the rule under test is AST-only, and building
// the type-aware TS program inside the test process proved nondeterministically fragile under full-suite
// load (a fatal parse yields zero rule messages, which reads as "ban did not fire"). Disabling
// `project`/`projectService` — and the four type-service rules that would crash without them — removes that
// entire subsystem from the test while still exercising the real config's rule presence and file scoping.
// If config loading itself ever breaks, lintText throws and the test fails loudly rather than vacuously.
describe("agent policy — the registry-scoped raw `.action(` lint ban", () => {
    const cliRoot = join(import.meta.dir, "../..");
    const banFires = (messages: readonly { readonly ruleId: string | null }[]): boolean => messages.some((m) => m.ruleId === "no-restricted-syntax");
    const untypedEslint = (): ESLint =>
        new ESLint({
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

    test("a raw `.action(fn)` (plain and computed-member) in a registry file is a no-restricted-syntax error", async () => {
        const eslint = untypedEslint();
        // filePath places the snippet inside the registry scope; the linted TEXT is the violating snippet
        // (it need not match the file on disk). Both the plain member call and the computed-member bypass trip it.
        const [plain] = await eslint.lintText("cmd.action(() => {});\n", { filePath: join(cliRoot, "src/cli/index.ts") });
        const [computed] = await eslint.lintText('cmd["action"](() => {});\n', { filePath: join(cliRoot, "src/cli/index.ts") });
        expect(banFires(plain?.messages ?? [])).toBe(true);
        expect(banFires(computed?.messages ?? [])).toBe(true);
    });

    test("the same call in agent_policy.ts (the sanctioned registerAction site) is exempt", async () => {
        const eslint = untypedEslint();
        const [result] = await eslint.lintText("cmd.action(() => {});\n", { filePath: join(cliRoot, "src/cli/agent_policy.ts") });
        expect(banFires(result?.messages ?? [])).toBe(false);
    });
});
