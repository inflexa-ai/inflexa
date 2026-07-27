import type { Command } from "commander";

/**
 * Agent-availability policy for a single commander action command — the floor that
 * decides how the conversation agent's `run_inflexa` tool may invoke it. Exactly
 * three kinds, declared at the command's registration site (see {@link registerAction}):
 *
 * - `auto` — runs with NO approval prompt, but only for invocations whose every
 *   explicitly-set option is in `safeFlags`. Any other invocation escalates to the
 *   `approval` flow. This encodes the standing invariant "policy is the floor; flags
 *   only escalate" — an out-of-set flag can push an `auto` invocation up to a prompt,
 *   never down past one, because "not known read-only" is exactly what the prompt
 *   boundary exists for.
 * - `approval` — the default: the tool pauses on `ctx.ask` for the user's approval,
 *   which is grantable per analysis. The prompt is the security boundary here.
 * - `blocked` — never runs, not even with approval; the mandatory `reason` is handed
 *   verbatim to the model so it can explain to the user why and stop retrying.
 */
export type AgentPolicy =
    { readonly kind: "auto"; readonly safeFlags: readonly string[] } | { readonly kind: "approval" } | { readonly kind: "blocked"; readonly reason: string };

/**
 * The policy store, keyed on the `Command` INSTANCE rather than its path string.
 *
 * A string key ("inflexa refs list") would couple the policy to the command only by
 * spelling: rename the command and the entry silently orphans, leaving the command
 * un-policied while a dead entry lingers. Keying on the object means the policy
 * travels with the command through any rename or restructure, and — because the map
 * is weak — entries are collected together with the throwaway `Command` trees the
 * classifier builds on every argv, so nothing accumulates across `buildProgram()`
 * instances.
 */
const policies = new WeakMap<Command, AgentPolicy>();

/** Stamp `command` with its agent policy. Called by {@link registerAction}; exposed so tests can assert the stamp round-trips. */
export function setAgentPolicy(command: Command, policy: AgentPolicy): void {
    policies.set(command, policy);
}

/** Read back the policy stamped on `command`, or `undefined` if none was declared (an action command that never went through {@link registerAction}). */
export function getAgentPolicy(command: Command): AgentPolicy | undefined {
    return policies.get(command);
}

/**
 * Register an action handler on `command` together with its {@link AgentPolicy} — the
 * ONLY sanctioned way to give a command an action, replacing a bare `command.action(fn)`.
 *
 * Because `policy` is a required parameter, an action command declared without a policy
 * is a TypeScript compile error: this is the outermost of the enforcement layers that
 * make an unclassified command unrepresentable (a registry-scoped ESLint rule bans raw
 * `.action(`, a tree-walk test asserts every action leaf carries a policy, and the tool
 * fails closed on a missing one). Validation of the policy itself lives in tests, never
 * here — a policy typo must not brick the user's CLI at startup, so this stays pure
 * sync registration with no throws.
 *
 * `Args` is inferred from `handler`, so a typed callback (`(options: {...}) => …`,
 * `(name, paths, options) => …`) keeps its parameter types at the call site with no
 * cast. Works for a subcommand (`registerAction(cli.command("x")…, policy, fn)`) and
 * for the root, whose action attaches after its own `.option(...)` chain
 * (`registerAction(cli.option(...)…, policy, fn)`).
 *
 * The options object the handler receives is `optsWithGlobals()`, not the command's own
 * `opts()`. The root declares `--analysis`/`--project` for the bare-`inflexa` flow, and
 * commander lets a program option appear anywhere on the line — so for `inflexa profile
 * --analysis x` the value binds to the ROOT and the subcommand's identically-named option
 * never receives it, handing the handler an empty object and dropping the flag in silence.
 * Merging ancestors here fixes every command at once and keeps a subcommand's own value
 * winning when it has one. The alternative, `enablePositionalOptions()`, was tried and
 * reverted: it makes a root-style flag placed after a subcommand a hard "unknown option"
 * error, breaking shapes like `inflexa sessions --project x` that users already rely on
 * (see the regression test in `cli.test.ts`).
 */
export function registerAction<Args extends readonly unknown[]>(
    command: Command,
    policy: AgentPolicy,
    handler: (...args: Args) => void | Promise<void>,
): Command {
    setAgentPolicy(command, policy);
    // Commander invokes an action as (...declaredArguments, options, command), always passing both
    // trailing values — so the options slot is at `length - 2` whatever the command's arity.
    return command.action((...args: unknown[]) => {
        const self = args[args.length - 1] as Command;
        const merged = [...args];
        merged[args.length - 2] = self.optsWithGlobals();
        return handler(...(merged as unknown as Args));
    });
}
