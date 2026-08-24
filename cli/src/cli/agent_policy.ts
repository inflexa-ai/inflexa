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
 *
 * A runnable kind can also carry {@link TransferTrait}.
 */
export type AgentPolicy =
    | ({ readonly kind: "auto"; readonly safeFlags: readonly string[] } & TransferTrait)
    | ({ readonly kind: "approval" } & TransferTrait)
    | { readonly kind: "blocked"; readonly reason: string };

/**
 * The trait a runnable command carries when its work is a transfer from an upstream publisher —
 * `refs download` and `geo download` today. The tool then runs it with NO deadline of its own, and the
 * approval prompt states that.
 *
 * A transfer has no honest deadline to declare here. Its size is a 2 GB artifact over whatever link the
 * user has, so a ceiling generous enough to spare an honest run also spares a dead one; and a bound on
 * silence stops the honest run first, because a captured transfer prints one line for each file and one
 * file is minutes of quiet. Liveness is decided where the bytes are instead — `downloadToFile` in
 * `lib/download.ts` watches its own body and ends a transfer that stops moving, within
 * `LIVENESS_WINDOW_MS`. A second bound out here could only ever be the wrong one.
 *
 * The trait is deliberately not a `kind`: what may run the command, and how long it may take, are
 * different questions, and folding them together would make a fourth kind that means "approval, but".
 */
export type TransferTrait = {
    readonly transfer?: true;
};

/** Whether `policy` marks a transfer — see {@link TransferTrait}. A `blocked` command never runs, thus it never carries one. */
export function isTransferPolicy(policy: AgentPolicy | undefined): boolean {
    return policy !== undefined && policy.kind !== "blocked" && policy.transfer === true;
}

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
 * Give `command` the value of an option IT DECLARES that an ancestor parsed instead.
 *
 * The root declares `--analysis`/`--project` for the bare-`inflexa` flow, and commander binds a
 * program option to the command that DECLARED it wherever it appears on the line — so `inflexa
 * profile --analysis x` binds the value to the root, the subcommand's identically-named option
 * never receives it, and its handler is called with an empty options object. The flag reaches no
 * code and nothing reports that it was ignored.
 *
 * The alternative, `enablePositionalOptions()`, was tried and reverted: it makes a root-style flag
 * placed AFTER a subcommand a hard "unknown option" error, breaking shapes like `inflexa project ls
 * --project x` that already work. `cli.test.ts` pins both halves.
 *
 * Runs as a `preAction` hook rather than by rewriting the handler's arguments, because commander
 * builds those arguments from `command.opts()` at invocation time — which is after hooks — so
 * seeding the values here means the handler is called with its ordinary, correctly-typed options
 * object and nothing downstream has to know this happened.
 *
 * Only options `command` itself declares are filled, never every option an ancestor happens to
 * hold: the contract is "the flag this command offers reaches its handler", not "every ancestor
 * flag is visible everywhere". A command that deliberately does not offer `--project` (see `geo
 * download`) must not receive one, or the omission is undone by the plumbing that was meant to
 * honour it. A value the command parsed itself always wins, so an explicit `inflexa profile
 * --analysis x` still beats anything an ancestor holds. Idempotent, which matters because the root
 * registers this hook too and ancestor hooks fire for a subcommand's action as well — the second
 * pass finds every key already set.
 */
function hydrateFromAncestors(command: Command): void {
    const own = command.opts();
    const inherited = command.optsWithGlobals();
    for (const option of command.options) {
        const key = option.attributeName();
        const value = inherited[key];
        if (value !== undefined && own[key] === undefined) command.setOptionValue(key, value);
    }
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
 * Registration also makes a command see the options its ancestors parsed —
 * see {@link hydrateFromAncestors}.
 */
export function registerAction<Args extends readonly unknown[]>(
    command: Command,
    policy: AgentPolicy,
    handler: (...args: Args) => void | Promise<void>,
): Command {
    setAgentPolicy(command, policy);
    command.hook("preAction", (_parent, actionCommand) => hydrateFromAncestors(actionCommand));
    return command.action(handler);
}
