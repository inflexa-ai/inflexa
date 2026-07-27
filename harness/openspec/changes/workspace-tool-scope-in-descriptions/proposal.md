## Why

The agent has two distinct filesystem scopes whose vocabulary overlaps: the analysis's own workspace tree (what `list_files` / `read_file` / `grep` / `workspace_search` see) and any directory outside it — for an embedder that runs on a user's machine, the folder the user launched the host from. "The cwd", "this folder", "the current directory", and "where I launched from" name either one. Nothing in the workspace tools' descriptions said which scope they answer, so an ambiguous ask routed to the workspace tools by default and the user had to correct the agent.

The fix belongs in the tool descriptions, not the conversation prompt. A tool is self-describing at attach time — its `description` is the whole of what an agent knows about it, and the reason nothing downstream needs to restate it (`harness/CLAUDE.md`, Prompt Design Principles §8). A prompt that restated the workspace tools' scope would also have to presuppose that a host tool covering the other scope exists, which the `host-conversation-tools` seam forbids: the harness learns nothing domain-specific about a host tool.

## What Changes

- State `list_files`'s scope in its description: a directory of the analysis's own workspace tree, and nothing outside the analysis — including the host process's current working directory. Context-neutral, because `list_files` is also a sandbox-agent tool and sandbox agents receive no host tools: it disclaims the outside scope without asserting that anything else covers it.

Tool-description text only — no runtime behavior change, and no conversation-prompt change. The concrete launch-folder tool that claims the "cwd / this folder" phrasings is CLI-owned (companion edit to `list_launch_dir` in `cli/`, outside this spec).

## Capabilities

### Modified Capabilities

- `harness-workspace-tools`: a workspace file tool's description states the scope it answers, so an agent can tell a workspace-tree question from one about a directory outside the analysis without prompt-level guidance.

## Impact

- `harness/src/tools/workspace/list-files.ts` (tool description — scope statement).
- Companion CLI change (not in this spec): `cli/src/modules/harness/launch_dir_tool.ts` (the `list_launch_dir` description owns the "cwd / current directory / where I launched" phrasings).
