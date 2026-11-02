# Tasks

## 1. Declare the part

- [x] 1.1 In `src/contracts/chat-parts.ts`, add `AnalogyReportPart` (`type: "data-analogy-report"`, `id`, `report: AnalogicalReasonerOutput`) to the presentation category of the header and to `KnownChatPart`. In `src/contracts/schemas/chat-parts.ts`, add `AnalogyReportPartSchema` with `AnalogicalReasonerOutputSchema` for `report`, and add it to `ChatPartSchema`. In `src/contracts/part-registry.ts`, add the entry `conversation`, `conversation`, not transient, not reconciling. Export the type from `src/contracts/index.ts` and `src/index.ts`, beside its neighbors. Run `bun run format:file` on each changed file. The tests of 1.3 show that this task is done.
- [x] 1.2 In `src/memory/conversation-display-storage.ts`, add the key `analogy-report` to `ConversationUIData` and `dataSchemas`. Add the type to `StoredSourcePart` and `STORED_SOURCE_TYPES`. Add a case to the write switch and to the read switch. Run `bun run format:file src/memory/conversation-display-storage.ts`. The tests of 1.3 show that this task is done.
- [x] 1.3 In `src/contracts/test/chat-parts.test.ts`, assert that `ChatPartSchema` accepts a `data-analogy-report` part with a report and with an `extraction-failed` envelope, and that the registry entry is durable. In `src/memory/test/conversation-display-storage.test.ts`, assert that the part round-trips field for field. From `harness/`, run `bun test src/contracts/test/chat-parts.test.ts src/memory/test/conversation-display-storage.test.ts`, and make sure that they pass.

## 2. Emit the part

- [x] 2.1 In `execute` of `generate_analogy_report` (`src/tools/research/generate-analogy-report.ts`), emit the `data-analogy-report` part with `source: ctx.session.provenance`, the id `ctx.invocationId`, and the result of the research, then give the same result. Run `bun run format:file src/tools/research/generate-analogy-report.ts`. The test of 2.2 shows that this task is done.
- [x] 2.2 In `src/tools/research/test/generate-analogy-report.test.ts`, assert that a report and an `extraction-failed` envelope each give one `data-analogy-report` part with the root source. Assert that its id is the id of the tool call, and that its report equals the tool result. From `harness/`, run `bun test src/tools/research/test/generate-analogy-report.test.ts`, and make sure that it passes.

## 3. Point the reply to the block

- [x] 3.1 In `src/prompts/conversation.ts` and in the description of `generate_analogy_report`, say that the analogy block shows the report. Tell the agent to name the analogies that matter by their `analogyTitle`, say why they matter for the data, and end with one question. Keep the `extraction-failed` instruction. Run `bun run format:file` on the two files. The test of 3.2 shows that this task is done.
- [x] 3.2 In `src/agents/test/conversation-agent.test.ts`, change the analogy test. Assert that the prompt and the description name the analogy block and the summary. Assert that they do not ask for the full report. From `harness/`, run `bun test src/agents/test/conversation-agent.test.ts`, and make sure that it passes.

## 4. Build

- [x] 4.1 From `harness/`, run `bun run typecheck` and `bun run build`, and make sure that both pass. The cli change reads the new part from `dist/`.
