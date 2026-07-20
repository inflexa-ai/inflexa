# Tasks — add-agent-command-policy

## 1. Policy module

- [x] 1.1 Create `src/cli/agent_policy.ts`: the `AgentPolicy` union (`auto` + `safeFlags`, `approval`, `blocked` + reason), the `WeakMap<Command, AgentPolicy>` with `setAgentPolicy`/`getAgentPolicy`, and the registration helper that takes policy and action handler together (JSDoc on every export; document the WeakMap choice and the "flags only escalate" invariant)
- [x] 1.2 Unit-test the module: stamped policy is retrievable from the same `Command` instance; helper registers the action handler; distinct `buildProgram()` instances don't share stamps

## 2. Registry conversion

- [x] 2.1 Convert every action registration in `src/cli/index.ts` to the helper, preserving current behavior: `blocked` (with the reasons moved verbatim from `BLOCKED_COMMANDS`) for bare root, `config`, `new`, `resume`, dev-channel `chat`, `up`, `down`, `setup`; `approval` for every other command — no `auto` assignments in this pass
- [x] 2.2 Apply the verified auto classifications from design D9: `sessions`, `ls` (`project`), `project ls`, `auth whoami`, `refs list` (`urls`, `json`), `refs path`, `refs verify` (`json`), `sandbox status`, `prov lineage` (`forward`, `depth`, `format`), `prov verify`, `prov verify-file` — and leave `status` and `open` at `approval` (D9 records why); future commands go through the CLAUDE.md ask-the-user rule

## 3. Classifier

- [x] 3.1 Extend the `action` verdict in `src/modules/harness/inflexa_classify.ts` with the stamped policy (read off `actionCommand`) and `setOptions` — canonical attribute names whose option-value source is not `default`, taken from the resolved leaf
- [x] 3.2 Extend `inflexa_classify.test.ts`: policy rides the verdict; short form / `--opt=val` / negation collapse to one canonical name; a defaulted option is not reported as set; post-`--` operands set nothing

## 4. Tool cascade

- [x] 4.1 In `src/modules/harness/inflexa_tool.ts`: delete `BLOCKED_COMMANDS`; replace with an exhaustive `switch` on the verdict's policy kind (`never`-typed default) — `blocked` → blocked result with the declared reason, `auto` with `setOptions ⊆ safeFlags` → spawn immediately, otherwise fall through to the existing `ctx.ask` approval path; a missing policy → blocked "not classified for agent use" (fail closed)
- [x] 4.2 Update `inflexa_tool.test.ts`: existing blocked/approval expectations hold with reasons now originating at registration; add auto-tier cases (safe-flagged run is prompt-free, out-of-set flag escalates to the ask path, defaulted option does not escalate, unclassified action fails closed)
- [x] 4.3 Update the tool's `description` string if the blocked-family phrasing changed, and refresh the module-header comment to describe the policy cascade

## 5. Static enforcement

- [x] 5.1 Add the `no-restricted-syntax` ban on raw `.action(` calls to `eslint.config.js`, scoped to `src/cli/index.ts` (rule in config with a documented rationale — no inline disables)
- [x] 5.2 Add the tree-walk exhaustiveness test: walk `buildProgram()` with dev-channel commands forced on and off; every action-classified leaf carries a policy; every `safeFlags` entry names a declared option of its command
- [x] 5.3 Add the policy snapshot test pinning the derived `{subcommand path → kind (+ safeFlags)}` table as the audit surface

## 6. Docs and verification

- [x] 6.1 Add the classification rule to `cli/CLAUDE.md`: when adding a command (or an option to an `auto` command), ask the user for its policy/safe-flag classification — never guess; an effect-changing flag becomes a subcommand with its own policy
- [x] 6.2 Run `bun run format:file` on all touched `src/` files, then `bun run typecheck`, `bun run lint`, `bun test` — all green
