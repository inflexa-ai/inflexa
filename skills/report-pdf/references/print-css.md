# Print-Optimized CSS for weasyprint

Print stylesheet to inject alongside the regular Tailwind CSS when converting HTML reports to PDF. This overrides interactive/responsive layouts for paginated A4 output.

## Complete Print Stylesheet

```css
/* ============================================================
   Print stylesheet for weasyprint PDF rendering
   Inject this alongside the Tailwind CSS in the HTML <head>
   ============================================================ */

/* --- Page setup --- */
@page {
  size: A4;
  margin: 2cm;

  @top-center {
    content: "Analysis Report";
    font-size: 9pt;
    color: #666;
    font-family: "Inter", "Helvetica Neue", Arial, sans-serif;
  }

  @bottom-left {
    content: string(section-title);
    font-size: 8pt;
    color: #999;
  }

  @bottom-right {
    content: counter(page) " / " counter(pages);
    font-size: 8pt;
    color: #999;
  }
}

/* Named pages for distinct sections */
@page cover {
  margin: 0;
  @top-center { content: none; }
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

@page landscape {
  size: A4 landscape;
  margin: 1.5cm;
}

/* --- Base print adjustments --- */
body {
  font-size: 10pt;
  line-height: 1.5;
  color: #1a1a1a;
  background: white;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* --- Section and page break control --- */
h1 {
  page-break-before: always;
  string-set: section-title content();
}

h1:first-of-type {
  page-break-before: avoid;
}

h2, h3 {
  page-break-after: avoid;
}

/* Avoid breaking inside figures, tables, and code blocks */
figure,
table,
pre,
.chart-container,
.figure-panel,
.result-card {
  page-break-inside: avoid;
}

/* Force breaks at section boundaries */
.section-break,
section {
  page-break-before: always;
}

section:first-of-type {
  page-break-before: avoid;
}

/* --- Tab navigation removal --- */
/* Hide tab controls; show all tab panels linearly */
.tab-nav,
.tab-controls,
[role="tablist"] {
  display: none !important;
}

.tab-panel,
.tab-content,
[role="tabpanel"] {
  display: block !important;
  visibility: visible !important;
  height: auto !important;
  overflow: visible !important;
  opacity: 1 !important;
  position: static !important;
}

/* Add a visual separator between former tab sections */
[role="tabpanel"] + [role="tabpanel"] {
  border-top: 1px solid #e5e7eb;
  padding-top: 1em;
  margin-top: 1em;
}

/* --- Table handling --- */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
}

thead {
  display: table-header-group;
}

tfoot {
  display: table-footer-group;
}

tr {
  page-break-inside: avoid;
}

th, td {
  border: 1px solid #d1d5db;
  padding: 4pt 6pt;
  text-align: left;
}

th {
  background-color: #f3f4f6;
  font-weight: 600;
}

/* Zebra striping for readability */
tbody tr:nth-child(even) {
  background-color: #f9fafb;
}

/* --- Font adjustments for print density --- */
h1 { font-size: 18pt; margin-top: 0; }
h2 { font-size: 14pt; }
h3 { font-size: 12pt; }
h4 { font-size: 11pt; }
p, li { font-size: 10pt; }
figcaption { font-size: 9pt; color: #4b5563; }

/* --- Color adjustments for print contrast --- */
/* Replace light grays that disappear on print */
.text-gray-400 { color: #6b7280 !important; }
.text-gray-300 { color: #6b7280 !important; }
.bg-gray-50 { background-color: #f3f4f6 !important; }
.border-gray-100 { border-color: #d1d5db !important; }

/* Ensure sufficient contrast for all text */
[class*="text-gray-"] {
  color: #374151 !important;
}

/* --- Link handling --- */
a[href] {
  color: #1d4ed8;
  text-decoration: underline;
}

a[href^="http"]::after {
  content: " (" attr(href) ")";
  font-size: 8pt;
  color: #6b7280;
  word-break: break-all;
}

/* Don't show URLs for internal/anchor links */
a[href^="#"]::after,
a[href^="javascript"]::after {
  content: none;
}

/* --- Hide interactive/screen-only elements --- */
.tooltip,
.dropdown-menu,
.modal,
.sidebar-toggle,
.search-bar,
.interactive-controls,
button:not(.print-visible),
nav:not(.print-visible) {
  display: none !important;
}

/* --- Image handling --- */
img {
  max-width: 100% !important;
  height: auto !important;
  page-break-inside: avoid;
}

/* Chart images rendered from ECharts SSR */
img.chart-render {
  display: block;
  margin: 0.5em auto;
  max-width: 100%;
  max-height: 500pt;
}

/* --- Code blocks --- */
pre {
  background-color: #f3f4f6;
  border: 1px solid #e5e7eb;
  padding: 8pt;
  font-size: 8pt;
  line-height: 1.4;
  white-space: pre-wrap;
  word-wrap: break-word;
  page-break-inside: avoid;
}

code {
  font-family: "Fira Code", "Source Code Pro", monospace;
  font-size: 8pt;
}

/* --- Utility classes for print layout --- */
.print-landscape {
  page: landscape;
}

.print-cover {
  page: cover;
}

.print-hidden {
  display: none !important;
}

.print-only {
  display: block !important;
}
```

## Usage Notes

- **Injection**: Add this CSS as a `<style>` block in the HTML `<head>`, or pass it as a separate stylesheet to weasyprint via `--stylesheet print.css`.
- **Tailwind compatibility**: This stylesheet overrides specific Tailwind utility classes that produce poor print results (light grays, small text). Keep the Tailwind stylesheet loaded for layout utilities that still apply.
- **Named pages**: Use the `.print-landscape` class on sections containing wide tables or charts that benefit from landscape orientation. Use `.print-cover` on the title/cover page to suppress headers and footers.
- **Section titles in footers**: The `string-set` property on `h1` captures the current section title for display in the page footer. This provides reader context on every printed page.
