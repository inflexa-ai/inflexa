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
/* The control sits beside the bracket marker. It reads as a quiet disclosure and never as a second marker,
   thus it takes the muted color until a hover. The button carries no browser chrome, because a chrome box
   inside a line of prose would break the line. */
.report-lineage {
  margin-left: 2px;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--color-text-muted);
  background: none;
  border: 0;
  cursor: pointer;
}
.report-lineage:hover {
  color: var(--color-primary-500);
}
/* The panel floats over the page. A data card clips its own overflow, thus the page script places the panel
   against the document and no card cuts it. The measure holds a path and its hash head on one line. */
.report-lineage-popover {
  position: absolute;
  z-index: 50;
  max-width: 32rem;
  padding: 12px 16px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.12);
  animation: report-lineage-open 0.12s ease-out;
}
.report-lineage-title {
  margin-bottom: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
/* The hops read in walk order, thus the list numbers them. The type matches the appendix, because a hop and
   an appendix entry answer the same question about one reference. */
.report-lineage-hops {
  margin: 0;
  padding-left: 24px;
  list-style: decimal;
  color: var(--color-text-muted);
}
.report-lineage-hop {
  margin-bottom: 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
/* The note states an absence or a truncation. A reader must read the chain against what it does not hold,
   thus the note sits under the hops and never beside one. */
.report-lineage-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-muted);
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
/* The chart runtime measures the container. A container with no height shows no chart. */
.chart-container {
  width: 100%;
  height: 400px;
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
