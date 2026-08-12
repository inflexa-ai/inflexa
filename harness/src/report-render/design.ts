/**
 * The design sheet of the report page, and the ECharts theme.
 *
 * The page carries no external stylesheet and no CSS framework. Thus this module holds the whole identity:
 * the tokens, the font faces, the typography, the components, the textures, the motion rules, and the print
 * rules. The identity source is the Inflexa design system.
 *
 * Two invariants bind an edit of the sheet:
 *
 * - Each class rule matches a class that one view emits. A rule with no emitter is dead, and a dead rule is
 *   a cost with no visible effect.
 * - Each font URL comes from the asset manifest. Thus the sheet and the stage step of the caller cannot
 *   disagree over a file name.
 *
 * The token block is the exception to the first invariant. The token set is the contract of the identity,
 * thus it stays complete even where no current rule reads a token.
 */

import { assetSource, MONO_FONT_400_ASSET, MONO_FONT_500_ASSET, MONO_FONT_600_ASSET, MONO_FONT_700_ASSET, SANS_FONT_ASSET } from "./assets.js";

/**
 * The `@font-face` rules of the staged fonts.
 *
 * Space Grotesk ships as one variable file, thus one face declares the whole weight axis. IBM Plex Mono has
 * no variable release, thus each weight that the identity uses is a separate face and a separate staged file.
 */
const FONT_FACES = `@font-face {
  font-family: "Space Grotesk Variable";
  src: url("${assetSource(SANS_FONT_ASSET)}") format("woff2-variations");
  font-weight: 300 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("${assetSource(MONO_FONT_400_ASSET)}") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("${assetSource(MONO_FONT_500_ASSET)}") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("${assetSource(MONO_FONT_600_ASSET)}") format("woff2");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("${assetSource(MONO_FONT_700_ASSET)}") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}`;

