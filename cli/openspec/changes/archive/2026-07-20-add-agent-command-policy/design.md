# Design — add-agent-command-policy

## Context

`run_inflexa` classifies an argv by parsing it against the real commander tree (`classifyInflexaArgv`), then consults `BLOCKED_COMMANDS` — a string-keyed map in `inflexa_tool.ts` — before raising `ctx.ask`. The classifier already resolves the leaf `Command` object (the `preAction` hook carries `actionCommand`) and then discards it, keeping only the path string. That discard is what forces policy to live in a separate map coupled to the registry by grantKey spelling — the split-brain issue #165 describes. The harness ask gateway is not part of the problem: `ctx.ask` already short-circuits on a standing per-analysis grant (`selectGrant`) before prompting, and stays unchanged.

Stakeholders: the conversation agent (what it may run), the user (what they are asked about), and future contributors adding commands (what they must declare).

## Goals / Non-Goals

**Goals:**

- One source of truth: agent availability is declared at command registration, next to the command it governs.
- Structural exhaustiveness: an action command without a policy cannot compile; every later layer fails closed.
- A prompt-free tier for genuinely read-only invocations, gated so it can never silently widen.
- Preserve the approval-tier boundary exactly as-is (exact-argv display, per-analysis grants, denial path).

**Non-Goals:**

- No change to the harness ask seam, grant storage, or `grantKey` shape (grants still key on the subcommand path; a rename orphans a grant, which merely re-prompts once).
- No flag-aware grant keys for `approval` commands — the accepted trade-off documented at the `ctx.ask` call site stands; nothing here forecloses revisiting it.
- No OS-level enforcement of read-only-ness (landlock/sandbox spawning) — out of proportion for the CLI shelling out to itself.
- No behavior change for human-invoked CLI use.

## Decisions

### D1: Policy is attached to the `Command` instance, not keyed by string

A `WeakMap<Command, AgentPolicy>` in a new `cli/src/cli/agent_policy.ts` (`setAgentPolicy`/`getAgentPolicy`), populated during `buildProgram()`. The classifier reads the policy off the resolved leaf and returns it inside the `action` verdict; `inflexa_tool.ts` switches on it. There is nothing to orphan on a rename because the policy travels with the object.

Alternatives rejected:
- **Keep a map / build-time codegen sets** — preserves the string coupling and adds an artifact to sync; the sets exist only because policy was remote from the command.
- **Subclass `Command` with a chainable `.agentPolicy()` setter** — optional by construction; a forgotten call compiles fine, which defeats the point.

### D2: A registration helper couples policy and handler; omission is a compile error

The registry stops calling commander's `.action(fn)` directly. The helper takes `(command, policy, handler)`, stamps the WeakMap, and registers the action — the policy is a required parameter, so the compiler is the primary exhaustiveness gate. Parent groups without actions need no policy (a bare group prints help → classified introspection).

### D3: Three kinds; TUI launchers are just `blocked`

```ts
type AgentPolicy =
    | { kind: "auto"; safeFlags: readonly string[] }
    | { kind: "approval" }
    | { kind: "blocked"; reason: string };
```

A separate `tui` kind was considered and rejected: it distinguished documentation, not behavior — both mapped to the identical blocked result before `ctx.ask`. The `reason` string carries the why; the TTY guard (`requireInteractiveTerminal`) stays in the launchers as the structural backstop, orthogonal to the policy type.

### D4: `auto` gates on explicitly-set options, matched via the commander parse

An `auto` invocation runs prompt-free iff every explicitly-set option on the resolved leaf is in `safeFlags`. "Explicitly set" is a **defined** option-value source other than `default` (`source !== undefined && source !== "default"` — an option never mentioned has an `undefined` source and must not count as set), keyed on commander's canonical `attributeName` — never an argv string match. Short forms, `--opt=val`, and `--no-x` negations collapse to one key; a post-`--` `--help` is an operand. This is the same commander-as-oracle rule the classifier already lives by.

The invariant: **policy is the floor; flags only escalate.** An out-of-set flag escalates `auto → approval` (prompt, grantable) — never to `blocked`, because "not known read-only" is exactly what the prompt boundary exists for. Nothing de-escalates.

A safe flag is one where **every value it can carry leaves the command read-only** (output-shaping: `--json`, `--urls`). Value-dangerous options (`--output <file>`) are by definition effect-changing and never safe-listed, so the mechanism needs no value inspection. An `auto` declaration asserts read-only-ness over the command's whole positional domain too — positionals select what to read, they cannot escalate.

Alternatives rejected:
- **Annotate the option site** (`.option(..., { safe: true })`) — perfectly colocated but wraps commander's heavily-overloaded `.option()` API for a bit only `auto` commands need; the command-site array plus a `safeFlags ⊆ declared options` test is equally sound with less machinery.
- **Effect ontology** (declare `reads-local`/`writes-fs`/`network`, derive tiers) — cleaner in theory, a bigger vocabulary to misdeclare in practice for ~30 commands.
- **Enumerate approved argv shapes** — combinatorial and subsumed by parsed-option matching.
- **Pin the auto commands' option surface in a snapshot** (earlier iteration) — a CI-time compensating control, superseded by this structural runtime control; the snapshot remains as audit, below.

### D5: Four enforcement layers, outermost first

