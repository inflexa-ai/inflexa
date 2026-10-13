# Design

## Context

Refer to `proposal.md` for the defects. The four fixes are independent, and each one stays in its module:

- `src/modules/prov/lineage.ts`: `resolveLineageRef` compares each `inflexa:hash` value as a full string. The kernel copies the stored value, thus a hash has the form `sha256:<hex>`. The harness accepts each `<algorithm>:<hex>` form (`hasValidContentHash` in `harness/src/lib/fs-helpers.ts`). The test fixtures use hashes with no colon.
- `src/server/sandbox_gate.ts`: `readSandboxReadiness` calls `takeFarmCompositionFailure`, which clears the in-memory record of `src/modules/libs/composition.ts`. The GET route and the gate share that read through `SandboxGateOpts.readiness`.
- `src/server/routes/analyses.ts`: `POST {A}/inputs/remove` returns at the first failed `removeInput`.
- `src/tui/commands.tsx`: `workspaceBusyReason` calls `fetchAnalysis` with no `touch` value.

## Goals / Non-Goals

**Goals:**

- Each fix has a test that fails before the fix and passes after it.
- No wire type changes.

**Non-Goals:**

- The agent tool `manage_inputs` (`src/modules/harness/inputs_tool.ts`) also stops at the first failed removal. Its result goes to the agent, and no spec covers its partial failure. This change does not touch it.
- The background drift watcher (`src/server/profile_queue.ts`) asks the gate, and it logs a refusal at debug level only. Thus it can clear a farm failure that no person sees. This change keeps that behavior.
- `PUT {A}/inputs` reports only its first failure. This change does not touch it.
- An input entity is not addressable by hash. This change does not touch that.

## Decisions

### D1. The lineage resolver splits a hash at its first colon

A private helper in `lineage.ts` splits a string at its first colon into a scheme and a digest. A string with no colon has no scheme, and all of it is the digest. The exact tier and the prefix tier compare digests:

- The scheme of the reference is absent, or it is equal to the scheme of the stored hash.
- The exact tier needs equal digests.
- The prefix tier needs a reference digest of at least `MIN_HASH_PREFIX` characters, and the stored digest must start with it.

`shortHash` shows the first 12 characters of the digest. Thus a copied label resolves as a prefix. The full hash stays in the JSON output and in the candidate lists.

Alternatives:

- Remove the literal `sha256:` text only. Rejected, because the harness accepts each algorithm name.
- Keep the minimum on the full reference. Rejected, because `sha256:a` then passes with one digest character.
- Keep `shortHash` as it is. Rejected, because its `sha256:` and 5 hex characters fall below the new minimum, and the copied label stops resolving.

The path tier runs first, thus a path that contains a colon still resolves as a path.

### D2. The readiness read peeks, and the gate takes

`composition.ts` gets `peekFarmCompositionFailure`, a read that does not clear the record. `readSandboxReadiness` uses it.

`SandboxGateOpts` gets a `takeFarmFailure` member, with the production value `takeFarmCompositionFailure`. `sandboxRefusal` reads the machine, then it takes the record, and it gives the taken reason to `machineRefusal` as `farm.failure`. The gate uses the taken value, not the peeked value. Thus, when the farm check gives the refusal, the gate names each record that it clears.

The gate keeps its current semantics: it clears the record each time it reads the machine. If an image refusal or a store refusal comes first, the gate clears the record and does not name it. Then the next drive composes again, as today. A live transfer still refuses before the machine read, thus the record stays for the next drive.

`readSandboxReadiness` gets an options parameter, `SandboxReadinessOpts`, with a `DEFAULT_SANDBOX_READINESS_OPTS` value. Its members are the image read (production: `imageReadiness`) and the store read (production: `inspectStoreContent`). A test replaces the two reads. Then it calls the real `readSandboxReadiness` and the real gate, with no container engine. The engine read of `ensureRuntime` probes the engines, and it can write the configuration, thus a test must not call it.

The image read of the readiness must not write the configuration either. Today `imageReadiness` calls `ensureRuntime`. If no runtime is selected, `ensureRuntime` writes the detected runtime to the configuration.

`src/lib/config.ts` gets a read that resolves the runtime as `ensureRuntime` does, but writes nothing. `ensureRuntime` uses that read, and then it writes the selection. `imageReadiness` uses the read. The selected runtime is still probed alone, and its failure keeps the `inflexa setup` hint. `inspectSandbox` (`src/modules/libs/pull.ts`) states the same rule for a passive inspection.

Alternatives:

- A flag on `readSandboxReadiness` that selects a peek or a take. Rejected, because one option must not change the effect class of a read (`cli/CLAUDE.md`).
- The gate clears the record only when its refusal names the failure. Rejected, because it changes the gate beyond the issue.

The stale comments that say the readiness read consumes the record change with the code: `src/api/runs.ts` (`farm.failure`), `src/tui/hooks/sandbox_gate.tsx`, and the JSDoc of `readSandboxReadiness` and `sandboxRefusal`.

### D3. The removal route collects the failures, then answers 500

The route keeps its own loop over the matched inputs. A failed removal goes into a list, and the loop continues. After the loop, if the list is not empty, the route logs each failure with its cause, and it answers 500 `internal_error`. The message names each failed input and each removed input, by the stored `path`. If the list is empty, the answer is the current `InputsChange`.

`AnalysisRouteOpts` gets a `removeInput` member, with the production value `removeInput` from `src/modules/analysis/analysis.ts`. Thus a route test can make one removal fail. The other route dependencies use the same pattern.

Alternatives:

- Answer 200 with a new failure field in `InputsChange`. Rejected, because `PUT {A}/inputs` reports the same failure class as a 500. The error contract of `local-server` also has no partial-success shape, and `InputsChange` serves three routes.
- Call `applyInputsDiff` with no adds. Rejected, because its failure carries no input to name, and a test cannot make one removal fail through it.

The TUI and the CLI need no change. Each one shows the message of a 500 already. The input-change watch re-profiles after each removal that emitted `prov.input_removed`.

### D4. The busy read sends `touch: false`

`workspaceBusyReason` passes `touch: false` to `fetchAnalysis`. `workingDirFor` and `openTarget` keep the sighting, because each one is an open.

## Risks / Trade-offs

- [A reference with the scheme and 6 or more hex characters] → It still resolves. The scheme matches, and the digest part is long enough.
- [The tree output changes its short hash form] → The tree is the output for a person. A script uses `--format json`, which keeps the full hash.
- [The TUI does not refresh after a 500 for a partial removal] → The workspace poll reads the input count again at its next tick.
