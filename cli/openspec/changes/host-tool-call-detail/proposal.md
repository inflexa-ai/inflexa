# Describe the host tools' calls, and report what a call actually took

## Why

The CLI contributes three tools to the conversation agent through the host-tools seam, and none of them describes its calls. `run_inflexa` is the sharpest case: issue #174 named it as a first candidate, and it was the one candidate #287 could not serve, because the harness cannot describe a tool it does not own. The harness half of that gap is closed — `@inflexa-ai/harness` already ships `describeCall`, and its detail resolver already has a passing test proving an embedder-contributed `run_inflexa` resolves. Nothing has wired the real tool up. See issue #289.

The transcript also reports a duration per tool chip that is not the call's own. The harness emits every `tool-started` for a dispatch round before it dispatches anything and every `tool-finished` after the round settles, so the TUI's `Date.now()` bracket around the two events measures the round:

```
list_available_refs  ✓ ok · 481ms
list_available_refs  ✓ ok · 481ms
run_inflexa          ✓ ok · 481ms
```

Today this hides behind chips that already look alike. Once each carries its own detail, three visibly distinct calls will each assert the same figure. The companion harness change measures each call individually and reports it on the event; this change consumes it.

## What Changes

- `run_inflexa` describes its call as the argv that will actually run. The tool's standing invariant is that what the user approves is exactly what executes, so the chip SHALL show the same normalized, display-encoded argv the approval dialog shows — not the raw argv the model submitted.
  - The hook is synchronous and runs before `execute`, so it cannot reach `classifyInflexaArgv`, which is async. It does not need to: the classifier's entire argv normalization is one pure synchronous function, `toEffectiveArgv`, which every runnable verdict returns unchanged. Exporting it gives the hook the exact argv the verdict describes.
- `manage_inputs` describes its call as the action plus what it acts on.
- `list_launch_dir` declares `describeCall: "none"`. Its `inputSchema` is `z.object({})` — the folder is resolved from the analysis anchor inside `execute` — so every call is byte-identical and there is nothing to distinguish. Issue #289 proposed describing it by "the path"; no path exists in the input.
- The TUI takes a tool chip's duration from `tool-finished` when the event carries one, falling back to its own bracket when it does not.
- **BREAKING** consumed, not introduced: `defineTool` now requires a `describeCall` decision, so all three host tools must declare one. This is what makes the `list_launch_dir` opt-out explicit rather than silent.

## Capabilities

### New Capabilities

<!-- None. This change extends existing host-tool and chat capabilities. -->

### Modified Capabilities

- `agent-cli-tool`: `run_inflexa` describes its call with the argv the classifier's verdict describes.
- `analysis-input-management`: `manage_inputs` describes its call by action and target.
- `launch-dir-listing`: `list_launch_dir` explicitly declines a call detail.
- `tui-harness-chat`: a tool chip's duration comes from the harness event when present.

## Impact

CLI source:

- `src/modules/harness/inflexa_classify.ts` — export `toEffectiveArgv`.
- `src/modules/harness/inflexa_tool.ts` — the `run_inflexa` hook, reusing the file's existing `displayArgvElement` so the chip and the approval dialog encode an argv the same way.
- `src/modules/harness/inputs_tool.ts`, `src/modules/harness/launch_dir_tool.ts` — the hook and the opt-out.
- `src/tui/hooks/conversation.ts` — prefer the event's `durationMs` over the local bracket.

Dependencies: this change consumes two things from the companion harness change `broaden-tool-call-detail` — the required-`describeCall` signature and `durationMs` on `tool-finished`. `cli` pins an exact published `@inflexa-ai/harness` (currently `0.17.0`) and CI installs it from npm with a frozen lockfile, so `test (cli)` and `lint (cli)` cannot pass until that harness change is released and the pin bumped. That is the normal shape of a cross-subsystem change in this repo; the developer driving the PR owns the release-and-bump sequencing.

Out of scope: any renderer work. `ToolBlock` already fits a detail to the terminal width and reflows it to its own row, and it already renders a duration — this change only changes where the number comes from. Hook coverage for the harness's own tools is the companion change.
