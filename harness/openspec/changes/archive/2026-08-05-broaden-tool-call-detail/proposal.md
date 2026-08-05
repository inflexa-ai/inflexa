# Broaden call-detail coverage, and make a described call the default

## Why

The mechanism from #287 works; the coverage is thin enough that the transcript still shows the symptom #174 opened with. Thirteen of the harness's tools declare `describeCall`, and only ten of them sit on the conversation agent's 35-tool roster — so the chips a user actually watches still render bare. Four indistinguishable `update_working_memory` chips were replaced by four indistinguishable `list_available_refs` chips. See issue #289.

Coverage alone is a treadmill. The hook is opt-in, so every tool added after this change ships bare by default and the roster decays again. The reason #287 made it opt-in was that some tools take no meaningful input — but that argument only justifies letting an author *decline*, not letting one forget. Requiring an explicit decision keeps the exemption and removes the silence.

The same transcript carries a second, unrelated defect. Every tool call in a dispatch round reports the *round's* wall time as its own duration:

```
list_available_refs  ✓ ok · 481ms
list_available_refs  ✓ ok · 481ms
run_inflexa          ✓ ok · 481ms
```

The loop emits every `tool-started` before it dispatches anything and every `tool-finished` after the whole round settles, so a host bracketing the two events measures the round, not the call. Today this hides behind chips that already look alike. Once each chip carries a distinct detail, three visibly different calls will each assert the same duration — the detail work turns a latent defect into a visible false claim, which is why it belongs in this change rather than after it.

## What Changes

- The seven highest-volume conversation-roster tools gain a hook: `list_available_refs`, `list_available_packages`, `inspect_data_profile`, `generate_plan`, `show_plan`, `show_file`, `show_user`. This takes the roster from 10/35 to 17/35, and to 19/35 with the two host tools in the companion `cli` change.
- Four of those hooks do **not** follow the rule sketched in the issue, because that rule contradicts what the tool does. Each is specified against its `execute` body instead:
  - `list_available_refs` — precedence is `path ?? category ?? query`, matching `execute`'s own `path ?? category` (an explicit `path` wins; `category` is documented as ignored when `path` is given). The issue's order put `category` ahead of `path`. `query` is an orthogonal filter, not an alternative, and `{}` is a legal full-store browse that needs its own line.
  - `list_available_packages` — `names` comes first, because `queryPackages` returns on it before reading anything else and the tool's own description calls it "the cheapest call and the right one for 'is X available?'". The issue's rule omitted `names` entirely, so the dominant call shape would have rendered nothing.
  - `inspect_data_profile` — the hook supplies `scope ?? "overview"` and `page ?? 1` itself. Both fields are optional, so the most common call is `{}` and the issue's rule would have produced no detail for it.
  - `show_file` — reads `files[0].path`, one nesting level below what the issue implies; `.min(1)` on the array is what makes that index total.
- **BREAKING** `defineTool` requires a `describeCall` decision: either a hook, or the literal `"none"`. The sentinel is an authoring-time requirement only — it is never packaged onto the resulting `Tool`, so `Tool.describeCall` keeps its current optional-function shape and every consumer of it is untouched.
- Every existing tool that does not gain a hook declares `describeCall: "none"`. A tool whose input cannot distinguish its calls now says so where a reader will find it, instead of being silently absent.
- The emit-site cap marks a string it actually cut, so a truncated detail no longer reads as a complete one. Every prior hook emits paths and identifiers that fit inside the cap; `generate_plan`'s research question is free-form prose and will essentially always exceed it, making this the first hook where silent truncation is reachable.
- `tool-finished` carries `durationMs`, measured around each call's own dispatch. A host consuming it reports what the call took rather than what its round took.

## Capabilities

### New Capabilities

<!-- None. This change extends capabilities #287 established. -->

### Modified Capabilities

- `tool-call-detail`: the hook becomes a required authoring decision with an explicit opt-out; the emit-site cap marks a truncated detail.
- `harness-tools`: `defineTool` rejects a tool definition that makes no `describeCall` decision.
- `harness-agent-loop`: `tool-finished` reports the call's own elapsed time, measured per call rather than per dispatch round.

## Impact

Harness source:

- `src/tools/define-tool.ts` — the required-or-`"none"` authoring type, and the packaging rule that keeps the sentinel off `Tool`.
- `src/loop/tool-detail.ts` — the truncation mark, and the guard reading a function rather than a presence.
- `src/loop/run-agent.ts` — per-call timing around dispatch, carried onto `tool-finished`.
- `src/contracts/chat-events.ts`, `src/contracts/schemas/chat-events.ts` — `durationMs` on the wire vocabulary.
- The seven tools gaining hooks, plus `src/tools/describe-call.test.ts`, which holds one assertion per shipped hook on the exact string it produces.
- Every remaining `defineTool` site — roughly 40 of the 60 in `src/` — declares the opt-out. Mechanical, but it is the bulk of the diff and it is what the compiler will now enforce.

Sequencing: `tool-call-detail` is a capability #287 introduced and has not yet been archived into `openspec/specs/`, so this change's delta builds on a spec that currently lives only in `changes/add-tool-call-detail/`. The code it describes is already in `src/`. Archive that change before syncing this one, or the delta has nothing to apply against.

Consumers: both the `defineTool` signature and the new event field are breaking for an embedder. The companion `cli` change (`host-tool-call-detail`) consumes them, which means `cli` cannot typecheck until this harness change is released and its pin bumped — the normal shape of a cross-subsystem change in this repo, and the developer driving the PR owns that sequencing.

Out of scope: the bio-tool second pass the issue names (`lookup_annotation`, `chembl`, `pubchem`, `open_targets`, and the rest). They each key off an identifier or an action and are genuinely a natural next pass; they are excluded here to keep one review from carrying triple the hook count. Under the new signature they declare `"none"` until then, which is what makes deferring them visible rather than silent. The result side (`✓ ok` for a call that did nothing) remains issue #281.