/** The style rules of the page. The renderer inlines them in one `<style>` block. */
export const DESIGN_CSS = `${FONT_FACES}

/* ── Design tokens ────────────────────────────────────── */
:root {
  /* Primary scale */
  --color-primary-50:  #f0f1fe;
  --color-primary-100: #dde0fc;
  --color-primary-200: #bcc2f9;
  --color-primary-300: #9ba5f5;
  --color-primary-400: #7987f0;
  --color-primary-500: #576dea;
  --color-primary-600: #4458d4;
  --color-primary-700: #3545b0;

  /* Text */
  --color-heading:        #0f172a;
  --color-text-strong:    #334155;
  --color-text:           #475569;
  --color-text-secondary: #64748b;
  --color-text-muted:     #94a3b8;

  /* Surface */
  --color-bg:             #ffffff;
  --color-bg-alt:         #f8fafc;
  --color-card:           #ffffff;
  --color-border-subtle:  #f1f5f9;
  --color-border:         #e2e8f0;
  --color-border-hover:   #cbd5e1;
  --color-surface-dark:   #0f172a;

  /* Data visualization */
  --color-up:   #ef4444;
  --color-down: #576dea;
  --color-ns:   #94a3b8;

  /* Semantic tags */
  --color-high-bg:     #f0fdf4;
  --color-high-text:   #15803d;
  --color-medium-bg:   #fffbeb;
  --color-medium-text: #b45309;
  --color-low-bg:      #fef2f2;
  --color-low-text:    #b91c1c;

  /* Stat accents */
  --color-stat-primary: #576dea;
  --color-stat-green:   #22c55e;
  --color-stat-red:     #ef4444;
  --color-stat-purple:  #a78bfa;
  --color-stat-amber:   #f59e0b;

  /* Typography and layout */
  --font-sans: "Space Grotesk Variable", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --layout-max: 1600px;
  --nav-width: 15rem;
}

/* ── Base ─────────────────────────────────────────────── */
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  color: var(--color-text);
  background: var(--color-bg);
}

h1,
h2,
h3,
h4,
p,
figure,
ol {
  margin: 0;
}

img {
  display: block;
  max-width: 100%;
  height: auto;
}

/* A heading uses the sans family. A label, a tag, a table header, and a data value use the mono family. */
.report-heading {
  color: var(--color-heading);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.report-heading-2 {
  font-size: 30px;
  margin-bottom: 16px;
}
.report-heading-3 {
  font-size: 24px;
  margin-bottom: 12px;
}
.report-heading-4 {
  font-size: 20px;
  margin-bottom: 8px;
}

/* ── Layout ───────────────────────────────────────────── */
.report-container {
  position: relative;
  margin: 0 auto;
  max-width: var(--layout-max);
  padding-left: 24px;
  padding-right: 24px;
}

.report-hero {
  position: relative;
  background: var(--color-bg);
  padding-top: 48px;
  padding-bottom: 40px;
}
.report-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-primary-500);
}
.report-display {
  margin-top: 12px;
  max-width: 56rem;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
  color: var(--color-heading);
}

.report-band {
  position: relative;
  padding-top: 48px;
  padding-bottom: 48px;
}
.report-band-white {
  background: var(--color-bg);
}
.report-band-slate {
  background: var(--color-bg-alt);
}

.report-section {
  margin-bottom: 40px;
}
.report-section:last-child {
  margin-bottom: 0;
}

.report-footer {
  background: var(--color-surface-dark);
  padding-top: 32px;
  padding-bottom: 32px;
}
.report-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.report-footer-title {
  font-size: 14px;
  color: var(--color-text-muted);
}
.report-footer-note {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}

/* ── Navigation ───────────────────────────────────────── */
.report-nav {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 40;
  display: none;
  width: var(--nav-width);
  height: 100vh;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-card);
}
.report-nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px;
  border-bottom: 1px solid var(--color-border);
}
.report-nav-brand-name {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--color-primary-500);
}
.report-nav-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding-top: 12px;
  padding-bottom: 12px;
}
.report-nav-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  font-size: 14px;
  text-decoration: none;
  color: var(--color-text-secondary);
  border-left: 2px solid transparent;
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}
.report-nav-link:hover {
  color: var(--color-heading);
  background-color: var(--color-bg-alt);
  border-left-color: var(--color-primary-500);
}
.report-nav-index {
  flex-shrink: 0;
  width: 16px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--color-border-hover);
}
.report-nav-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ── Prose and evidence markers ───────────────────────── */
.report-prose {
  max-width: 72ch;
  margin-bottom: 16px;
  line-height: 1.7;
  color: var(--color-text);
}
.report-marker {
  font-family: var(--font-mono);
  font-size: 10px;
}
.report-marker a {
  color: var(--color-primary-500);
  text-decoration: none;
  padding-left: 2px;
}
.report-marker a:hover {
  text-decoration: underline;
}

/* ── Corner-accent card ───────────────────────────────── */
/* The data cards keep square corners. The L-shaped accents grow on hover. */
.corner-accents {
  position: relative;
  border: 1px solid var(--color-border);
  background: var(--color-card);
  transition: box-shadow 0.2s ease;
}
.corner-accents::before,
.corner-accents::after {
  content: "";
  position: absolute;
  width: 20px;
  height: 20px;
  z-index: 1;
  pointer-events: none;
  transition: width 0.3s ease, height 0.3s ease, border-color 0.3s ease;
}
.corner-accents::before {
  top: -1px;
  left: -1px;
  border-top: 2px solid var(--color-primary-200);
  border-left: 2px solid var(--color-primary-200);
}
.corner-accents::after {
  bottom: -1px;
  right: -1px;
  border-bottom: 2px solid var(--color-primary-200);
  border-right: 2px solid var(--color-primary-200);
}
.corner-accents:hover::before,
.corner-accents:hover::after {
  width: 28px;
  height: 28px;
  border-color: var(--color-primary-500);
}
.corner-accents:hover {
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.08);
}

/* ── Stat card ────────────────────────────────────────── */
.report-metric-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  margin-bottom: 32px;
}
/* A lone card keeps a card-sized measure. A card inside the grid fills its cell. */
.stat-card {
  padding: 24px;
  margin-bottom: 24px;
  max-width: 360px;
}
.report-metric-grid > .stat-card {
  margin-bottom: 0;
  max-width: none;
}
.stat-card-value {
  font-family: var(--font-mono);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--color-stat-primary);
}
.stat-card-label {
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

/* ── Data table ───────────────────────────────────────── */
.report-table {
  margin-bottom: 32px;
}
.report-table-title {
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-primary-500);
}
.data-table-scroll {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.data-table th {
  padding: 12px 16px;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background-color: var(--color-bg-alt);
  border-bottom: 1px solid var(--color-border);
}
.data-table td {
  padding: 10px 16px;
  color: var(--color-text-strong);
  border-bottom: 1px solid var(--color-border-subtle);
}
.report-row {
  transition: background-color 0.15s ease;
}
.report-row:hover {
  background-color: var(--color-bg-alt);
}
.report-row:last-child td {
  border-bottom: 0;
}

/* ── Figure and citation cards ────────────────────────── */
.report-figure {
  padding: 16px;
  margin-bottom: 32px;
}
/* The image keeps its own size up to the card width. Thus a small figure does not stretch. */
.report-figure-image {
  border: 1px solid var(--color-border);
}
.report-citation {
  padding: 16px 20px;
  margin-bottom: 24px;
  font-size: 14px;
  color: var(--color-text-secondary);
}
.report-citation-note {
  color: var(--color-text);
}
.report-caption {
  margin-top: 8px;
  font-size: 13px;
  color: var(--color-text-muted);
}

/* ── Window-chrome chart panel ────────────────────────── */
/* The chart panel is the one component with rounded corners. */
.report-chart {
  margin-bottom: 32px;
}
.window-chrome {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-card);
  box-shadow: 0 8px 30px -8px rgba(15, 23, 42, 0.08), 0 4px 12px -4px rgba(15, 23, 42, 0.04);
  transition: transform 0.5s ease, box-shadow 0.5s ease, border-color 0.5s ease;
}
.window-chrome:hover {
  transform: translateY(-4px);
  border-color: var(--color-border-hover);
  box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.18), 0 12px 24px -8px rgba(15, 23, 42, 0.1);
}
.window-chrome-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  background-color: var(--color-bg-alt);
  border-bottom: 1px solid var(--color-border-subtle);
}
.chrome-dots {
  display: flex;
  align-items: center;
  gap: 6px;
}
.chrome-dot {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: var(--color-border-hover);
  transition: background-color 0.3s ease;
}
.window-chrome:hover .dot-1 {
  background-color: #fb7185;
}
.window-chrome:hover .dot-2 {
  background-color: #fbbf24;
}
.window-chrome:hover .dot-3 {
  background-color: #4ade80;
}
.window-chrome-title {
  flex: 1 1 auto;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-heading);
}
.window-chrome-badge {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--color-primary-500);
}
.window-chrome-body {
  padding: 16px;
}
/* The chart runtime measures the container. A container with no height shows no chart. */
.chart-container {
  width: 100%;
  height: 400px;
}

/* ── Reference list ───────────────────────────────────── */
.report-references {
  padding-left: 24px;
  list-style: decimal;
}
.report-ref-item {
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--color-text);
}
.report-ref-kind {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.report-ref-path {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--color-primary-700);
}
.report-ref-detail {
  color: var(--color-text-secondary);
}

/* ── Section textures ─────────────────────────────────── */
/* A texture is felt, not seen: a low opacity and a faded edge. */
.texture-dots,
.texture-grid,
.texture-noise {
  position: relative;
}
.texture-dots > *,
.texture-grid > *,
.texture-noise > * {
  position: relative;
  z-index: 1;
}
.texture-dots::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: rgba(148, 163, 184, 0.2);
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 0%, transparent 70%), radial-gradient(circle 0.75px at center, white 100%, transparent 100%);
  -webkit-mask-size: 100% 100%, 6px 6px;
  -webkit-mask-composite: source-in;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 0%, transparent 70%), radial-gradient(circle 0.75px at center, white 100%, transparent 100%);
  mask-size: 100% 100%, 6px 6px;
  mask-composite: intersect;
}
.texture-grid::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: linear-gradient(to right, transparent calc(100% - 1px), rgba(148, 163, 184, 0.15) 100%), linear-gradient(to bottom, transparent calc(100% - 1px), rgba(148, 163, 184, 0.15) 100%);
  background-size: 32px 32px;
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 0%, transparent 70%);
  mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 0%, transparent 70%);
}
.texture-noise::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E");
  background-size: 200px 200px;
}

/* ── Fade-in ──────────────────────────────────────────── */
/* The page script adds the visible class. The \`data-delay\` attribute staggers a group. */
.fade-in {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.7s ease-out, transform 0.7s ease-out;
}
.fade-in-visible {
  opacity: 1;
  transform: translateY(0);
}

/* ── Scrollbar ────────────────────────────────────────── */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--color-border-hover);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* ── Responsive ───────────────────────────────────────── */
@media (min-width: 640px) {
  .report-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 768px) {
  .report-container {
    padding-left: 32px;
    padding-right: 32px;
  }
  .report-hero {
    padding-top: 80px;
    padding-bottom: 56px;
  }
  .report-display {
    font-size: 56px;
  }
  .report-band {
    padding-top: 64px;
    padding-bottom: 64px;
  }
}
@media (min-width: 1024px) {
  .report-container {
    padding-left: 48px;
    padding-right: 48px;
  }
  .report-metric-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .report-nav {
    display: flex;
  }
  /* The fixed navigation shifts the page body, thus the two never overlap. */
  body:has(#report-sidebar) {
    padding-left: var(--nav-width);
  }
}

/* ── Reduced motion ───────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  /* The reveal transition collapses, thus each element starts in its visible state. */
  .fade-in {
    opacity: 1;
    transform: none;
  }
}

/* ── Print ────────────────────────────────────────────── */
@media print {
  .report-nav {
    display: none;
  }
  /* The printer gives the page margin. Thus the screen padding of the container drops out. */
  body:has(#report-sidebar) {
    padding-left: 0;
  }
  .report-container {
    padding-left: 0;
    padding-right: 0;
  }
  .report-band {
    padding-top: 24px;
    padding-bottom: 24px;
  }
  .fade-in {
    opacity: 1;
    transform: none;
  }
  .texture-dots::before,
  .texture-grid::before,
  .texture-noise::after {
    display: none;
  }
  .report-footer {
    background: var(--color-bg);
  }
  .report-footer-title,
  .report-footer-note {
    color: var(--color-text-strong);
  }
  .window-chrome {
    box-shadow: none;
  }
}`;

