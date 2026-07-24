## 1. Prompt guidance

- [x] 1.1 Add a "Two filesystem scopes" subsection to the Data Discovery section of `src/prompts/conversation.ts`: the workspace tools see only the analysis tree; a "cwd / this folder / current directory" question is ambiguous; name the scope answered and offer the other in the same turn; reach for a host tool first when the phrasing points squarely at the outside folder. Name no specific host tool.
- [x] 1.2 State `list_files`'s scope in its description (`src/tools/workspace/list-files.ts`): a directory of the analysis's own workspace tree only, never a directory outside it.
- [x] 1.3 `tsc -p tsconfig.json` and `bun test` stay green (prompt and description are string constants — no behavior change).
