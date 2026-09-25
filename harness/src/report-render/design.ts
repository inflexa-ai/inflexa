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

/**
 * The token values that the page and the grid share.
 *
 * The grid takes its theme through a parameter object, and that API takes values. A CSS custom property
 * would arrive at the grid as text that it cannot read. Thus the shared tokens are constants here, the
 * `:root` block below interpolates them, and `GRID_THEME_PARAMS` reads the same names. One source then
 * styles the page and the grid.
 */
const TOKEN = {
    primary500: "#576dea",
    heading: "#0f172a",
    textStrong: "#334155",
    textSecondary: "#64748b",
    textMuted: "#94a3b8",
    card: "#ffffff",
    bgAlt: "#f8fafc",
    borderSubtle: "#f1f5f9",
    border: "#e2e8f0",
    fontSans: `"Space Grotesk Variable", system-ui, sans-serif`,
    fontMono: `"IBM Plex Mono", ui-monospace, monospace`,
} as const;

/** The height of the chart body on the page, in pixels, for a chart that states no height of its own. */
export const CHART_BODY_PX = 400;

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
  --color-primary-500: ${TOKEN.primary500};
  --color-primary-600: #4458d4;
  --color-primary-700: #3545b0;

  /* Text */
  --color-heading:        ${TOKEN.heading};
  --color-text-strong:    ${TOKEN.textStrong};
  --color-text:           #475569;
  --color-text-secondary: ${TOKEN.textSecondary};
  --color-text-muted:     ${TOKEN.textMuted};

  /* Surface */
  --color-bg:             #ffffff;
  --color-bg-alt:         ${TOKEN.bgAlt};
  --color-card:           ${TOKEN.card};
  --color-border-subtle:  ${TOKEN.borderSubtle};
  --color-border:         ${TOKEN.border};
  --color-border-hover:   #cbd5e1;
  --color-surface-dark:   #0f172a;

  /* Data visualization */
  --color-up:   #ef4444;
  --color-down: #576dea;
  --color-ns:   #94a3b8;

  /* Semantic tags */
  --color-high-bg:     #f0fdf4;
  --color-high-border: #bbf7d0;
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
  --font-sans: ${TOKEN.fontSans};
  --font-mono: ${TOKEN.fontMono};
  --layout-max: 1600px;
  --content-max: 1100px;
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
/* The one content column of the page. The container gives the full-bleed gutter, and this column carries
   every block kind. Thus the prose, the metric grid, the tables, and the charts read at one measure. */