/**
 * The registered name of the ECharts theme. The registration script writes this name, and the bootstrap
 * reads it. One source prevents a silent mismatch between the two sites.
 */
export const ECHARTS_THEME_NAME = "inflexa";

/**
 * The ECharts theme as a plain object. The renderer serializes this object and registers it, thus the theme
 * never rides a JSON file and no run-time read is necessary. The palette and the axis styles mirror the
 * light design tokens above.
 */
export const ECHARTS_THEME = {
    color: ["#576dea", "#ef4444", "#22c55e", "#a78bfa", "#f59e0b", "#ec4899", "#06b6d4", "#f97316", "#8b5cf6", "#14b8a6"],
    backgroundColor: "transparent",
    textStyle: {
        fontFamily: "'Space Grotesk Variable', system-ui, sans-serif",
        fontSize: 12,
        color: "#64748b",
    },
    title: {
        show: false,
    },
    legend: {
        bottom: 0,
        textStyle: { fontSize: 11, color: "#64748b" },
        itemGap: 16,
        itemWidth: 12,
        itemHeight: 12,
    },
    grid: {
        left: 60,
        right: 24,
        top: 24,
        bottom: 48,
        containLabel: false,
    },
    tooltip: {
        backgroundColor: "#ffffff",
        borderColor: "#e2e8f0",
        textStyle: { color: "#334155", fontSize: 12 },
        extraCssText: "border-radius: 4px; box-shadow: 0 4px 12px rgba(15,23,42,0.1);",
    },
    toolbox: {
        feature: {
            saveAsImage: { title: "Save", pixelRatio: 2 },
        },
        iconStyle: { borderColor: "#94a3b8" },
        right: 16,
        top: 0,
    },
    xAxis: {
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { lineStyle: { color: "#e2e8f0" } },
        axisLabel: { color: "#64748b", fontSize: 11 },
        splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed" } },
    },
    yAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#64748b", fontSize: 11 },
        splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed" } },
    },
};
