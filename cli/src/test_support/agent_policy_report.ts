import type { Command } from "commander";

import { getAgentPolicy } from "../cli/agent_policy.ts";
import { buildProgram } from "../cli/index.ts";

/**
 * One serializable row per command that carries an action handler — the audit surface the tree-walk and
 * snapshot tests assert over. Serializable on purpose: the dev-channel gate is frozen at env-import time,
 * so the dev-OFF tree is only reachable by baking the channel in a subprocess, and JSON is what crosses
 * that boundary (see the callers in agent_policy_tree.test.ts).
 */
export type PolicyRow = {
    /** Root-first path words joined by a space — the same identity the classifier reports as `grantKey`. */
    readonly grantKey: string;
    /** `getAgentPolicy(command) !== undefined`. False is the failure the exhaustiveness test hunts: an action with no policy. */
    readonly hasPolicy: boolean;
    /** The declared policy kind, or `null` when unstamped. */
    readonly kind: "auto" | "approval" | "blocked" | null;
    /** The `auto` policy's safe flags, else `null` — the set that must be a subset of {@link declaredOptions}. */
    readonly safeFlags: readonly string[] | null;
    /** Every declared option's canonical attributeName on this command. */
    readonly declaredOptions: readonly string[];
};

/**
 * True iff commander stamped an action handler on `command`.
 *
 * `_actionHandler` is commander's private slot, set by exactly one thing — `.action()` — and there is no
 * public predicate for "would this command run an action". The invariant the tests enforce is precisely
 * "every action-carrying command is stamped with a policy", so this private read is the only faithful
 * oracle for the antecedent. Confined to this test-support module; shipped code never reaches for it.
 */
function hasActionHandler(command: Command): boolean {
    // Cast to reach the private slot: sound because commander initializes it to `null` and only ever
    // assigns the action listener there, so `!= null` is exactly "has an action handler".
    return (command as unknown as { _actionHandler: unknown })._actionHandler != null;
}

function walk(command: Command, path: readonly string[], rows: PolicyRow[]): void {
    if (hasActionHandler(command)) {
        const policy = getAgentPolicy(command);
        rows.push({
            grantKey: path.join(" "),
            hasPolicy: policy !== undefined,
            kind: policy?.kind ?? null,
            safeFlags: policy?.kind === "auto" ? [...policy.safeFlags] : null,
            declaredOptions: command.options.map((option) => option.attributeName()),
        });
    }
    for (const child of command.commands) walk(child, [...path, child.name()], rows);
}

/** Walk `root`'s full subtree, returning a {@link PolicyRow} for every command that carries an action handler. */
export function walkActionPolicies(root: Command): PolicyRow[] {
    const rows: PolicyRow[] = [];
    walk(root, [root.name()], rows);
    return rows;
}

/** Build a fresh program (reflecting THIS process's baked channel) and report its action-policy rows. */
export function reportAgentPolicies(): PolicyRow[] {
    return walkActionPolicies(buildProgram());
}

// Run as a subprocess (`bun run agent_policy_report.ts`) the report prints its JSON to stdout — the only
// channel-independent way to observe the dev-OFF tree, since the gate is frozen at env import.
if (import.meta.main) {
    process.stdout.write(JSON.stringify(reportAgentPolicies()));
}