.report-content {
  margin-left: auto;
  margin-right: auto;
  max-width: var(--content-max);
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
/* The brand is the one link of the page that leaves it. It reads as the brand, not as a link. */
.report-nav-brand-name {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-decoration: none;
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
/* The page script adds this class to the link of the section in view. One link carries it at a time. */
.report-nav-link-active {
  font-weight: 600;
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
/* The prose fills the content column. No inner measure caps it, thus a band carries no half-empty side. */
.report-prose {
  margin-bottom: 16px;
  line-height: 1.7;
  color: var(--color-text);
}
/* A list reads as prose that carries markers, thus it takes the type scale of the paragraph. The margin
   is explicit on each side, because the base rule zeroes an ordered list and a browser still spaces an
   unordered one. The left padding holds the markers, thus each item aligns inside the content column. */
.report-list {
  margin: 0 0 16px;
  padding-left: 24px;
  line-height: 1.7;
  color: var(--color-text);
}
.report-list-item {
  margin-bottom: 6px;
}
/* The bracket marker of the one reference ladder. It sits inline beside 16px prose, thus it reads at the
   size of a small inline word and never at the size of a superscript. */
.report-marker {
  font-family: var(--font-mono);
  font-size: 12px;
}
.report-marker a {
  color: var(--color-primary-500);
  text-decoration: none;
  padding-left: 2px;
}
.report-marker a:hover {
  text-decoration: underline;
}

/* ── Lineage control and popover ──────────────────────── */
/* The control sits beside the bracket marker. It reads as a quiet branch glyph and never as a second
   marker, thus it takes the muted color until a hover. The button carries no browser chrome, because a
   chrome box inside a line of prose would break the line. */
.report-lineage {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
  padding: 0;
  line-height: 0;
  vertical-align: -2px;
  color: var(--color-text-muted);
  background: none;
  border: 0;
  cursor: pointer;
}
.report-lineage:hover {
  color: var(--color-primary-500);
}
/* The drawing strokes in the current color, thus the two color rules above reach it and the sheet holds one
   color for the two states. */
.report-lineage-glyph {
  display: block;
}
/* The panel floats over the page. A data card clips its own overflow, thus the page script places the panel
   against the document and no card cuts it. The panel takes the width of its longest row, thus a name reads
   whole and a cut is the exception. The cap bounds it against the design and against the viewport, and the
   viewport half holds the same margin at each side as the clamp of the script. Thus a narrow window shows
   the panel between the two margins. */
.report-lineage-popover {
  position: absolute;
  z-index: 50;
  width: max-content;
  max-width: min(48rem, calc(100vw - 24px));
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: 0 12px 32px -12px rgba(15, 23, 42, 0.18);
  animation: report-lineage-open 0.12s ease-out;
}
.report-lineage-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.report-lineage-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
/* The header names the marker that opened the panel and the depth of the chain under it. Thus the reader
   reads the size of the chain before the body scrolls. */
.report-lineage-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}
.report-lineage-close {
  margin-left: auto;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1;
  color: var(--color-text-muted);
  background: none;
  border: 0;
  cursor: pointer;
}
.report-lineage-close:hover {
  color: var(--color-heading);
}
/* A deep pipeline builds more rows than a window holds. The cap reads against the viewport, thus the body
   scrolls inside the panel and the panel never grows the page. */
.report-lineage-body {
  max-height: 60vh;
  overflow-y: auto;
  padding: 16px 16px 8px;
}
/* One base row carries each file of the rail. A modifier marks the pinned artifact and a raw input, and a
   row with no modifier is an artifact that the rail continues past. */
.report-lineage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--color-bg-alt);
  border: 1px solid var(--color-border-subtle);
}
.report-lineage-row + .report-lineage-row {
  margin-top: 4px;
}
.report-lineage-row-pin {
  padding: 8px 10px;
  background: var(--color-primary-50);
  border-color: var(--color-primary-100);
}
.report-lineage-row-producer {
  padding: 8px 10px;
  background: var(--color-card);
  border-color: var(--color-border);
}
/* The terminal tint marks a file that no command of this analysis made. It is where a branch ends, thus the
   tint and the tag of the row state the same fact. */
.report-lineage-row-raw {
  background: var(--color-high-bg);
  border-color: var(--color-high-border);
}
.report-lineage-tag {
  flex-shrink: 0;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary);
  background: var(--color-border);
}
.report-lineage-tag-pin {
  font-weight: 600;
  color: var(--color-card);
  background: var(--color-primary-500);
}
.report-lineage-tag-raw {
  font-weight: 600;
  color: var(--color-card);
  background: var(--color-high-text);
}
/* The path takes the whole free width of the row, and it never wraps the row into two lines. The panel grows
   to the longest path, thus a window that gives the panel its cap needs no cut. In a narrow window the page
   script cuts a long path at its start, and it cuts an over-long file name in the middle of that name. Thus
   the ellipsis of this rule is the last guard, for a row too narrow to hold even a cut name. */
