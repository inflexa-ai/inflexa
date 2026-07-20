---
name: report-html
description: Jinja2 + Tailwind v4 CDN + ECharts light-themed report templating following the Inflexa Design Blueprint
version: 5.0.0
tags: [report, html, jinja2, tailwind, echarts, visualization, light-theme, inflexa-blueprint]
---

# HTML Report Builder

Author Jinja2 templates that extend the Inflexa base layout. The renderer resolves `base.html.j2` and `components/*.html.j2` from the templates dir; you only write `report.html.j2`. For the full token reference (colors, type scale, spacing, textures), read `references/design-system.md`.

## Design Identity

Light theme. Alternating `bg-white` and `bg-slate-50` sections. Primary accent `#576dea`. Space Grotesk for prose, IBM Plex Mono for labels, tags, data values, gene symbols. Square-cornered cards with L-shaped corner accents; chart panels are the only rounded surface (`window-chrome` + `rounded-xl`). Footer is the only dark surface.

## When to use which component

- `sidebar` — fixed left-side navigation listing every section. Required on every report. Shifts the page right on `lg+` automatically and degrades to a slide-in drawer on mobile.
- `stat-card` — single headline number with a label. Use for KPIs at the top of a section, never for prose.
- `data-table` — tabular data the reader will scan or sort. Headers must declare `sort_type` (`string` | `number`).
- `chart-container` — any ECharts visualization. Provides the window-chrome panel and a target div by `chart_id`.
- `insight-box` — one short interpretive paragraph tied to the section's data. Not a substitute for a section header.
- `badge` — short status/level chip beside a value. Levels: `high`, `medium`, `low`, `primary`.
- `section-header` — opens every section. Carries the mono uppercase label, the prose title, and the description.

## Hero block

Every report opens with a non-sticky hero defined by the base template. Override these blocks to populate it:

- `header_eyebrow` — short mono uppercase category label (`<p class="font-mono text-xs font-semibold tracking-widest uppercase text-primary-500">DIFFERENTIAL EXPRESSION · ONCOLOGY</p>`).
- `header_title` — display-size h1 text. Plain text, no markup. The base wraps it in a sized h1.
- `header_subtitle` — lede paragraph plus optional metadata line. The base reserves a `max-w-3xl` slot. Use `<p class="text-lg text-slate-600 leading-relaxed">…</p>` for the lede and a `<p class="mt-3 font-mono text-xs text-slate-400">…</p>` for the dataset/citation strip.

Do NOT add your own `<h1>` to the first content section — the hero h1 is already the page's primary heading.

## Section composition rules

Every section is a `<section>` with `py-12 md:py-16`, a `mx-auto max-w-[1600px] px-6 md:px-8 lg:px-12` inner container, and a texture stack.

- Alternate backgrounds: `bg-white` then `bg-slate-50` then `bg-white`...
- Alternate textures: `texture-dots` then `texture-grid` then `texture-dots`... Always include `texture-noise`.
- Wrap each block in `<div class="fade-in">` with staggered `data-delay="0|100|200|..."` so the scroll observer reveals them in order.
- First child of every section is the `section-header` include.

## Required component invocations

Sidebar (override `{% block sidebar %}` from the base; one `sidebar_items` entry per `<section id="...">`; `icon` is optional inline SVG content — children of `<svg>`):
```jinja2
{% block sidebar %}
  {% set sidebar_items = [
    {"id": "overview",  "label": "Summary",     "icon": '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'},
    {"id": "volcano",   "label": "Volcano Plot"},
    {"id": "top-genes", "label": "Top DEGs"}
  ] %}
  {% set sidebar_brand_label = "REPORT" %}
  {% set sidebar_footer = "Generated " ~ run_date %}
  {% include "components/sidebar.html.j2" %}
{% endblock %}
```

Section header:
```jinja2
{% set section_label = "ANALYSIS" %}
{% set section_title = "Differential Expression" %}
{% set section_description = "Genes ranked by adjusted p-value." %}
{% include "components/section-header.html.j2" %}
```

Stat card (`stat_color`: `primary` | `green` | `red` | `purple` | `amber`):
```jinja2
{% set stat_value = "12,847" %}
{% set stat_label = "Total Genes" %}
{% set stat_detail = "after filtering" %}
{% set stat_color = "primary" %}
{% include "components/stat-card.html.j2" %}
```

