# weasyprint Usage Guide

Practical guide for converting HTML analysis reports to PDF using weasyprint, including ECharts SSR pre-rendering.

## Basic Invocation

```bash
# Simple conversion
weasyprint report.html report.pdf

# With a custom print stylesheet
weasyprint report.html report.pdf --stylesheet print.css

# With multiple stylesheets
weasyprint report.html report.pdf --stylesheet print.css --stylesheet custom.css

# From a URL
weasyprint http://localhost:3000/report report.pdf
```

## ECharts SSR Fallback

weasyprint does not execute JavaScript. Interactive ECharts charts must be pre-rendered to static SVG images before conversion.

### Step 1: Extract ECharts Options from HTML

The HTML report embeds ECharts configuration as JSON in `data-echarts-option` attributes or inline `<script>` blocks. Extract these before rendering.

### Step 2: Render Charts to SVG via Node.js

Use the following Node.js script to render ECharts options to SVG files:

```javascript
// render-charts.mjs
// Usage: node render-charts.mjs <input.html> <output-dir>
//
// Extracts ECharts options from HTML, renders each to SVG,
// and rewrites the HTML with <img> tags pointing to the SVGs.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { JSDOM } from "jsdom";
import * as echarts from "echarts";
import { createCanvas } from "canvas";

const [inputHtml, outputDir] = process.argv.slice(2);
if (!inputHtml || !outputDir) {
  console.error("Usage: node render-charts.mjs <input.html> <output-dir>");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const html = readFileSync(inputHtml, "utf-8");
const dom = new JSDOM(html);
const document = dom.window.document;

// Find all ECharts containers
const chartDivs = document.querySelectorAll("[data-echarts-option]");

for (const div of chartDivs) {
  const chartId = div.id;
  const optionJson = div.getAttribute("data-echarts-option");

  if (!optionJson || !chartId) {
    console.warn("Skipping chart div without id or option data");
    continue;
  }

  try {
    const option = JSON.parse(optionJson);

    // Determine chart dimensions from the div style or defaults
    const width = parseInt(div.getAttribute("data-width") || "800", 10);
    const height = parseInt(div.getAttribute("data-height") || "500", 10);

    // Create an ECharts instance with SVG renderer (server-side)
    const chart = echarts.init(null, null, {
      renderer: "svg",
      ssr: true,
      width,
      height,
    });

    chart.setOption(option);

    // Render to SVG string
    const svgStr = chart.renderToSVGString();
    chart.dispose();

    // Write SVG file
    const svgFileName = `${chartId}.svg`;
    const svgFilePath = join(outputDir, svgFileName);
    writeFileSync(svgFilePath, svgStr);

    // Replace the chart div with an img tag in the HTML
    const img = document.createElement("img");
    img.setAttribute("src", svgFilePath);
    img.setAttribute("alt", div.getAttribute("data-title") || `Chart ${chartId}`);
    img.setAttribute("class", "chart-render");
    img.setAttribute("width", String(width));
    img.setAttribute("height", String(height));
    div.replaceWith(img);

    console.log(`Rendered ${chartId} -> ${svgFilePath} (${width}x${height})`);
  } catch (err) {
    console.error(`Failed to render chart ${chartId}:`, err.message);
  }
}

// Write the modified HTML
const outputHtmlPath = join(dirname(inputHtml), "report-print.html");
writeFileSync(outputHtmlPath, dom.serialize());
console.log(`Modified HTML written to ${outputHtmlPath}`);
```

### Step 3: Replace Chart Divs in HTML

The script above handles replacement automatically. After running it:

```bash
# Pre-render charts
node render-charts.mjs report.html ./charts

# Convert the modified HTML to PDF
weasyprint report-print.html report.pdf --stylesheet print.css
```

### Alternative: Inline SVG

Instead of external SVG files, you can inline the SVG directly into the HTML for a fully self-contained document:

```javascript
// Instead of creating an <img>, inline the SVG
const svgWrapper = document.createElement("div");
svgWrapper.innerHTML = svgStr;
svgWrapper.setAttribute("class", "chart-render");
div.replaceWith(svgWrapper);
```

This avoids file path resolution issues but increases the HTML file size.

## Known Limitations

- **No JavaScript execution**: weasyprint is a CSS-only renderer. All dynamic content must be pre-rendered to static HTML/SVG before conversion. This includes ECharts, D3.js visualizations, and any DOM manipulation.
- **CSS Grid**: weasyprint has limited CSS Grid support. Use flexbox or table-based layouts in the print stylesheet for reliable rendering.
- **Tailwind utilities**: Transform, animation, and transition utilities have no effect in print and can be safely ignored. Flexbox and spacing utilities work correctly.
- **CSS variables**: weasyprint supports CSS custom properties. Tailwind's variable-based color system works as expected.
- **SVG rendering**: weasyprint handles SVG well, making it the preferred format for chart SSR output over PNG.

## Image Handling

- All image `src` paths must be resolvable from the HTML file location. Use absolute paths or paths relative to the HTML file.
- For base64-encoded images, weasyprint handles `data:` URIs directly -- no path resolution needed.
- Large high-resolution images should be pre-scaled to reasonable print dimensions (300 DPI for photos, 150 DPI for charts) to control memory usage and file size.

```bash
# Verify all images are accessible before running weasyprint
grep -oP 'src="[^"]*"' report-print.html | while read -r src; do
  path="${src#src=\"}"
  path="${path%\"}"
  if [[ ! "$path" =~ ^data: ]] && [[ ! -f "$path" ]]; then
    echo "Missing image: $path"
  fi
done
```

## Memory Considerations

For large reports with many charts and images:

- Process charts sequentially in the SSR script (the script above does this naturally with a `for` loop)
- Dispose of each ECharts instance immediately after rendering (`chart.dispose()`)
- For very large reports (50+ charts), consider splitting into sections, rendering each as a separate PDF, and merging with a tool like `pdfunite`

```bash
# If memory is an issue, split and merge
weasyprint section-1.html section-1.pdf --stylesheet print.css
weasyprint section-2.html section-2.pdf --stylesheet print.css
pdfunite section-1.pdf section-2.pdf report.pdf
```

## Complete Workflow

```bash
#!/bin/bash
# Full HTML-to-PDF conversion pipeline

set -euo pipefail

INPUT_HTML="${1:?Usage: $0 <input.html>}"
OUTPUT_PDF="${2:-report.pdf}"
CHART_DIR="$(mktemp -d)"
PRINT_CSS="print.css"

echo "Step 1: Pre-rendering ECharts to SVG..."
node render-charts.mjs "$INPUT_HTML" "$CHART_DIR"

PRINT_HTML="$(dirname "$INPUT_HTML")/report-print.html"

echo "Step 2: Converting to PDF with weasyprint..."
weasyprint "$PRINT_HTML" "$OUTPUT_PDF" --stylesheet "$PRINT_CSS"

echo "Step 3: Cleaning up..."
rm -rf "$CHART_DIR"
rm -f "$PRINT_HTML"

echo "Done: $OUTPUT_PDF"
```
