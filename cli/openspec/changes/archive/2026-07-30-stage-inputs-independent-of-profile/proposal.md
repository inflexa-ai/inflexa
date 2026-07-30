## Why

Materializing an analysis's input files is currently a side effect of deciding to profile them. `ensureProfileAtParity` returns `skipped_failed` on a `failed` data-profile row (`profile_trigger.ts:233`) — before it reaches `stageAndSeed` (`:239`), the only thing on this path that writes files to disk. So once a profile has failed for any reason, every input the user registers afterwards is recorded in the database and never lands in the workspace tree: `list_files` shows nothing, the sandbox mounts nothing, and no notice is raised (the skip is silent by design, `profile_parity.ts:347-351`). Recovery requires a deliberate re-profile, which nothing tells the user to perform.

Two specs disagree about this today, and the implementation follows the wrong one. `analysis-input-management` promises that a mutation's drift "SHALL detect the drift and re-profile", with "Materialization SHALL remain owned by `input-staging`"; `tui-harness-chat` says a `failed` profile gets "no auto-retry". On a `failed` row the second wins, the first is silently false, and — because `input-staging` owns the mechanism but the parity ladder owns the only trigger — materialization has no caller at all. This surfaced as inflexa-ai/inflexa#258, where the reporter read the resulting state as a staging/profiling race; it is not a race, it is a terminal state with no recovery edge and no feedback.

## What Changes

- **Materialization is no longer conditioned on the data-profile lifecycle.** The parity drive stages the current input set whenever that set is not already materialized, independent of whether the ledger row is `pending`, `failed`, `completed`-and-drifted, or absent. Profiling becomes a separate decision made after staging.
- **Drift re-profiles regardless of the prior outcome — the `failed` special case is removed, not extended.** The ladder currently treats a `failed` row as a permanent exception to the drift rule. It instead follows the same rule every other state follows: if the input set changed, re-profile. The anti-loop guarantee the exception existed to provide is preserved by the drift condition itself, since a retry is reachable only through a fresh user edit and cannot fire unattended. A failure recorded against the *same* input set is still left for the deliberate re-trigger. **BREAKING** relative to the current `tui-harness-chat` requirement that a `failed` profile gets no auto-retry at all.
- **A live `running` profile still suppresses staging.** `stageInputs` rm/relinks the shared `data/inputs` tree and reconcile-deletes files absent from its own manifest, so mutating that tree under a sandbox that is reading it is a real fault (already noted as `TODO(robustness)` at `profile_trigger.ts:136`). The existing `already_running` skip is retained deliberately, and the completion edge is widened so the deferred work is not lost.
- **The completion edge covers failure, not just success.** Parity edge 3 fires only on `running → completed` (`profile_parity.ts:209`), so inputs registered during a run that then fails are skipped twice — once as `already_running`, then never re-checked. It fires on both terminal transitions.
- **The staged tree becomes an honest record of what was staged, so repeat checks stay cheap.** Whether an input set is already materialized is answered from the staged tree itself, at stat cost, with no new persisted file and no content hashing. This requires one correctness fix: the cross-filesystem `copyFileSync` fallback does not preserve the source's mtime, so a copied file's staged mtime is its copy time and cannot be compared against the source. The copy path preserves it; the hardlink path must not touch it (a hardlink shares the source inode, so stamping it would rewrite the user's own input file's mtime).

Not changed: the no-litter policy (`data-profile-launch`) still holds — staging happens only on deliberate flows (opening an analysis, editing its inputs, the profile/run commands), never on a passive read. `inflexa profile` and `inflexa run` keep staging unconditionally; they are deliberate acts and the repair path when the tree is wrong.

## Capabilities

### New Capabilities

<!-- None: this repairs the contract between two existing capabilities rather than introducing one. -->

### Modified Capabilities

- `tui-harness-chat`: the parity ladder stages the current input set before the profile-status gates rather than after them, so a `failed` (or otherwise non-triggering) row no longer withholds materialization; drift re-profiles a `failed` row as it already does a completed one; the completion edge re-checks on `running → failed` as well as `running → completed`.
- `input-staging`: staging is specified as materialization that is independent of the data-profile lifecycle, with an already-materialized predicate derived from the staged tree, and mtime preservation on the copy fallback so that predicate holds in both placement modes.

## Impact

- `cli/src/modules/harness/profile_trigger.ts` — the parity/force ladders and `stageAndSeed`.
- `cli/src/tui/hooks/profile_parity.ts` — the completion edge's transition predicate and the outcome→notice mapping for the newly distinguishable states.
- `cli/src/modules/staging/staging.ts` — the already-materialized predicate and the copy-fallback mtime fix.
- Tests: `profile_trigger.test.ts` pins the current behavior explicitly (`"a failed row is skipped_failed — never staged, seeded, or triggered"`, asserting `{stage:false, seed:false, trigger:false}`) and must be revised, not merely extended.
- Deliberately **not** touched: `analysis-input-management` and `cli/src/modules/harness/inputs_tool.ts`. That capability's requirement — a registered input is materialized by `input-staging` and re-profiled by the parity engine — is repaired here by making it true, not by restating it. Its spec also lives in the completed-but-unsynced `chat-input-staging` change, so a delta against it would make this change unarchivable until that one syncs, for no added normative content.
- Companion harness change: `data-profile-failure-diagnostics` (in `harness/`) covers why the underlying failure was unreadable. Independent of this change; neither blocks the other.
