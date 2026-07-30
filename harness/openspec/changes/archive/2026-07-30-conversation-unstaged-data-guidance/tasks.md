## 1. Prompt guidance

- [x] 1.1 Relax the "Data profiling runs at analysis init" anti-pattern line in `src/prompts/conversation.ts` to "profiling runs whenever the analysis has inputs — at init, and when inputs are added or removed during the conversation."
- [x] 1.2 Add host-agnostic guidance in the Data Discovery section: when the user references data not yet staged, offer to add it via a host input tool if available (list → confirm → add), never advise copying files into a folder; name no specific host tool.
- [x] 1.3 `tsc -p tsconfig.json` and `bun test` stay green (prompt is a string constant — no behavior change).
