## Why

The conversation prompt assumes an analysis's inputs are fixed at init ("Data profiling runs at analysis init") and gives the agent no guidance for when a user references data files that are not yet inputs. With hosts now able to contribute input-management conversation tools (the CLI's `chat-input-staging` change), the agent should offer to add referenced-but-unstaged data — instead of inventing folder-copy advice — and understand that profiling follows the current inputs, not only init.

## What Changes

- Relax the prompt's "profiling runs at analysis init" assumption to "profiling runs whenever the analysis has inputs — at init, and when inputs are added or removed mid-conversation."
- Add host-agnostic guidance: when the user references data not yet staged as an input, and a host input tool is available, list candidates, confirm, and add — never advise copying files into a folder. The harness names no specific host tool and assumes none; the host tools' own descriptions carry the specifics.

Prompt text only — no runtime behavior changes.

## Capabilities

### Modified Capabilities

- `host-conversation-tools`: the conversation prompt orients the agent to host-contributed input-management tools when the user references unstaged data, host-agnostically (the harness names/assumes no specific host tool), and no longer asserts that profiling happens only at analysis init.

## Impact

- `harness/src/prompts/conversation.ts` (prompt text). No code path changes; the concrete input tools and their descriptions are CLI-owned (companion change `chat-input-staging` in `cli/`).