.report-lineage-path {
  flex: 1;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.report-lineage-row-pin .report-lineage-path,
.report-lineage-row-raw .report-lineage-path {
  color: var(--color-text-strong);
}
/* The directory prefix dims, thus the file name reads first inside a long path. */
.report-lineage-dir {
  color: var(--color-text-muted);
}
.report-lineage-hash {
  flex-shrink: 0;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
}
.report-lineage-prompt {
  flex-shrink: 0;
  color: var(--color-text-secondary);
}
.report-lineage-script {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.report-lineage-meta {
  flex-shrink: 0;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
}
/* The connector sits between two levels of the rail. The page script gives it the indent of its level, thus
   one rule serves each depth. */
.report-lineage-link {
  display: flex;
  gap: 10px;
  padding: 2px 0;
}
.report-lineage-rail {
  width: 1px;
  background: var(--color-border);
}
.report-lineage-rail-pin {
  background: var(--color-primary-100);
}
.report-lineage-link-label {
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}
/* The dashed edge marks a row that names files and shows none of them. Thus a count row never reads as one
   more hop of the chain. */
.report-lineage-more {
  margin-top: 4px;
  padding: 5px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
  /* One line always: a wrapped count row breaks the rail rhythm in a narrow
     window, and a cut count loses nothing that the rows above do not show. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border: 1px dashed var(--color-border);
}
.report-lineage-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--color-bg-alt);
  border-top: 1px solid var(--color-border-subtle);
}
.report-lineage-check {
  flex-shrink: 0;
  color: var(--color-high-text);
}
/* The footer states that the chain is complete, or it states the absence or the truncation that stopped it.
   A reader must read the rail against what it does not hold, thus the note sits under the rail and never
   beside one row of it. */
.report-lineage-note {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
@keyframes report-lineage-open {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  /* A value that the number format cannot shorten, for example a long identifier, breaks inside the card
     instead of past its edge. */
  overflow-wrap: anywhere;
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
/* The title line of a data card. A table and a chart carry the same line, thus one rule serves both. */
.report-table-title,
.report-chart-title {
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-primary-500);
}
/* The mount of one grid. The page script sizes it from the row count, thus the box fits a short table and
   a long table scrolls inside its own viewport. A mount whose payload the page does not hold takes no size,
   thus the card shows its title and its download alone. */
.report-grid {
  width: 100%;
}
/* The footer of a table card: the status of the table on the left, the download button on the right, and
   the print note under both. The three read as one surface under the grid. */
.report-table-footer {
  padding: 8px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-alt);
}
.report-table-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
/* The status of the table: the row count, and the row bound of the binding beside it. */
.report-table-status {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary);
}
.report-table-bound {
  color: var(--color-text-muted);
}
/* The bound reads as a second clause of the status line, thus a separator divides the two. The dot is a
   literal character, because a hex escape eats the space that follows it and the two clauses would touch. */
.report-table-bound::before {
  content: " · ";
}
/* The download of the raw bytes. It reads as a button, because it is the one action of a table card. */
.report-table-download {
  display: inline-block;
  flex-shrink: 0;
  padding: 6px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-primary-500);
  text-decoration: none;
  background: var(--color-card);
  border: 1px solid var(--color-primary-200);
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}
.report-table-download:hover {
  color: var(--color-primary-700);
  background: var(--color-primary-50);
  border-color: var(--color-primary-500);
}
/* The print note of a table card. The page script writes the bound of a truncated print form into it at
   print time, and it clears the text after. An empty note takes no space, thus the screen shows none. */
.report-grid-note {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}
.report-grid-note:empty {
  display: none;
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
/* The short citation is the name of the paper, thus it carries the weight of the card. */
.report-citation-source {
  font-weight: 600;
  color: var(--color-text);
}
a.report-citation-source {
  text-decoration: none;
}
a.report-citation-source:hover {
  text-decoration: underline;
}
.report-citation-note {
  color: var(--color-text);
}
.report-citation-key {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text-muted);
}
.report-caption {
  margin-top: 8px;
  font-size: 13px;
  color: var(--color-text-muted);
}

/* ── Chart card ───────────────────────────────────────── */
/* The chart is a data card, thus it takes the square corner-accent form of the table and the figure. */
.report-chart {
  margin-bottom: 32px;
}
.report-chart-card {
  padding: 16px;
}
/* The chart runtime measures the container. A container with no height shows no chart. A chart that needs a
   taller body, or a narrower one, states its own box on the element. */
.chart-container {
  width: 100%;
  height: ${CHART_BODY_PX}px;
}
/* The download control of the title line. The runtime draws the toolbox icon on the canvas and binds a mouse
   click alone, thus this control opens the same menu for the keyboard. It reads as a quiet label of the line. */
.report-chart-download {
  float: right;
  padding: 0 2px;
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.report-chart-download:hover,
.report-chart-download[aria-expanded="true"] {
  color: var(--color-primary-700);
}
.report-chart-download:focus-visible {
  outline: 2px solid var(--color-primary-500);
  outline-offset: 2px;
}
/* The download menu of a chart. The download control of the toolbox opens it under the control, and the page
   script places it against the card. It takes the square corners and the mono labels of the card title. A menu
   stands closed until the page script marks it open. */
.report-chart-menu {
  position: absolute;
  z-index: 20;
  display: none;
  flex-direction: column;
  min-width: max-content;
  padding: 4px 0;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: 0 12px 32px -12px rgba(15, 23, 42, 0.18);
}
.report-chart-menu-open {
  display: flex;
}
/* A link and a control of the menu read as one kind of entry. */
.report-chart-menu-item {
  display: block;
  padding: 8px 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--color-text-strong);
  text-decoration: none;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.report-chart-menu-item:hover,
.report-chart-menu-item:focus {
  color: var(--color-primary-700);
  background: var(--color-primary-50);
  outline: none;
}
.report-chart-menu-item:focus-visible {
  box-shadow: inset 2px 0 0 var(--color-primary-500);
}
/* The rule between the SVG entries and the PNG entries. */
.report-chart-menu-rule {
  height: 1px;
  margin: 4px 0;
  background: var(--color-border-subtle);
}
/* The note of a chart past the export bound that holds no point layer. It stands where the SVG entries stand. */
.report-chart-menu-note {
  padding: 8px 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: normal;
  max-width: 16rem;
  color: var(--color-text-secondary);
}
/* The note that the menu of a dense chart shows when the page cannot build its SVG file. The page shows it. */
.report-chart-menu-fault {
  display: none;
}
.report-chart-menu-fault.report-chart-menu-fault-shown {
  display: block;
}
/* The data view of a chart: the plotted rows as a plain table. The runtime frames the view over the chart body,
   and the frame scrolls a long table. */
.report-data-view {
  padding: 0 20px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-strong);
}
.report-data-view table {
  width: 100%;
  border-collapse: collapse;
}
.report-data-view th {
  position: sticky;
  top: 0;
  padding: 6px 8px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-align: left;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background: var(--color-bg-alt);
  border-bottom: 1px solid var(--color-border);
}
.report-data-view td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.report-data-view-note {
  margin: 0 0 8px;
  color: var(--color-text-secondary);
}
/* The chart runtime frames the view with a heading and a close control of its own, and it styles the control
   inline with round corners. The frame takes the mono title and the square corners of the card. */
.chart-container div:has(> div > .report-data-view) > h4 {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-primary-500) !important;
}
.chart-container div:has(> div > .report-data-view) > div:last-child > div {
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 0 !important;
}

