## Why

The conversation agent has two distinct filesystem scopes whose vocabulary overlaps: the analysis's own workspace tree (what `list_files` / `read_file` / `workspace_search` see) and the folder the user launched the host from (their shell's current working directory — a host tool's concern). "The cwd", "this folder", "the current directory", and "where I launched from" name either one. With no guidance, the agent silently answers the workspace interpretation, so a user asking about the folder they ran the host in gets the analysis tree instead and must correct the agent explicitly before it reaches for the launch-folder tool. The prompt should teach the agent to recognize the ambiguity and surface both scopes up front rather than force the correction.

## What Changes

- Add host-agnostic guidance to the conversation prompt's Data Discovery section: the workspace file tools see only the analysis tree; a "cwd" / "this folder" / "current directory" question is ambiguous between the two scopes; the agent names which scope it listed and offers the other in the same turn; and when the phrasing points squarely at the outside folder, it reaches for a host tool first. The guidance names no specific host tool and assumes none.
- State `list_files`'s scope in its description: a directory of the analysis's own workspace tree only, never a directory outside it. (The launch-folder / host-tool nuance stays in the conversation prompt and the CLI's `list_launch_dir`, since `list_files` is also a sandbox-agent tool and sandbox agents receive no host tools.)

Prompt + tool-description text only — no runtime behavior changes. The concrete launch-folder tool and its description are CLI-owned (companion edit to `list_launch_dir` in `cli/`, outside this spec).

## Capabilities

### Modified Capabilities

- `host-conversation-tools`: the conversation prompt orients the agent to the two filesystem scopes (the analysis tree vs. the folder outside it) and to disambiguate a "cwd / this folder" question proactively, host-agnostically (the harness names/assumes no specific host tool).

## Impact

- `harness/src/prompts/conversation.ts` (prompt text).
- `harness/src/tools/workspace/list-files.ts` (tool description — scope statement).
- Companion CLI change (not in this spec): `cli/src/modules/harness/launch_dir_tool.ts` (the `list_launch_dir` description owns the "cwd / current directory / where I launched" phrasings).
