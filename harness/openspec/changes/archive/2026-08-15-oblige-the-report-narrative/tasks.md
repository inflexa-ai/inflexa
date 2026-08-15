## 1. The obligations

- [x] 1.1 Add the narrative spine to `src/prompts/report-session.ts`, as a compose-first section before the block guidance.
- [x] 1.2 Add the chart-first rule beside the block guidance.
- [x] 1.3 Add the headline obligations beside the metric guidance.
- [x] 1.4 Extend the "Do NOT" list: evidence before its sentence, a figure where a table serves, and a caveated headline.

## 2. The assertions

- [x] 2.1 Extend the prompt tests of `src/agents/report-session-agent.test.ts` for the three obligations.

## 3. The gates

- [x] 3.1 Run the targeted agent test file only.
- [x] 3.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