/* ── References appendix ──────────────────────────────── */
/* The appendix is a record of where each value came from. A reader consults it, and a reader does not read
   it through. Thus it stays smaller and quieter than the body of the report. One list holds both reference
   kinds, thus one set of rules styles an artifact entry and a paper entry alike. */
.report-ref-title {
  color: var(--color-text-secondary);
}
.report-references {
  padding-left: 24px;
  list-style: decimal;
  color: var(--color-text-muted);
}
.report-ref-item {
  margin-bottom: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.report-ref-kind {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.report-ref-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-primary-700);
}
.report-ref-detail {
  color: var(--color-text-muted);
}
/* The chain of a derived path reads under its entry, thus the entry line keeps the form of a pinned
   artifact and the sources sit on a line of their own. */
.report-ref-chain {
  margin-top: 2px;
  color: var(--color-text-muted);
}
/* A link of the chain: the staged script, and the derived file. The link carries the code span of its
   subject, thus the underline arrives on hover alone and the line stays quiet. */
.report-ref-link {
  text-decoration: none;
}
.report-ref-link:hover {
  text-decoration: underline;
}
/* The head of a content hash. It reads smaller than a path, because it identifies bytes and a reader
   compares it against a staged file name instead of reading it. */
.report-ref-hash {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
}
.report-cite-source {
  color: var(--color-text-secondary);
}
/* The description of the paper reads under its citation, thus it takes a line of its own. */
.report-cite-description {
  margin-top: 2px;
  color: var(--color-text-muted);
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
/* The first pass of the observer reveals what is already in view. That reveal drops the transition, thus
   the page is settled when it signals readiness and a capture shows the final state. */
.fade-in-instant {
  transition: none;
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
  /* The panel stands at once, thus the open costs no motion. */
  .report-lineage-popover {
    animation: none;
  }
}

/* ── Print ────────────────────────────────────────────── */
@media print {
  .report-nav {
    display: none;
  }
  /* The control opens a panel, and paper opens nothing. The appendix carries the same references, thus the
     printed page loses no evidence. */
  .report-lineage,
  .report-lineage-popover {
    display: none;
  }
  /* Each export draws a file on the screen, and paper downloads nothing. The page script hides the toolbox of
     each chart before the print, because the chart runtime draws it inside the chart body. */
  .report-chart-menu-open {
    display: none;
  }
  .report-chart-download {
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
}`;

/**
 * The row height and the header height of a grid, in pixels.
 *
 * The theme takes both, and the page script measures the mount with the same two numbers. Thus the box of
 * the mount and the rows inside it agree, and no row half shows at the bottom edge.
 */
export const GRID_ROW_HEIGHT_PX = 36;
export const GRID_HEADER_HEIGHT_PX = 40;

/**
 * The bottom border of the header row, in pixels.
 *
 * The grid draws that border under the header, thus the box of the mount holds the header, this border, and
 * the rows. Without it the last row sits one pixel past the box, and the grid paints a scrollbar over a
 * table that fits.
 */
export const GRID_HEADER_BORDER_PX = 1;

/**
 * The count of rows that a grid shows before it scrolls, and the smallest width of a column.
 *
 * A card of a fixed height would leave a short table half empty. The page script takes the smaller of this
 * count and the row count, thus a table of three rows takes the height of three rows.
 */
export const GRID_VISIBLE_ROWS = 12;
export const GRID_MIN_COLUMN_WIDTH_PX = 120;

/** The delay before a cell tooltip shows, in milliseconds. */
export const GRID_TOOLTIP_DELAY_MS = 200;

/**
 * The count of rows that a print form holds.
 *
 * The print layout lays every row out at once, and a table with no row bound would take hundreds of pages.
 * The print stops at this count, the note of the card states the truncation, and the download carries the
 * whole table. A table under the count prints whole.
 */
export const GRID_PRINT_ROW_CAP = 1000;

/**
 * The theme parameters of a grid. The page script passes them to `themeQuartz.withParams`.
 *
 * The values read the shared tokens above. Thus the palette, the two font families, and the header
 * treatment of the grid are the palette, the families, and the treatment of the page.
 *
 * `browserColorScheme` pins the light scheme. The page carries one palette, thus a browser in the dark
 * scheme must not invert the grid under it.
 */
export const GRID_THEME_PARAMS = {
    accentColor: TOKEN.primary500,
    backgroundColor: TOKEN.card,
    foregroundColor: TOKEN.textStrong,
    borderColor: TOKEN.border,
    browserColorScheme: "light",
    fontFamily: TOKEN.fontSans,
    fontSize: 14,
    headerBackgroundColor: TOKEN.bgAlt,
    headerFontFamily: TOKEN.fontMono,
    headerFontSize: 11,
    headerFontWeight: 600,
    headerTextColor: TOKEN.textSecondary,
    headerHeight: GRID_HEADER_HEIGHT_PX,
    iconColor: TOKEN.textMuted,
    oddRowBackgroundColor: TOKEN.card,
    rowHeight: GRID_ROW_HEIGHT_PX,
    rowHoverColor: TOKEN.bgAlt,
    subtleTextColor: TOKEN.textMuted,
    // The corner-accent card around the mount carries the border and the square corners of the identity.
    // A second border on the wrapper would double the rule at each edge of the card.
    wrapperBorder: false,
    wrapperBorderRadius: 0,
    borderRadius: 0,
};

/**
 * The registered name of the ECharts theme. The registration script writes this name, and the bootstrap
 * reads it. One source prevents a silent mismatch between the two sites.
 */
export const ECHARTS_THEME_NAME = "inflexa";

/**
 * The font stack of the chart text: the journal sans stack. A figure keeps its own typography on the page
 * and in the paper, thus the chart text never reads the page fonts.
 *
 * No family name takes quotes. The server render of the chart runtime writes the stack into a double-quoted
 * `style` attribute with no escape, and a double quote there breaks the SVG file.
 */
export const CHART_FONT_STACK = "Helvetica, Arial, sans-serif";

/**
 * The text sizes of a chart, in pixels: on the page, in the SVG and the column PNG, and in the slide PNG.
 *
 * The print size is 7 points at the column width, which is the upper bound of the Nature guide (5 to 7
 * points), at 96 pixels for each inch. The slide size reads from the back of a room at the full width of a
 * slide.
 */
export const CHART_PAGE_TEXT_PX = 12;
export const CHART_PRINT_TEXT_PX = 9.33;
export const CHART_SLIDE_TEXT_PX = 24;

/** The names of the two export themes. The registration script and the export read the same names. */
export const CHART_PRINT_THEME_NAME = `${ECHARTS_THEME_NAME}-print`;
export const CHART_SLIDE_THEME_NAME = `${ECHARTS_THEME_NAME}-slide`;

/** The pixel ratio of a column PNG: 300 dots for each inch, over the 96 CSS pixels of one inch. */
const COLUMN_PIXEL_RATIO = 300 / 96;

/** The size of one chart export: the name of its theme, the CSS pixel box, and the millimeter box of a column. */
export interface ChartExportSize {
    readonly theme: string;
    readonly textPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly widthMm?: number;
    readonly heightMm?: number;
    readonly pixelRatio: number;
    readonly label: string;
}

/**
 * The export sizes of a chart: the single journal column, the double journal column, and a 16:9 slide.
 *
 * A column states its box in millimeters and in CSS pixels at 96 pixels for each inch: 89 × 67 mm is 336 ×
 * 253 px, and 183 × 92 mm is 692 × 348 px. The column PNG draws at a pixel ratio of 3.125, which is 300 DPI,
 * thus the single column is 1050 px wide. The slide draws at 1920 × 1080 px at a ratio of one. The columns
 * read the print text size, and the slide reads the slide text size.
 */
export const CHART_EXPORT_SIZES = {
    single: {
        theme: CHART_PRINT_THEME_NAME,
        textPx: CHART_PRINT_TEXT_PX,
        widthPx: 336,
        heightPx: 253,
        widthMm: 89,
        heightMm: 67,
        pixelRatio: COLUMN_PIXEL_RATIO,
        label: "89 mm",
    },
    double: {
        theme: CHART_PRINT_THEME_NAME,
        textPx: CHART_PRINT_TEXT_PX,
        widthPx: 692,
        heightPx: 348,
        widthMm: 183,
        heightMm: 92,
        pixelRatio: COLUMN_PIXEL_RATIO,
        label: "183 mm",
    },
    slide: { theme: CHART_SLIDE_THEME_NAME, textPx: CHART_SLIDE_TEXT_PX, widthPx: 1920, heightPx: 1080, pixelRatio: 1, label: "16:9" },
} as const satisfies Record<string, ChartExportSize>;

/** The height that each further row of facet panels adds to the chart body, in pixels. */
export const FACET_ROW_PX = 360;

/** The largest chart body, in pixels. A figure of more rows than this height holds hides a name that overlaps its neighbor. */
export const CHART_BODY_MAX_PX = 1480;

/**
 * The width of the chart body on a page at a window 1280 pixels wide, in pixels. A derivation that fits its
 * category labels to the page measures them against this width.
 */
export const CHART_PAGE_WIDTH_PX = 900;

/** The largest height of a journal figure: 170 mm, the full page depth of the Nature guide. */
export const CHART_EXPORT_MAX_HEIGHT_MM = 170;

/** The CSS pixels of one millimeter, at 96 pixels for each inch. */
const PX_PER_MM = 96 / 25.4;

/**
 * The export size of a chart whose body is taller than the default body.
 *
 * A column export keeps its width, and its height grows in the ratio of the body to the default body, thus a
 * row of the figure keeps its share of the height in the export. The height stops at the journal maximum. A
 * slide keeps its 16:9 box, and a chart of the default body keeps each size.
 */
export function exportSizeFor(size: ChartExportSize, bodyPx: number): ChartExportSize {
    if (bodyPx <= CHART_BODY_PX || size.heightMm === undefined) return size;
    const heightPx = Math.min(Math.floor(CHART_EXPORT_MAX_HEIGHT_MM * PX_PER_MM), Math.round((size.heightPx * bodyPx) / CHART_BODY_PX));
    return { ...size, heightPx, heightMm: Math.round(heightPx / PX_PER_MM) };
}

/**
 * The near-black ink of a chart: the text, the two axis lines, and the stroke of an interval.
 *
 * A journal figure draws its frame and its text in one dark ink, thus the page and the export read alike.
 */
export const CHART_INK = "#222222";

/**
 * The categorical palette of a chart: the Okabe-Ito set, in the order blue, vermilion, bluish green,
 * orange, reddish purple, sky blue, yellow, and black.
 *
 * The set is public and colorblind-safe: no two hues differ by a red-green difference alone. A series that
 * names no color takes the next hue of this order.
 */
export const CHART_PALETTE = ["#0072b2", "#d55e00", "#009e73", "#e69f00", "#cc79a7", "#56b4e9", "#f0e442", "#000000"] as const;

/**
 * The categorical palette of a chart that draws more than eight categories: the eight hues of the Okabe-Ito
 * set in their order, then sixteen more hues. Each hue differs from its neighbors in hue or in lightness, and
 * no hue is near white. The order is fixed, thus one category count gives one set of colors on every chart.
 *
 * Past eight categories no palette stays safe for each color-vision deficiency, thus the colors carry the
 * categories and the legend names them.
 */
export const CHART_WIDE_PALETTE = [
    ...CHART_PALETTE,
    "#875692",
    "#8db600",
    "#be0032",
    "#a1caf1",
    "#882d17",
    "#17becf",
    "#f99379",
    "#604e97",
    "#dcd300",
    "#b3446c",
    "#2b3d26",
    "#e68fac",
    "#654522",
    "#c2b280",
    "#e7298a",
    "#7fc97f",
] as const;

/**
 * The stroke of a guide line: a thin gray dash. A guide is a reference and never a plotted value, thus it
 * reads behind the data.
 */
export const GUIDE_LINE_COLOR = "#8c8c8c";
export const GUIDE_LINE_WIDTH_PX = 1;

/** The one focus color of a chart. It is the first hue of the palette, thus a focus reads as the lead series. */
export const FOCUS_CHART_COLOR = CHART_PALETTE[0];

/**
 * The sequential ramp of a continuous color: the ten stops of viridis, dark to light. A continuous scale maps
 * the low value to `#440154` and the high value to `#fde725`.
 */
export const SEQUENTIAL_RAMP = ["#440154", "#482777", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"] as const;

/**
 * The diverging ramp of a continuous color: the palette blue through a near-white to the palette vermilion.
 * The derivation centers the ramp on zero, thus the near-white stop marks no change.
 */
export const DIVERGING_RAMP = [CHART_PALETTE[0], "#f7f7f7", CHART_PALETTE[1]] as const;

/** The smallest and the largest symbol of a `size` channel, in pixels. */
export const SIZE_CHANNEL_RANGE_PX = [6, 24] as const;

/**
 * The band at the right edge of a chart that a continuous color scale takes, in percent of the width. The plot
 * leaves the band free, and the title of the scale in an export wraps into it.
 */
export const COLOR_SCALE_BAND_PCT = 18;

/**
 * The largest count of slots of one chart, where a slot is one pair of a category and a group. A stacked form,
 * a radar, a violin, and a heatmap lay out one slot for each pair, thus the bound holds their grids to a size
 * that a reader reads and that the render holds in memory.
 */
export const CHART_SLOT_LIMIT = 100_000;

/**
 * The largest count of bars that carry a value label, counted across the series of one chart.
 *
 * A label on each of a few bars reads as the exact value beside the bar. Past this count the labels crowd
 * each other, and the axis reads better alone.
 */
export const BAR_VALUE_LABEL_LIMIT = 12;

/**
 * The largest count of facet panels of one chart, and the count of panels in one row.
 *
 * A small multiple compares its panels at a glance. Past twelve panels each panel is too small to read, and
 * a derived table of fewer groups serves the reader better.
 */
export const FACET_PANEL_LIMIT = 12;
export const FACET_COLUMNS = 3;

/**
 * The muted chart color, beside the palette of the theme.
 *
 * A null category states no finding, thus it must recede behind the categories that do. The value is the
 * `--color-ns` token of the tokens above. A chart option rides to the page as inline JSON, thus it reads no
 * custom property and the color is written again here.
 */
export const MUTED_CHART_COLOR = "#94a3b8";

/**
 * The symbol ladder of a scatter, as one row count and one symbol size for each tier.
 *
 * A sparse scatter keeps the symbol of the chart runtime. Past the hover count the points sit close, thus
 * the series takes a larger symbol and a point stays hoverable. Past the crowd count the plot is a cloud.
 * A larger symbol paints one blob there, thus the series takes a small symbol at a reduced opacity. The
 * shape of the cloud then reads. Per-point hover is lost in a crowd, and shape legibility wins.
 */
export const SCATTER_HOVER_ROWS = 2000;

/** The symbol size of a scatter past the hover count. The ECharts default is 10, thus a point grows one step. */
export const SCATTER_HOVER_SYMBOL_SIZE = 12;

/** The row count from which a scatter recedes into a cloud. */
export const SCATTER_CROWD_ROWS = 10000;

/** The symbol size of a crowded scatter. It matches the outlier dot of a box plot. */
export const SCATTER_CROWD_SYMBOL_SIZE = 4;

/** The opacity of a crowded scatter point. An overlap then reads darker than a lone point. */
export const SCATTER_CROWD_OPACITY = 0.5;

/**
 * The size bound of an inline chart option, in characters of serialized JSON.
 *
 * A small option reads well inside the page, and it costs one element. A dense scatter of many thousands of
 * points writes each pair again inside the markup, and one such chart then holds most of the bytes of the
 * page. Past this bound the option carries no row, and the chart reads the columnar payload of its artifact.
 */
export const CHART_INLINE_OPTION_BOUND = 100_000;

/**
 * The publication theme of a chart, at one text size.
 *
 * The page and the export read one theme, thus a chart on the page is the chart that the paper gets. The
 * left and the bottom axis lines are strong and dark, with ticks outside the plot. There is no grid line, no
 * frame around the legend, and no toolbox, because the chart card adds the toolbox of the page and a file carries
 * none. The text reads in the journal sans stack and in the near-black ink.
 *
 * The chart runtime reads the style of an axis by its type, thus each of the four axis types carries the same
 * style. The text size scales the text alone: the page, the print export, and the slide export each register
 * one theme.
 */
export function chartTheme(textPx: number) {
    const axis = {
        axisLine: { show: true, lineStyle: { color: CHART_INK, width: CHART_AXIS_LINE_PX } },
        axisTick: { show: true, inside: false, lineStyle: { color: CHART_INK, width: CHART_AXIS_LINE_PX } },
        axisLabel: { color: CHART_INK, fontSize: textPx },
        splitLine: { show: false },
        nameTextStyle: { color: CHART_INK, fontSize: textPx },
    };
    // A value axis draws its line at the edge of the plot, thus the left and the bottom lines frame the figure.
    // A category axis keeps its line on the zero of the value axis, thus a bar stands on a zero baseline.
    const valueAxis = { ...axis, axisLine: { ...axis.axisLine, onZero: false } };
    return {
        color: [...CHART_PALETTE],
        backgroundColor: "transparent",
        textStyle: { fontFamily: CHART_FONT_STACK, fontSize: textPx, color: CHART_INK },
        title: { show: false },
        legend: {
            bottom: 0,
            borderWidth: 0,
            textStyle: { fontFamily: CHART_FONT_STACK, fontSize: textPx, color: CHART_INK },
            itemGap: 16,
            itemWidth: textPx,
            itemHeight: textPx,
        },
        grid: { left: 60, right: 24, top: 24, bottom: 48, containLabel: false },
        tooltip: {
            backgroundColor: "#ffffff",
            borderColor: "#e2e8f0",
            textStyle: { color: "#334155", fontSize: 12 },
            extraCssText: "border-radius: 4px; box-shadow: 0 4px 12px rgba(15,23,42,0.1);",
        },
        categoryAxis: axis,
        valueAxis,
        logAxis: valueAxis,
        timeAxis: valueAxis,
        visualMap: { textStyle: { fontFamily: CHART_FONT_STACK, fontSize: textPx, color: CHART_INK } },
        radar: {
            axisName: { color: CHART_INK, fontSize: textPx },
            axisLine: { lineStyle: { color: CHART_RADAR_WEB } },
            splitLine: { lineStyle: { color: CHART_RADAR_WEB } },
            splitArea: { show: false },
        },
    };
}

/** The width of the two axis lines and of their ticks, in pixels. */
const CHART_AXIS_LINE_PX = 1.5;

/** The light web of a radar. The web is the coordinate of the radar, thus it stays and recedes. */
const CHART_RADAR_WEB = "#d4d4d4";

/**
 * The colors and the font of the toolbox of a page chart: a quiet icon, the primary accent on hover, and the mono
 * face of the card title for the title of an icon.
 */
export const CHART_TOOLBOX_ICON_COLOR = TOKEN.textSecondary;
export const CHART_TOOLBOX_ACTIVE_COLOR = TOKEN.primary500;
export const CHART_TOOLBOX_FONT = TOKEN.fontMono;

/** The theme that the page registers under `ECHARTS_THEME_NAME`, at the page text size. */
export const ECHARTS_THEME = chartTheme(CHART_PAGE_TEXT_PX);

/**
 * The registered themes: the page theme, the print theme of the SVG and the column PNG, and the slide theme.
 * The registration script writes each one, and the export reads one by its name.
 */
export const CHART_THEMES = [
    { name: ECHARTS_THEME_NAME, textPx: CHART_PAGE_TEXT_PX },
    { name: CHART_PRINT_THEME_NAME, textPx: CHART_PRINT_TEXT_PX },
    { name: CHART_SLIDE_THEME_NAME, textPx: CHART_SLIDE_TEXT_PX },
] as const;
