## Why

The report path ships with a recurring defect class: **a tool schema, tool description, or agent prompt states a capability the implementation does not provide.** Because prompts and descriptions are the one layer that cannot be typechecked, each instance stays green until an agent acts on the promise — and then fails silently, produces mislabelled output, or burns turns chasing a phantom.

A user-reported incident made the cost concrete. A conversation agent composed a valid report brief, was told to "pass the object directly, not a JSON string", believed it already had, and resubmitted verbatim four times before giving up and advising the user to file a bug against the wrong repository. The brief was recoverable on every attempt. That specific bug is fixed; this change closes the remaining instances of the same class that are reachable by a shipping user.

This is a **pre-ship hardening pass of small, contained fixes**. It is deliberately not the larger rework tracked in issue #197 (brief-aware postcondition, design-system conformance, Chrome sidecar, preview audit), which is scheduled after a proper rebuild of the subsystem.

## What Changes

- **BREAKING (agent-facing): `format` no longer accepts `"pdf"`.** PDF is entirely unimplemented — the value is accepted, threaded into the builder's instruction as `Build a new PDF report.`, never read by the build path, and then persisted and emitted so the UI labels an HTML file as a PDF. The input enum narrows to `"html"`. The downstream `"html" | "pdf"` unions are left intact so previously-persisted previews still parse.
- **Iterating a preview that does not exist fails fast.** Today it silently produces a v1 with no base template, while the builder is told the previous template "is already in your working directory" and forbidden from rewriting — with no brief either. The tool will reject an unknown `previewId` before minting access, staging assets, or spawning the builder.
- **BREAKING (agent-facing): absolute paths are rejected by the version filesystem** instead of being silently rewritten. Both the builder prompt and the `write_file` description already promise rejection; the implementation strips the leading slash, creating a real file in a nested wrong location and returning `ok`. The agent then hunts a phantom Jinja error with no `list_files` to diagnose it.
- **The unavailable preview seam becomes visible to operators and stops emitting a malformed message.** In the OSS build every report reports `preview-access mint failed: status=undefined …` to the model, and nothing is logged, so nobody can tell that visual verification never ran.
- **Four stated capabilities that do not exist are removed from prompts and descriptions**: a `grep` tool on the builder roster, oversized-source "skipping" that is actually a hard failure, a "15-min TTL" that exists nowhere on the path, and a `theme.css` the builder is told to work within but cannot read and which is not in the render path.

## Capabilities

### New Capabilities

None. Every change tightens or corrects behaviour already owned by an existing capability.

### Modified Capabilities

- `iterative-report`: four requirement-level changes — the accepted `format` values, a new precondition on iteration against an unknown `previewId`, the version filesystem's absolute-path contract, and an observability obligation on the preview seam when it is unavailable.

Note: the `iterative-report` spec currently describes a single `iterate_report` tool. That tool no longer exists — it was split into `plan_report` + `submit_report` without a corresponding spec update. The delta in this change is written against the shipped tool names so its requirements are coherent; it does not otherwise attempt to reconcile the spec, which remains tracked separately.

## Impact

**Code**
- `harness/src/tools/iterate-report.ts` — input `format` enum; iteration precondition; the `theme.css` reference in the creation prompt.
- `harness/src/execution/report-runner.ts` — unchanged in behaviour, but the now-unreachable `pdf` branch of its `format` option is documented as inert.
- `harness/src/tools/report/version-fs.ts` — leading-slash paths rejected as `out_of_scope`.
- `harness/src/tools/report/preview-snapshot.ts` — takes a `Logger`; message no longer interpolates an absent status.
- `harness/src/tools/report/mint-preview-url.ts` — TTL claim removed from the description.
- `harness/src/tools/report/submit-report.ts` — the oversized-source "skipped" example removed from the description.
- `harness/src/prompts/report-builder.ts` — `grep` removed from the tool list.
- `harness/src/prompts/conversation.ts` — PDF claim removed from the report guidance.

**Agent-facing behaviour.** Two changes are breaking for an agent mid-conversation rather than for a consumer API: a `format: "pdf"` call is now rejected at the tool boundary, and an absolute path that previously "worked" (`/index.html`) now returns `out_of_scope`. Both failures are immediate and name the correction, and the builder prompt already mandates relative paths.

**Consumers.** None. `PreviewPart.format` and `preview-meta.json` keep their `"html" | "pdf"` shape, so stored previews and the chat-part contract are unaffected.

**Explicitly deferred** (documented, not implemented here): the brief-aware postcondition, design-system conformance checks, a local `PreviewPublisher` plus Chrome sidecar, the preview audit tool, vendoring the CDN dependencies, `data-value` emission for numeric table sorting, the dead `errorKind: "render"` variant, the unenforced three-build-attempt cap, and two managed-only preview defects (`preview_snapshot` reusing a version-pinned URL cell after `mint_preview_url` pins an older version, and `waitForSelector`'s swallowed 5s timeout).