Data table:
```jinja2
{% set table_id = "deg-table" %}
{% set table_headers = [
  {"label": "Gene", "sort_type": "string"},
  {"label": "log2FC", "sort_type": "number"}
] %}
{% set table_rows = [
  ["<span class='gene'>TP53</span>", "2.45"]
] %}
{% include "components/data-table.html.j2" %}
```

Chart container (renders the panel; you wire `echarts.init` against `chart_id` in `{% block scripts %}`):
```jinja2
{% set chart_id = "volcano-plot" %}
{% set chart_title = "Volcano Plot" %}
{% set chart_subtitle = "log2FC vs -log10(padj)" %}
{% set chart_height = "500px" %}
{% include "components/chart-container.html.j2" %}
```

Insight box (`insight_color`: `primary` | `green` | `purple` | `amber`):
```jinja2
{% set insight_title = "Key Finding" %}
{% set insight_text = "TP53 pathway shows significant activation..." %}
{% set insight_color = "purple" %}
{% include "components/insight-box.html.j2" %}
```

Badge:
```jinja2
{% set badge_text = "High Confidence" %}
{% set badge_level = "high" %}
{% include "components/badge.html.j2" %}
```

## Inline patterns

Block progress bar (use directly in a table cell or stat row; thresholds: `filled-high` >= 0.8, `filled-mid` >= 0.6, `filled-low` < 0.6):
```html
<span class="block-progress">
  <span class="filled-high">████████</span><span class="empty">░░</span>
  <span class="score">0.82</span>
</span>
```

Terminal card (dark-header data display; the only place a dark surface is allowed mid-page):
```html
<div class="terminal-card rounded-none border border-slate-200">
  <div class="terminal-header px-4 py-2.5 flex items-center gap-2">
    <span class="h-2 w-2 rounded-full bg-rose-400/80"></span>
    <span class="h-2 w-2 rounded-full bg-amber-400/80"></span>
    <span class="h-2 w-2 rounded-full bg-green-400/80"></span>
    <span class="font-mono text-xs text-slate-300 ml-2">evidence-dossier.json</span>
  </div>
  <div class="terminal-body-dark p-4 font-mono text-sm">
    <!-- content -->
  </div>
</div>
```

Gene symbols, anywhere:
```html
<span class="gene">TP53</span>
```

## ECharts wiring

The base template registers an `inflexa` theme and dispatches `inflexa-theme-ready` once. Initialize charts inside that listener:
```javascript
document.addEventListener('inflexa-theme-ready', () => {
  const chart = echarts.init(document.getElementById('volcano-plot'), 'inflexa');
  chart.setOption({ /* ... */ });
});
```
Charts use transparent backgrounds, `#f1f5f9` grid lines, `#64748b` axis labels.

## Anti-patterns

- Do not omit the sidebar. Every report must override `{% block sidebar %}` and list one `sidebar_items` entry per `<section id="…">`; mismatched ids break active-section tracking.
- Do not author your own `<header>` or `<footer>` element. The base owns the hero, footer, CDN tags, theme registration, sortable tables, fade-in observer, and sidebar tracking — populate them via the `header_*` / `footer_left` / `sidebar` blocks.
- Do not rewrite `report.html.j2` from scratch on iteration. Read the existing file, edit in place. Wholesale rewrites lose context the reader has already seen.
- Do not fabricate numbers, gene names, p-values, or any datum. Only render values present in the analysis files you read.
- Do not inline large datasets into HTML. Copy CSV/JSON into the shared assets dir via `copy_to_assets`, fetch client-side from `assets/...`.
- Do not put `border-radius` on data cards (stat-card, insight-box, data-table). Square corners + `corner-accents` only. Chart panels are the sole exception.
- Do not use `font-mono` on headings or body prose. Mono is reserved for labels, tags, badges, data values, gene symbols.
- Do not load fonts from `fonts.googleapis.com` (CSP blocked). Use `cdn.jsdelivr.net` fontsource, which the base already wires.
- Do not introduce dark backgrounds outside the footer and terminal-card headers. Light theme only.
- Do not skip the section-header include. Every section opens with it.
- Do not stack two same-background sections. Alternation is load-bearing for visual rhythm.
