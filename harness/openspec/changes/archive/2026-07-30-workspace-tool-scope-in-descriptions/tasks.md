## 1. Tool description

- [x] 1.1 State `list_files`'s scope in its description (`src/tools/workspace/list-files.ts`): a directory of the analysis's own workspace tree, never a directory outside the analysis, including the host process's current working directory. Keep it context-neutral — no host-tool wording, since sandbox agents share this tool and receive no host tools.
- [x] 1.2 `tsc -p tsconfig.json` and `bun test` stay green (the description is a string constant — no behavior change).
