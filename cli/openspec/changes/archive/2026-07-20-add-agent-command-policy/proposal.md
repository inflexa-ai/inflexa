# Add Agent Command Policy

## Why

`BLOCKED_COMMANDS` in `run_inflexa` (issue #165) drifted from a courtesy layer over structurally-unrunnable TUI launchers into a load-bearing curated denylist for the infrastructure-lifecycle family — contradicting the tool's stated design ("no per-command list decides what may run"). Nothing enforces that a new command is triaged: a future session-affecting command added to the registry silently becomes approvable through `run_inflexa`, and the policy lives in a string-keyed map far from the commands it governs, coupled only by grantKey spelling — a rename silently orphans an entry.

## What Changes

- Introduce a three-kind `AgentPolicy` — `auto` (runs with no prompt, carrying a `safeFlags` allowlist), `approval` (the default: `ctx.ask`, grantable per analysis), and `blocked` (never runs; mandatory reason handed to the model) — declared **at command registration**, colocated with the command it governs.
- Replace direct commander `.action()` calls in the registry with a registration helper that takes the policy and the handler together, making an unclassified action command a **compile error**.
- Attach policy to the resolved `Command` instance (WeakMap), so the classifier returns it inside its `action` verdict — deleting `BLOCKED_COMMANDS` and every string-keyed policy lookup. **BREAKING** for the internal `Classification` type (verdict gains policy + explicitly-set options); no user-facing CLI behavior changes outside the agent tool.
- `auto` semantics: an invocation runs prompt-free iff every explicitly-set option (matched via the commander parse, not argv strings) is in `safeFlags`; any other invocation **escalates to `approval`** — flags can only escalate, never de-escalate.
- Enforcement layers behind the compile-time gate: an ESLint `no-restricted-syntax` ban on raw `.action(` in the registry, a tree-walk exhaustiveness + policy snapshot test (dev channel forced both on and off, `safeFlags ⊆` declared options), and a runtime fail-closed default (an unclassified action verdict returns `blocked`, never silently approvable).
- Rewrite the `agent-cli-tool` thesis: the registration-declared policy is the floor per command; the approval prompt remains the security boundary **for the approval tier**.
- Add the `cli/CLAUDE.md` rule: when adding a commander command (or an option to an `auto` command), the coding agent must ask the user which policy/safe-flag classification it gets — never guess.

## Capabilities

### New Capabilities

- `agent-command-policy`: the registration-declared agent-availability policy — the `AgentPolicy` type and its required declaration at registration, `safeFlags` semantics on `auto`, the "flags only escalate" invariant, and the enforcement layers (compile-time helper, lint ban, tree-walk/snapshot tests, runtime fail-closed).

### Modified Capabilities

- `agent-cli-tool`: the purpose's "no per-command allowlist" thesis is restated over the three-tier policy; the two curated-denylist requirements (TUI launchers, infrastructure lifecycle) are re-expressed as `blocked` policy declarations consumed from the registry; a new requirement covers `auto` execution (prompt-free run, out-of-set flags escalate to approval, audit posture equal to introspection — no ask-ledger row). The TTY-guard structural backstop and all subprocess-hygiene/grant requirements are unchanged.

## Impact

- `cli/src/cli/index.ts` — every action registration site (~25) moves to the policy-taking helper; policies and blocked reasons live here now.
- New `cli/src/cli/agent_policy.ts` — the `AgentPolicy` type, WeakMap stamp/accessor, registration helper.
- `cli/src/modules/harness/inflexa_classify.ts` — `action` verdict carries the stamped policy and the explicitly-set option names (`getOptionValueSource`).
- `cli/src/modules/harness/inflexa_tool.ts` — `BLOCKED_COMMANDS` deleted; exhaustive switch on policy kind ahead of `ctx.ask`.
- `cli/eslint.config.js` — registry-scoped `.action(` ban.
- Tests: tree-walk exhaustiveness, policy snapshot, safeFlags validation; existing blocked-command tests re-pointed at registration-declared reasons.
- Harness untouched: the ask seam, grant DB, and `grantKey` shape are unchanged (standing grants still key on the subcommand path).
- `cli/CLAUDE.md` — the ask-the-user classification rule.
