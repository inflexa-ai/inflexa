# Live E2E findings — embed-conversation-agent

Same discipline as changes C and F: the walking skeleton was driven end-to-end against
the live local stack (proxy `inflexa-dev-cliproxy`, Postgres `inflexa-dev-postgres`,
`sandbox-base:latest`) on analysis A1 (`019f23b7-917c-7000-b49f-81dabfedd420`, the
GSE78220 transcriptomics dataset). Runs were bounded for credit/time frugality.

## What the skeleton proved (13-sequencing-memo §3 verification statement)

1. **`assembleCoreRuntime`'s first-ever production execution** — boot assembled a
   working runtime over the cli's seam realizations (registration cohort, ephemeral
   sweep, conversation agent build). `BOOT OK` on every run; no assembly bug surfaced.
2. **The proxy-backed provider sustains the conversation agent's tool loop** — real
   turns streamed answers token-by-token through `createStreamingChat`; the 40-tool
   agent drove `generate_plan` (the 13-iteration inner planner) to a presented plan.
3. **The pg thread machinery round-trips** — turn 2 correctly recalled the exact phrase
   from turn 1 (proving `loadRecent` window + working-memory render + analysis-context
   injection assemble across turns); 6 messages persisted to `messages` under the
   thread, `appendTurn` advisory-locked as designed.
4. **The full product loop closes** — chat drafted plan `pln-beb09e5e`, presented it
   (`data-plan`), took conversational approval, and `execute_plan` launched a real
   `executeAnalysis` run `911a7c20-3425-42f2-96af-0e394637e0fc` whose
   **`cortex_runs.thread_id = 019f3ed5-85c7-7000-95a7-87eb72235e1f`** — the chat's own
   thread (title = the opening user message). Unambiguous against the baseline: every
   prior A1 run (launched via `inflexa run --plan`) carries a NULL `thread_id`. This is
   the conversation→run lineage stamp the design (D4) and RQ6 build on.
5. **The emit sink carried all categories** (deltas / orchestration events / data parts)
   through one in-process printer without ordering surprises.
6. **Abort + lock** — mid-turn Ctrl+C aborted the turn (partial persisted, back to the
   prompt) without killing the process; a concurrent `inflexa profile` on the held
   analysis was refused with the lock message pre-boot; clean exit at the idle prompt
   drained DBOS and released the locks (exit 0).

## Findings

### F1 — No chat-model boot probe; a dead-but-Claude model passes the guard (environment; potential follow-up)

The boot auto-resolves the chat model from the proxy's `/models` when
`harness.model` is unset (`resolveModelId` → `pickDefaultModel`). The proxy advertised
`claude-3-7-sonnet-20250219` as its default, which the proxy itself 404s /
`not_found_error`s on — so the first real turn failed with
`model: claude-3-7-sonnet-20250219`, not boot. The `autoResolvedModel && !includes("claude")`
guard at `runtime.ts:296` only rejects non-Claude auto-picks; a dead *Claude* id slips
through. Symmetric with the existing memory `proxy-advertises-unserveable-models`.
Boot already probes the *embedder* before committing (`probeEmbeddingProvider`) but does
**not** probe the chat model. Worked around for the session by pinning
`harness.model = claude-sonnet-4-6` in config. Out of scope for this focused change; a
one-turn chat-model probe at boot (mirroring the embedder probe) is the natural fix —
candidate for a small follow-up.

### F2 — `data-run-card` has no `status` field (spec-vs-code; reconciled in verify)

Design D5 / task 4.3 said the printer renders "run id + status", but `RunCardPart`
(`harness/src/contracts/chat-parts.ts`) / `RunCardData`
(`harness/src/memory/card-builders.ts`) expose only `{id, runId, planId, title,
stepCount}` — there is no status on the part. The printer renders what the contract
carries (`runId: title (N step(s))`). Reconciled in `/opsx:verify`: the `chat-command`
spec requirement and design D5 wording were corrected to "run id, title, step count"
(code is right; the wording was aspirational).

### F6 — abort persists the user message only, not the partial assistant output (spec-vs-code; reconciled in verify)

The `chat-command` "Interrupt aborts the turn" requirement and design D7 initially said
"whatever the loop produced before the abort SHALL still be persisted." In reality
`runAgent` throws on abort *before* returning its message array (`ai-sdk.ts` re-throws
the AbortError; `resultStep`→`unwrapOrThrow` propagates it), so the caller has no partial
output to persist — only `[userMessage]` is written; streamed tokens stay on the terminal
but do not enter the thread. Making the code match the original wording would require a
harness change to `runAgent` (return-on-abort), which design D10 forbids. Reconciled in
verify: the requirement, its scenario, and D7 now state the honest behavior.

### F7 — pre-existing deep import in the embedding module (fixed in verify)

Verify found `cli/src/modules/embedding/local-provider.ts` deep-imported `ProviderError`
/ `toProviderError` from `@inflexa-ai/harness/providers/errors` — pre-existing, unrelated
to this change, but it falsified the `harness-runtime` "imports through the barrel"
requirement that this change re-asserts (MODIFIED to extend the barrel list). Rather than
sync a knowingly-false requirement, the two symbols were added to the harness barrel
(additive rider, the D10 discipline) and the import switched to the bare barrel. No
behavior change; `src/modules/harness/` was already barrel-clean.

### F3 — Streaming was initially non-live, now fixed

First implementation passed the raw `ChatProvider` to `runAgent`, whose loop calls the
non-streaming `provider.chat` — answers rendered whole at turn end. Fixed by wrapping
with the harness's `createStreamingChat` (barrel-exported as an additive rider), which
drives `chatStream` and forwards deltas to the printer. Verified live: answers now
stream token-by-token.

### F4 — Intermediate assistant prose in multi-tool turns (cosmetic, accepted)

`finalText` returns only the last assistant message's text, so prose emitted *before* a
tool-call iteration is not part of the fallback render. Live streaming softens this (the
prose streams as produced); tool chips still show. Acceptable for the skeleton.

### F5 — A clean chat exit leaves the launched run `running` in the ledger (expected)

After the driver exited, run `911a7c20…` remained `status = running` with no host
driving it and no sandbox container alive (verified: no non-infra containers). This is
the documented "run left by a dead process" state — DBOS marks in-flight workflows
recoverable on shutdown, and the reaper/recovery handle it on the next boot. Not a bug;
the cli deliberately does not raw-SQL harness-owned tables to force a terminal status.

## Harness `runtime.ts` line note

Because F1's pin added `harness.model`, the model-resolution branch (`runtime.ts:282-298`)
was exercised on the configured path, not the auto-resolve path — both are covered by
the offline sequencing test; the live runs exercised the configured branch.
