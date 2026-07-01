# Report Templates

## Overview

Report-rendering templates the harness reads at runtime (via its `templatesDir` config path) and renders with Nunjucks into a report's `index.html`. This is content, not code — nothing here is built or packaged.

## What's here

All under `report-html/`:

| Path | Role |
|-|-|
| `base.html.j2` | Page shell — `<head>` (Tailwind v4, ECharts, fonts), CSS, built-in scripts, and the `{% block %}`s a report fills (`title`, `header_*`, `content`, `scripts`, `sidebar`). |
| `components/` | Reusable partials pulled in with `{% include "components/*.html.j2" %}` (e.g. `stat-card`, `data-table`, `badge`, `chart-container`, `sidebar`). |
| `echarts-theme.json` | The `inflexa` ECharts theme, inlined into `base.html.j2` and registered for all charts. |
| `theme.css` | Standalone stylesheet companion to the in-template styles. |

## How it's rendered

`harness/src/execution/report-render.ts` renders with a Nunjucks `FileSystemLoader` over `[versionDir, templatesDir]`: the report's generated `report.html.j2` lives in the version dir and starts with `{% extends "base.html.j2" %}`, while `extends`/`include` targets resolve from this directory. **Autoescape is OFF** (`{ autoescape: false }`) — templates own their own escaping. `echarts-theme.json` is parsed, re-stringified, and passed as `echarts_theme` for safe inlining inside a `<script>` block.

## Contributing

- Add a component as a small, focused `components/*.html.j2`, document its expected variables in a leading `{# … #}` comment (see `stat-card.html.j2`), and `{% include %}` it from a report.
- Because **autoescape is off**, escape any untrusted value inside the template (`| escape`) — the renderer will not do it for you.
- Keep changes **in sync with** [`../skills/report-html/references/design-system.md`](../skills/report-html/references/design-system.md): the template (what renders) and the design-system reference (the tokens/classes the agent is told to use) are two halves of one feature, so a change to one usually needs a matching change to the other.
