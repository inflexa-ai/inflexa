---
name: report-pdf
description: PDF report rendering via WeasyPrint with print-optimized CSS
version: 2.0.0
tags: [report, pdf, weasyprint, print]
---

# PDF Report Rendering

Guidance for producing PDF reports from Jinja2 HTML templates using WeasyPrint, with print-optimized CSS and static chart fallbacks.

## Workflow

This skill is used alongside the `report-html` skill. The agent builds the HTML report first (Jinja2 template → `index.html` via `build.py`), then converts to PDF:

1. **Generate HTML** — write `report.html.j2` extending the base template, run `python build.py` to produce `index.html`
2. **Pre-render charts** — replace ECharts `<div>` containers with static SVG images (WeasyPrint cannot execute JavaScript)
3. **Inject print CSS** — append `@media print` overrides for paginated A4 output
4. **Convert to PDF** — run `weasyprint index.html report.pdf`

## Print CSS Overrides

Add a `<style>` block with `@media print` rules to the template:

- All sections shown sequentially (no tabs/hidden panels)
- Page breaks at section boundaries (`break-before: page`)
- Table headers repeat across pages (`thead { display: table-header-group }`)
- Font sizes adjusted for print density
- Colors adjusted for print contrast (no light grays on white)
- Shadows and hover effects removed

## ECharts Static Rendering

WeasyPrint cannot execute JavaScript. Pre-render charts to SVG:

```bash
node -e "
const echarts = require('echarts');
const fs = require('fs');
const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 });
chart.setOption(JSON.parse(fs.readFileSync('chart-options.json', 'utf8')));
fs.writeFileSync('chart.svg', chart.renderToSVGString());
chart.dispose();
"
```

Replace `<div data-echarts-id>` containers with `<img src="chart.svg">` in the print version.

## Key Considerations

- **No JS execution**: WeasyPrint is CSS-only. All interactive behavior must be replaced with static equivalents.
- **CSS Grid limitations**: WeasyPrint has limited CSS Grid support. Prefer flexbox for print layouts.
- **Memory**: Process charts sequentially for large reports with many images.
- **Image paths**: All `src` attributes must be absolute or relative to the HTML file location.
