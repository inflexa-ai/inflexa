# Design — display realization (CLI side)

## The organizing split: content shape, not tool

The harness display tools are not the right axis for the CLI realization —
content is either **text-shaped** or **pixel-shaped**, and that determines
everything:

- Text-shaped (`show_user` `markdown`/`code`/`table`): renders inline,
  natively. The TUI already ships a `<markdown>` renderable
  (`message_block.tsx`); `code` becomes a fenced block and `table` a markdown
  table fed to the same renderable. No new display tech.
- Pixel-shaped (`show_user` `echart`/`svg`, `data-file-reference` files,
  `data-report-preview`): a terminal cannot paint it, so the realization is
  one shared affordance — an **openable card** that opens the content in the
  default OS application (browser, image viewer, …).

## Open-time resolution (the front+back future)

The managed deployment already treats cards as semantic references resolved by
the host at render time (`show_file` → artifact service; `data-report-preview`
→ tokenized content-server URLs via the harness's `content-url.ts`). The CLI's
openable card is the local realization of that same seam, and it MUST preserve
the property: **the card part stores the reference (paths, previewId, embedded
spec, pres-id), never a resolved location.** Resolution happens at open time:

- today: workspace file path (`resolveWorkspaceRoot(analysisId)` + the
  analysis-rooted path) or a materialized cache file, opened via the OS opener;
- future: the planned local front+back architecture (CLI as client, a local
  webserver serving assets/pages) swaps the resolver to `http://localhost:…`
  URLs — a pure host-side change, no transcript migration, no contract change.

## Materialization: interim by design

`echart` and `svg` presentations aren't files yet, so opening them requires
materializing one:

- `svg` → write the markup as `<pres-id>.svg` (browsers render bare SVG).
- `echart` → write a self-contained HTML shell: the spec JSON + a
  `<script src>` for ECharts from CDN (pinned major, e.g.
  `cdn.jsdelivr.net/npm/echarts@5`). Interactive charts (tooltip, zoom,
  series toggling) — the point of charting real data — for a ~2KB file and no
  bundled dependency. Offline the tab is blank, which is acceptable (every
  meaningful CLI session is already network-dependent) but must not be
  mysterious: the shell carries a visible fallback notice when the script
  fails to load. The future local webserver serves its own vendored ECharts
  and renders specs client-side, making the CDN and the materialized file
  disappear — another reason not to over-invest here.
- Artifact-sourced charts (`dataPath`): at materialization time the CLI reads
  the workspace CSV (RFC-4180, header row, numeric inference — the harness
  contract) and injects rows as `dataset.source`. Missing/unparseable →
  degraded card state naming the path.

Cache location is CLI-owned app data, NOT the analysis workspace — the
workspace layout is harness-owned and a host render cache doesn't belong in
it. Files are keyed by the deterministic `pres-<hash>` id, which makes the
cache idempotent (re-emission = same file) and disposable (the spec lives in
the transcript; deleting the cache loses nothing).

## The opener: one helper, WSL included

Considered and discarded: OSC 8 hyperlinks inside the TUI. The TUI runs
alternate-screen with mouse tracking; the app captures clicks, so
terminal-native link handling doesn't reliably pass through. The card is a
TUI-level click target instead, and the opener is ours.

A single shared helper (platform argv selection + detached `Bun.spawn` +
Result-wrapped ENOENT) lifts the two existing near-duplicates
(`modules/auth/login.ts`, `modules/analysis/open.ts`). It adds the WSL case
both currently miss: under WSL (`/proc/version` contains `microsoft`),
`xdg-open` is typically absent or wrong — prefer `wslview`, fall back to
`explorer.exe` with a path translated via `wslpath -w`. Failure never blocks:
the card always shows the resolved path, and a failed spawn degrades to a
notice carrying it.

The REPL printer (`chat_printer.ts`) is the one place OSC 8 *is* right — plain
stdout, no mouse capture — so openables print as a `file://` hyperlink plus
the plain path for terminals without link support.

## Open UX: three affordances, nothing fancier

1. Click the card — opens that artifact (opentui already handles mouse).
2. `o` — opens the most recent openable card; covers the dominant "the agent
   just showed me something" case with zero transcript focus machinery.
3. "Browse artifacts…" palette entry — a `SelectDialog` over the session's
   openables, newest first, for reach-back; doubles as discoverability.
   Registered as remappable command ids via `config.keybinds`.

Per-card focus navigation and numbered cards were considered and deliberately
deferred until real usage demands them — the picker covers the long tail.

Multi-file `data-file-reference` galleries: each row is individually openable;
the card also offers "open containing folder" (reusing the directory opener),
which is usually more useful than N separate opens.

## Reload parity

`cortexToUiMessage` (the pg-thread reconstruction path) maps the same part
types through the same shared readers as the live `applyEmitEvent` path — the
card-builders guarantee live and reconstructed cards are byte-identical, so
one part type per kind serves both. This closes the existing `TODO(extend)`
that collapses reconstructed presentations to `[part:…]` tags. Unknown part
types keep the tagged-mention fallback (observe, don't swallow).

## Out of scope

- Terminal graphics protocols (kitty/sixel/iTerm2 inline images) — terminal-
  dependent, large effort, partial coverage; revisit only if externally-opened
  charts prove insufficient.
- Inline text previews of referenced CSVs/logs (head-of-file peek on
  `data-file-reference` rows) — a natural v2 the openable card leaves room
  for, not part of this change.
- The local webserver itself — this change only preserves the resolution seam
  it will plug into.
