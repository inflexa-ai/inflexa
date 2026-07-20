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
