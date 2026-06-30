# Design System

Visual design reference for Inflexa HTML reports. Light theme following the **Inflexa Design Blueprint**. Styles are defined as Tailwind v4 `@theme` tokens and CSS classes in `base.html.j2`.

## Colors

### Primary Scale

| Token | Hex | Tailwind | Usage |
|-|-|-|-|
| primary-50 | #f0f1fe | `bg-primary-50` | Tag backgrounds, section accents |
| primary-100 | #dde0fc | `bg-primary-100` | — |
| primary-200 | #bcc2f9 | `border-primary-200` | Badge borders, corner accent default |
| primary-300 | #9ba5f5 | `text-primary-300` | Corner button accent default |
| primary-400 | #7987f0 | `text-primary-400` | Section illustration icons |
| primary-500 | #576dea | `text-primary-500` | **Primary action**, section labels, links, stat values |
| primary-600 | #4458d4 | `bg-primary-600` | Button hover |
| primary-700 | #3545b0 | `text-primary-700` | Tag text on primary-50 bg |

### Neutrals (Tailwind Slate)

| Token | Usage |
|-|-|
| slate-50 (#f8fafc) | Alternating section bg, table header bg |
| slate-100 (#f1f5f9) | Subtle borders, grid lines |
| slate-200 (#e2e8f0) | Card borders, dividers |
| slate-300 (#cbd5e1) | Hover borders, separator lines |
| slate-400 (#94a3b8) | Muted text, timestamps |
| slate-500 (#64748b) | Secondary text, captions |
| slate-600 (#475569) | Body text |
| slate-700 (#334155) | Table cell text |
| slate-800 (#1e293b) | Terminal header bg |
| slate-900 (#0f172a) | Headings, footer bg |

### Data Visualization

| Token | Hex | Usage |
|-|-|-|
| Up/positive | #ef4444 | Upregulated genes (red-500) |
| Down/negative | #576dea | Downregulated genes (primary-500) |
| Not significant | #94a3b8 | NS in volcano plots (slate-400) |

### Semantic Tags (Solid)

| Level | Background | Text |
|-|-|-|
| High | #f0fdf4 (green-50) | #15803d (green-700) |
| Medium | #fffbeb (amber-50) | #b45309 (amber-700) |
| Low | #fef2f2 (red-50) | #b91c1c (red-700) |
| Primary | #f0f1fe (primary-50) | #3545b0 (primary-700) |

### Stat Card Accent Colors

| Name | Hex | Usage |
|-|-|-|
| primary | #576dea | Default, general metrics |
| green | #22c55e | Positive counts, success |
| red | #ef4444 | Upregulated, warnings |
| purple | #a78bfa | Special metrics |
| amber | #f59e0b | Caution, amber metrics |

### ECharts Palette

The `inflexa` theme uses this 10-color series:
`#576dea` `#ef4444` `#22c55e` `#a78bfa` `#f59e0b` `#ec4899` `#06b6d4` `#f97316` `#8b5cf6` `#14b8a6`

## Typography

### Font Families

| Family | CSS / Tailwind | Usage |
|-|-|-|
| Space Grotesk | `font-sans` | Headings, body text |
| IBM Plex Mono | `font-mono` | Labels, tags, badges, data values, gene symbols |

Fonts are loaded via cdn.jsdelivr.net (fontsource variable) in the base template. NOT from fonts.googleapis.com (blocked by CSP).

**Rule**: Headings never use `font-mono`. Labels, tags, badges, data, and product names always use `font-mono`. Body text is `text-slate-600`. Headings are `text-slate-900`.

### Size Scale

| Element | Tailwind Classes |
|-|-|
| Section heading | `text-3xl font-semibold tracking-tight text-slate-900` |
| Card/table title | `text-sm font-semibold text-slate-900` |
| Body text | `text-base leading-relaxed text-slate-600` |
| Section label | `font-mono text-xs font-semibold uppercase tracking-widest text-primary-500` |
| Tag/badge | `font-mono text-[11px] font-medium` |
| Table header | `font-mono text-[11px] font-semibold text-slate-500 uppercase tracking-wider` |
| Metric value | `font-mono text-3xl font-bold` (in stat card accent color) |
| Caption | `text-xs text-slate-400` |
| Gene symbols | `gene` class (triggers font-mono) |

## Layout

### Page Structure (Full-Width Sections)

```html
<aside id="report-sidebar"><!-- Fixed left navigation, lg+ only --></aside>
<header id="report-hero"><!-- Non-sticky hero: eyebrow + display h1 + lede --></header>
<main>
  <section class="bg-white py-12 md:py-16 relative texture-dots texture-noise">
    <div class="mx-auto max-w-[1600px] px-6 md:px-8 lg:px-12">
      <!-- Section content -->
    </div>
  </section>
  <section class="bg-slate-50 py-12 md:py-16 relative texture-grid texture-noise">
    <div class="mx-auto max-w-[1600px] px-6 md:px-8 lg:px-12">
      <!-- Next section -->
    </div>
  </section>
</main>
<footer class="bg-slate-900"><!-- Dark footer --></footer>
```

### Responsive Grids

```html
<!-- Stats row -->
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">

<!-- 2-column layout -->
<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

<!-- 3-column layout -->
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
```

### Spacing

| Context | Class |
|-|-|
| Section vertical padding | `py-12 md:py-16` |
| Card padding | `p-6` |
| Between content blocks | `mt-8` |
| Grid gap | `gap-6` |
| Container horizontal | `px-6 md:px-8 lg:px-12` |
| Container max width | `max-w-[1600px]` |

## Components

### Corner Accent Cards (Feature/Data Cards)

```html
<div class="corner-accents border border-slate-200 bg-white p-6 hover:shadow-md transition-shadow duration-200">
  <!-- Content -->
</div>
```

- No border-radius (square corners)
- L-shaped accent lines at top-left and bottom-right
- Default accent: primary-200, hover: primary-500
- Lines grow from 20px to 28px on hover

### Window Chrome Panels (Charts)

```html
<div class="window-chrome rounded-xl border border-slate-200 bg-white overflow-hidden ...">
  <div class="flex items-center ... border-b border-slate-100 bg-slate-50/50">
    <div class="chrome-dots flex items-center gap-1.5">
      <span class="dot-1 h-2.5 w-2.5 rounded-full bg-slate-300"></span>
      <span class="dot-2 h-2.5 w-2.5 rounded-full bg-slate-300"></span>
      <span class="dot-3 h-2.5 w-2.5 rounded-full bg-slate-300"></span>
    </div>
    <!-- Title center, product label right -->
  </div>
  <div class="p-4"><!-- Chart --></div>
</div>
```

- Exception to square corners: uses `rounded-xl`
- Layered box-shadow, hover lift (-translate-y-1)
- Dots animate to rose/amber/green on hover
- Right-aligned `CORTEX` label in mono

### Terminal Cards (Data Displays)

```html
<div class="terminal-card rounded-none border border-slate-200">
  <div class="terminal-header px-4 py-2.5 flex items-center gap-2">
    <span class="h-2 w-2 rounded-full bg-rose-400/80"></span>
    <span class="h-2 w-2 rounded-full bg-amber-400/80"></span>
    <span class="h-2 w-2 rounded-full bg-green-400/80"></span>
    <span class="font-mono text-xs text-slate-300 ml-2">filename.json</span>
  </div>
  <div class="terminal-body-dark p-4 font-mono text-sm">
    <!-- Monospace content on dark bg -->
  </div>
</div>
```

- Dark header (slate-800), optional dark body (slate-900)
- CRT scanline overlay on hover
- Good for evidence dossiers, JSON displays, raw data

### Block Progress Bars

```html
<span class="block-progress">
  <span class="filled-high">████████</span><span class="empty">░░</span>
  <span class="score">0.82</span>
</span>
```

- `filled-high`: primary-500 (>= 0.8)
- `filled-mid`: amber-500 (>= 0.6)
- `filled-low`: rose-500 (< 0.6)
- `empty`: slate-200
- Never use rounded progress bars

### Tags / Badges

```html
<!-- Mono tag -->
<span class="rounded-sm bg-primary-50 px-2 py-0.5 font-mono text-[11px] font-medium text-primary-700">
  RNA-seq
</span>

<!-- Status tag -->
<span class="rounded-sm bg-green-50 px-2 py-0.5 font-mono text-[11px] font-medium text-green-700">
  Complete
</span>
```

## Textures

Every section should have a subtle texture:

| Class | Effect |
|-|-|
| `texture-dots` | 0.75px dots at 6px intervals, faded edges |
| `texture-grid` | 1px grid lines at 32px intervals, faded edges |
| `texture-noise` | Paper noise overlay at ~6% opacity |

Rules:
- Alternate between `texture-dots` and `texture-grid` across sections
- Always layer `texture-noise` on top
- Both use `::before`/`::after` pseudo-elements with faded-edge masks

## Shadows

### Panel cards (window chrome)

```
Default: 0 8px 30px -8px rgba(15,23,42,0.08), 0 4px 12px -4px rgba(15,23,42,0.04)
Hover:   0 25px 50px -12px rgba(15,23,42,0.18), 0 12px 24px -8px rgba(15,23,42,0.1)
```

### General cards (corner accents)

```
Default: none (border only)
Hover:   shadow-md (Tailwind)
```

## Animations

### Fade-In

All sections use the `fade-in` class:
- Start: `opacity-0 translate-y-5`
- Visible: `opacity-1 translate-y-0`
- Duration: 700ms ease-out
- Fires once (IntersectionObserver, threshold 0.08)
- Stagger via `data-delay` attribute (0, 100, 200, ...)

### Hover Transitions

- Cards: `duration-200` for shadow
- Window chrome: `duration-500` for transform
- Buttons/links: `duration-150`

### Reduced Motion

All animations respect `prefers-reduced-motion: reduce` — durations collapse to 0.01ms.

## ECharts (Light Mode)

Charts use transparent background (inherits white panel bg). Key settings:
- Grid lines: `#f1f5f9` (slate-100, dashed)
- Axis labels: `#64748b` (slate-500)
- Tooltip: white bg, `#e2e8f0` border, `#334155` text
- Toolbox icon: `#94a3b8` (slate-400)

## Print

The base template includes print styles:
- Footer becomes white bg
- Textures are hidden
- Fade-in elements are visible
- Elements with `.no-print` are hidden

## Geometric Identity Rules

These rules define the visual personality. They must always be preserved:

1. **No border-radius on data/feature cards** — use corner accent L-shaped lines instead
2. **Corner accents** at opposing corners, grow on hover
3. **Monospace for all data** — labels, tags, badges, gene symbols, product names
4. **Block-character progress bars** (█░) — never rounded bars
5. **Window chrome dots** on chart panels — colorize on hover
6. **Terminal cards** with dark headers and scanline hover effect
7. **Section textures** — every section has a subtle pattern
8. **Wide layout** — max-w-[1600px], use available viewport space
9. **Light theme only** — white and slate-50 alternating, never dark except footer and terminal headers
