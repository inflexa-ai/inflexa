import { type Command, CommanderError } from "commander";

import { type AgentPolicy, getAgentPolicy } from "../../cli/agent_policy.ts";
import { buildProgram } from "../../cli/index.ts";

/**
 * The verdict for a single `inflexa` argv, decided WITHOUT running any action.
 *
 * - `introspection` — the argv only asks the CLI to describe itself (`--help`,
 *   `--version`, a bare parent group that prints its own help). Nothing happens
 *   to the user's data, so a caller may run it freely.
 * - `action` — the argv resolves to a real leaf command that would execute. The
 *   `grantKey` is the command's full path words joined by spaces (no arguments,
 *   no options), the stable identity a caller keys an approval grant on. `policy`
 *   is the {@link AgentPolicy} stamped on the resolved command at registration
 *   (`undefined` only if a command reached `.action()` without the registration
 *   helper — the tool then fails closed). `setOptions` names the options the
 *   invocation EXPLICITLY set, by commander's canonical `attributeName`, so the
 *   tool can measure them against an `auto` policy's `safeFlags`.
 * - `malformed` — the argv does not parse to a runnable command (unknown
 *   command/option, missing/excess argument, invalid value, …). `message` is
 *   commander's own explanation, trimmed.
 *
 * The runnable verdicts carry `argv`: the normalized word argv the verdict
 * describes, and the ONLY argv a caller may display or spawn. Normalization
 * (packed-string tokenization) happens exactly once, inside the classifier —
 * so the command a user approves can never diverge from the one that runs.
 */
export type Classification =
    | { readonly kind: "introspection"; readonly argv: readonly string[] }
    | {
          readonly kind: "action";
          readonly argv: readonly string[];
          readonly path: readonly string[];
          readonly grantKey: string;
          readonly policy: AgentPolicy | undefined;
          readonly setOptions: readonly string[];
      }
    | { readonly kind: "malformed"; readonly message: string };

/**
 * Split a single command string into argv words with quote awareness (single and
 * double quotes), so a caller that passes `"refs download x --yes"` as one
 * element is classified like the tokenized `["refs", "download", "x", "--yes"]`.
 * Deliberately minimal — no escape sequences, no env expansion — because the only
 * job is to recover the word boundaries a shell would have produced; anything
 * fancier is out of scope and would be a second, divergent shell parser to keep
 * correct.
 */
function tokenizeArgvString(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inToken = false;
    // null when outside a quote; otherwise the quote char we are waiting to close.
    let quote: '"' | "'" | null = null;

    for (const ch of input) {
        if (quote !== null) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            // A quote opens a (possibly empty) token even before any char is added.
            quote = ch;
            inToken = true;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            if (inToken) {
                tokens.push(current);
                current = "";
                inToken = false;
            }
            continue;
        }
        current += ch;
        inToken = true;
    }
    if (inToken) tokens.push(current);
    return tokens;
}

/**
 * Recover the effective argv a classifier/runner should act on: a single element
 * that carries whitespace is a packed command string ("refs download x --yes")
 * and is tokenized quote-awarely back to word argv; anything else is already
 * split and passes through verbatim (its elements may legitimately contain
 * spaces — e.g. a filename — and must NOT be re-split).
 *
 * NOT idempotent — tokenizing `['"refs download"']` yields `["refs download"]`,
 * a single element that still carries whitespace and would tokenize again — which
 * is why it stays private: the classifier applies it exactly once and hands the
 * result back in its verdict's `argv`, so no second caller can re-normalize and
 * diverge from what was classified.
 *
 * Accepted ambiguity: a single element that is one spaced operand (a lone quoted
 * filename) is indistinguishable from a packed command and gets tokenized too.
 * Tolerable because a lone operand is never a runnable `inflexa` argv — the root
 * command takes no positional — so the worst case is a malformed verdict handed
 * back to the model, never a wrong spawn.
 */
function toEffectiveArgv(argv: string[]): string[] {
    // `argv[0]!` is sound: the `argv.length === 1` guard proves index 0 exists.
    return argv.length === 1 && /\s/.test(argv[0]!) ? tokenizeArgvString(argv[0]!) : argv;
}

/**
 * Internal control-flow signal: commander's `preAction` hook throws this to abort
 * the parse the instant an action is about to run, handing the resolved leaf
 * `Command` back out. It is caught within `classifyInflexaArgv` (the same function
 * that registers the hook) and never escapes — classification must observe which
 * action WOULD run without letting it run. Not a real error; not exported.
 */
class ClassifiedActionSignal extends Error {
    constructor(readonly actionCommand: Command) {
        super("classified action");
        this.name = "ClassifiedActionSignal";
    }
}

/**
 * The commander exit codes that mean "the CLI only described itself" — help was
 * printed (`--help` on any command, or the `help` command) or the version was
 * printed. Every OTHER commander error code (unknown command/option, missing or
 * excess argument, invalid argument value, missing mandatory option value, …)
 * means the argv did not resolve to a runnable command, i.e. malformed.
 */
const INTROSPECTION_CODES: ReadonlySet<string> = new Set(["commander.helpDisplayed", "commander.help", "commander.version"]);