1. **Compile time** — the helper's required policy parameter (D2).
2. **Lint** — `no-restricted-syntax` ban on raw `.action(` calls, scoped to the registry in `eslint.config.js` (rule taught in config, not per-site disables).
3. **CI tests** — a tree-walk over `buildProgram()` with the dev channel forced both on and off: every action-classified leaf carries a policy; every `safeFlags` entry names a declared option; plus a snapshot of the derived `{grantKey → kind (+ safeFlags)}` table so any policy change is a one-file reviewable diff. Validation lives in tests, not in `buildProgram()` itself — a policy typo must not brick the user's CLI at startup.
4. **Runtime fail-closed** — an `action` verdict with no stamped policy returns `blocked` ("not classified for agent use"). Drift fails closed, never silently approvable.

### D6: `auto` audit posture equals introspection

`auto` runs skip the gateway entirely, so they leave no ask-ledger row — unlike grant-covered runs, which are deliberately recorded (`insertGrantedAsk`). This is accepted and stated: `auto` is a curated extension of the introspection tier; the run itself still lands in thread history as a tool result. Ledger parity would need a harness-side "record without asking" API — deliberately not built.

### D7: Design norm — an effect-changing flag should be a subcommand

`safeFlags` stays small only if flags never change a command's effect class. Recorded as a norm (spec design note + `cli/CLAUDE.md`): a flag that would flip read↔write becomes a subcommand with its own compile-required policy (`run status` shape, not `run --status`). Existing commands are not restructured by this change.

### D8: The coding agent asks; it never guesses a classification

`cli/CLAUDE.md` gains the rule: when adding a command, or an option to an `auto` command, ask the user which classification it gets. The compile error forces the question to exist; the rule forces the user to be the one who answers it.

### D9: The initial auto set is verified per command, not assumed

The user's rule for the initial pass: verified read-only ⇒ `auto` by default. Each entry below was verified against its action implementation — a command whose code writes anything (however benign) stays `approval`.

| Command | safeFlags | Evidence of read-only-ness |
|---|---|---|
| `sessions` | — | reads only, "no row is created or modified" (`sessions.ts`) |
| `ls` | `project` | reads; cached path used deliberately, "no reconciliation side effects" (`ls.ts`) |
| `project ls` | — | `listProjects` + per-project count queries (`project.ts`) |
| `auth whoami` | — | local JWT decode, "without any network round-trip" (`whoami.ts`) |
| `refs list` | `urls`, `json` | lstat walk vs the baked-in catalog constant (`store.ts` `inspectReferenceStore`) |
| `refs path` | — | prints the store path (`commands.ts`) |
| `refs verify` | `json` | hashes files against receipts "without mutating disk" (`store.ts` `verifyReferenceDatasets`) |
| `sandbox status` | — | "read-only diagnostic … must not write config" (`pull.ts`); runtime `image inspect` is a query subprocess |
| `prov lineage` | `forward`, `depth`, `format` | graph walk + print; no write imports (`lineage.ts`) |
| `prov verify` | — | chain/signature check; fs imports are `readFileSync`/`existsSync` only (`verify.ts`) |
| `prov verify-file` | — | same module, sidecar read + verify (`verify.ts`) |

Deliberately **excluded** from auto despite looking read-only:

- `status` — `resolveContext` resolves anchors with the default `touch: true`, which writes a `last_seen` heartbeat and can self-heal a cached path (`anchor.ts` `resolveAnchor`). The anchor doc itself warns that non-user-driven resolves make `last_seen` measure agent I/O instead of folder liveness — an agent auto-running `status` is exactly that. Stays `approval` unless a `touch: false` read path is introduced later.
- `open` — launches the OS file browser: an external effect, not a read.

## Risks / Trade-offs

- [Stale `safeFlags` after an option rename] → dead entry is fail-safe (invocation prompts); the `⊆ declared options` test surfaces it loudly.
- [New read-only flag forgotten from `safeFlags`] → one unnecessary prompt per analysis, never a hole; snapshot diff prompts the reviewer.
- [Misdeclared `auto` on a mutating command] → the real residual risk; mitigated by the ask-the-user rule, the snapshot review surface, and (phase 2, optional) spawning `auto` invocations with a marker env the domain mutation chokepoints assert against — worth doing only after verifying the write chokepoints are narrow.
- [Unknown-flag window] → none: before a flag ships, commander parses it as an error → `malformed` → returned to the model without running. The gate matters exactly from the day the flag exists, which is the day it does its job.
- [Policy check ordering vs stale grants] → policy runs before `ctx.ask`, so a command reclassified `blocked` wins over an old "always" grant.
- [~25 registration sites edited at once] → mechanical, but the tree-walk + existing blocked/approval tests pin behavior; the classifier and tool tests keep their current expectations except reasons now originate at registration.

## Migration Plan

Single PR within the CLI subsystem: add `agent_policy.ts` → convert registration sites → extend classifier verdict → replace `BLOCKED_COMMANDS` with the policy switch → add lint rule + tests → sync specs. No data migration; standing grants are untouched and remain valid. Rollback is a revert — no persisted state depends on the new shape.

## Open Questions

- Whether phase-2 runtime hardening (read-only marker env asserted at `tryMutation`/download paths) is worth its invasiveness — deferred until the chokepoint survey.
