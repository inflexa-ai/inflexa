# Proposal

## Why

Issue #811 is the last child of umbrella #608, which turns on the full oxlint preset in cli. The move to oxlint (#610) turned off each preset rule that had reports. The last block, `cli/oxlint.config.ts:257-291`, still turns off 25 rules under the comment `#811`. Without the block, this branch gives 551 reports in 195 files. #608 is not done while a preset rule stays off outside the bun-types pair in the tests.

## What Changes

- Remove the `#811` block of `cli/oxlint.config.ts`. The only `off` entries that stay for a preset rule are the bun-types pair in the tests (`typescript/await-thenable`, `typescript/no-confusing-void-expression`) and the zone blocks of this change.
- Give `instanceofErrorAllowIn` the error normalizer `src/lib/cause.ts`, with its reason (design D3).
- Add the error helpers to `src/lib/cause.ts`: `messageOf`, `errorOf`, and the walk of a cause chain for an errno code. Each site of the repeated `cause instanceof Error ? cause.message : String(cause)` calls `messageOf`. A bare `String(<unknown>)` of a failure value becomes `describeCause` (design D1, D2).
- Fix each report of each rule at its site, with the shapes of design D4 to D14. Where one shape repeats, one shared helper removes it: the byte formatter of the store and rail readouts, the stdin TTY read, the fetch-double readers of the tests, and the save and restore of an environment variable in the tests.
- Each deliberate site keeps its form, with its reason: an inline `oxlint-disable-next-line <rule> -- <reason>` for a `typescript/*` rule, and a zone block in `cli/oxlint.config.ts` (one rule, a reason for each file) for an `@inflexa-ai/*` rule (design D15).
- Change the three interfaces of `src/modules/harness/inflexa_tool.ts` and `src/modules/embedding/local-provider.ts` to types.
- `typescript/explicit-function-return-type` is on. The preset already turns it off in the tests. Each Solid component gets the return type `JSX.Element`, and `cli/CLAUDE.md` drops its JSX exception from the return type rule (design D8).
- Delete the re-export of `AGENT_NAMES` and `AgentName` from `src/modules/harness/agent_switch.ts`, which no importer reads.
- One recorded behavior change (design D1, D2): a failure value that is a non-Error object renders as `type: message` or bounded JSON in place of `[object Object]`, and an `Error` with a `.cause` gains the cause tail where the text used `String(error)`. Each other text stays the same.
- A lint fix does not make a test weaker: no `expect` call goes away.
- Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each decision. Design "The reviewer record" records the votes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `type-strictness`: a new requirement "The remaining preset rules report nothing". No override turns a preset rule off outside the bun-types test block and the zone blocks that name one rule with a reason for each file, and `@inflexa-ai/no-instanceof-error` carries an `allowIn` list with a reason for each entry.

## Impact

- Configuration: `cli/oxlint.config.ts`.
- Docs: `cli/CLAUDE.md` (the return type rule).
- Source: the error helpers in `src/lib/cause.ts`, and the report sites under `src/` and `scripts/` (the list is `tmp/claude/811/811-sites.txt` at the root of the repository). New shared helpers in `src/lib/` and `src/test_support/`.
- Tests: the test files of the report list, and a test for each new helper.
- No wire format, route response, database schema, provenance, or model-facing schema change. No new dependency. No change to the harness.