/**
 * Decide — WITHOUT executing anything — whether an `inflexa` argv is
 * introspection (help/version), a real action, or malformed.
 *
 * The classifier builds a throwaway commander root via {@link buildProgram} (a
 * factory precisely so a dry pass can parse on the side without touching the live
 * `cli` root), silences its output, and registers a `preAction` hook that throws
 * the moment an action would fire. Under `exitOverride`, help/version instead
 * throw a {@link CommanderError}; a parse error throws one too. So parsing the
 * argv yields exactly one of: our action signal, a commander error, or a clean
 * resolve — which map onto the three verdicts.
 *
 * Why the hook (not the resolved command's presence) is the action oracle:
 * commander's `_outputHelpIfRequested` runs BEFORE the `preAction` hook, which
 * runs before the action. So an argv whose only `--help` sits AFTER a `--`
 * separator is a positional operand, not the help flag — it reaches the action
 * and classifies as `action`, not `introspection`. That ordering is the injection
 * defense: a post-`--` `--help` cannot masquerade as an introspection request.
 *
 * @param argv the user-level argv (no node/script prefix). A single element that
 *   contains whitespace is first tokenized quote-awarely, so a caller may pass one
 *   packed command string.
 */
export async function classifyInflexaArgv(argv: string[]): Promise<Classification> {
    const args = toEffectiveArgv(argv);

    const program = buildProgram();
    // Classification is a silent dry run: swallow the help/error text commander
    // would otherwise print to stdout/stderr while we probe how the argv resolves.
    // Each command carries its OWN `_outputConfiguration` (copied from its parent
    // at creation time, before this factory returns), so silencing only the root
    // leaves a subcommand's help/error text — e.g. `refs --help`, or the help a
    // bare `refs` group prints — writing to the real streams. Walk the whole tree.
    const silence = (command: Command): void => {
        command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
        for (const child of command.commands) silence(child);
    };
    silence(program);
    // Abort the parse the instant an action would run, carrying out the resolved
    // leaf command. This throw is internal control flow: it is caught below, in
    // this same function, and never escapes to the caller.
    program.hook("preAction", (_thisCommand, actionCommand) => {
        throw new ClassifiedActionSignal(actionCommand);
    });

    try {
        await program.parseAsync(args, { from: "user" });
    } catch (e) {
        if (e instanceof ClassifiedActionSignal) {
            // Walk parent links from the resolved leaf up to the root, collecting
            // command names, then reverse so the path reads root-first
            // (["inflexa", "refs", "download"]). grantKey is that path joined by
            // spaces — arguments and options are deliberately excluded so every
            // invocation of the same command collapses to one stable key.
            const leaf = e.actionCommand;
            const path: string[] = [];
            let cursor: Command | null = leaf;
            while (cursor !== null) {
                path.push(cursor.name());
                cursor = cursor.parent;
            }
            path.reverse();
            // Which options the invocation EXPLICITLY set, keyed on commander's canonical
            // attributeName (so `--json`, `-j`, and `--json=…` all collapse to one name, a
            // `--no-x` negation reports as `x`, and a post-`--` `--json` — an operand, never
            // parsed as the option — is absent). An option merely defaulted has source
            // "default" and does NOT count: only a source of `cli`/`env`/`config`/`implied`
            // means the caller set it, so `src !== undefined && src !== "default"` is exactly
            // "explicitly set".
            //
            // The names are collected from the WHOLE leaf→root chain (not just `leaf.options`)
            // and each source is read with the *-WithGlobals reader, because commander's
            // default parsing has positional options OFF: the ROOT greedily consumes any
            // option it declares even when placed after the subcommand. That silently hides an
            // explicitly-set option two ways from a plain `leaf.options` + `getOptionValueSource`
            // walk:
            //   - shadowed — `inflexa ls --project x`: both `ls` and the root declare
            //     `--project`, so the value binds on the ROOT and the leaf's local source is
            //     `undefined` though the caller set it explicitly;
            //   - inherited — `inflexa ls --analysis x`: only the root declares `--analysis`,
            //     so it never appears in `leaf.options` at all.
            // Walking the chain's declared attributeNames (deduped via the Set — a shadowed
            // name is ONE attr) and reading each with getOptionValueSourceWithGlobals recovers
            // both. For a root action the leaf IS the root and the same chain walk holds.
            //
            // Accepted conservatism: an inherited flag that is inert on this leaf (the leaf's
            // action ignores a root-only flag it was handed) still counts as "set" and thus
            // escalates an `auto` invocation to the prompt. That is deliberate — "flags only
            // escalate", and a not-known-read-only flag belongs at the prompt — so the worst
            // case is one avoidable prompt, never a free run of an unvetted flag. The root's
            // own `--version` also joins the chain set, but can never carry a non-default
            // source at action time (a real `--version` classifies as introspection before any
            // action fires), so it never escalates in practice.
            const declaredAttrs = new Set<string>();
            for (let node: Command | null = leaf; node !== null; node = node.parent) {
                for (const option of node.options) declaredAttrs.add(option.attributeName());
            }
            const setOptions: string[] = [];
            for (const attr of declaredAttrs) {
                const src = leaf.getOptionValueSourceWithGlobals(attr);
                if (src !== undefined && src !== "default") setOptions.push(attr);
            }
            return { kind: "action", argv: args, path, grantKey: path.join(" "), policy: getAgentPolicy(leaf), setOptions };
        }
        if (e instanceof CommanderError) {
            if (INTROSPECTION_CODES.has(e.code)) return { kind: "introspection", argv: args };
            return { kind: "malformed", message: e.message.trim() };
        }
        // An unexpected throw (neither our signal nor a commander error) is not an
        // approved action. Gating it as malformed is the safe default: the argv did
        // not cleanly resolve to a runnable command, so a caller must not treat it
        // as one.
        const message = e instanceof Error ? e.message.trim() : String(e);
        return { kind: "malformed", message };
    }

    // parseAsync resolved with no throw: a parent group (e.g. bare `refs`) printed
    // its own help and ran no action. That is introspection — it described itself
    // and did nothing to the user's data.
    return { kind: "introspection", argv: args };
}
