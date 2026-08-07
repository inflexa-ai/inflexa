/**
 * The page constants: the CDN pins, the inline style, the ECharts theme, and the chart bootstrap.
 *
 * These constants are copies. The old template pack at `templates/report-html` holds the source, and the
 * old render path owns that directory. The renderer never reads that directory at run time, thus the
 * output stays a pure function of its inputs. A copy that drifts is a maintenance cost, and it is the
 * price of a page with no local asset and no template engine.
 */

/**
 * The head references: the Tailwind runtime, the ECharts runtime, the two fonts, and the preconnect. Each
 * tag carries the pinned version and, where the source pins one, the integrity hash. The bytes are exact
 * copies, thus the page stays deterministic and the hashes stay valid.
 */
export const CDN_HEAD = `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.2/dist/index.global.min.js" integrity="sha384-shaHAtPgz0ulP7R/YmFe0nZtC8FxdhJPi73vwJQcADVttxvHLJBJt/pjzkLSbIvL" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js" integrity="sha384-Mx5lkUEQPM1pOJCwFtUICyX45KNojXbkWdYhkKUKsbv391mavbfoAmONbzkgYPzR" crossorigin="anonymous"></script>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link href="https://cdn.jsdelivr.net/npm/@fontsource-variable/space-grotesk@5.1.1/index.css" rel="stylesheet" integrity="sha384-b3Dtcpab/ltw+oDnVHstCCa9ENEb2hKouCSRAfb8o0ROkWOb2uNWYG6+l7HGrHmG" crossorigin="anonymous">
<link href="https://cdn.jsdelivr.net/npm/@fontsource-variable/ibm-plex-mono@5.1.1/index.css" rel="stylesheet">`;

/**
 * The style rules of the page. The renderer inlines them in one `<style>` block, thus the page holds the
 * whole design token set and every component rule with no external stylesheet.
 */
export const PAGE_CSS = `/* ── Color Palette ────────────────────────────────────── */
:root {
  /* Primary Scale */
  --color-primary-50:  #f0f1fe;   /* Tag bg, CTA section bg */
  --color-primary-100: #dde0fc;
  --color-primary-200: #bcc2f9;   /* Badge borders, corner accent default */
  --color-primary-300: #9ba5f5;   /* Corner button accent default */
  --color-primary-400: #7987f0;   /* Section illustration icons */
  --color-primary-500: #576dea;   /* Primary action, section labels, links */
  --color-primary-600: #4458d4;   /* Button hover */
  --color-primary-700: #3545b0;   /* Tag text on primary-50 bg */

  /* Text */
  --color-heading:        #0f172a; /* slate-900 — all headings */
  --color-text:           #475569; /* slate-600 — body text */
  --color-text-secondary: #64748b; /* slate-500 — captions, metadata */
  --color-text-muted:     #94a3b8; /* slate-400 — timestamps, footnotes */

  /* Surface */
  --color-bg:             #ffffff; /* Page background (white) */
  --color-bg-alt:         #f8fafc; /* Alternating section bg (slate-50) */
  --color-card:           #ffffff; /* Cards (white) */
  --color-border:         #e2e8f0; /* slate-200 — card borders, dividers */
  --color-border-hover:   #cbd5e1; /* slate-300 — hover borders */

  /* Data Visualization */
  --color-up:   #ef4444; /* Red 500 — upregulated, positive */
  --color-down: #576dea; /* Primary 500 — downregulated, negative */
  --color-ns:   #94a3b8; /* Slate 400 — not significant */

  /* Semantic (Tags — solid bg + colored text) */
  --color-high-bg:    #f0fdf4;  /* green-50 */
  --color-high-text:  #15803d;  /* green-700 */
  --color-medium-bg:  #fffbeb;  /* amber-50 */
  --color-medium-text:#b45309;  /* amber-700 */
  --color-low-bg:     #fef2f2;  /* red-50 */
  --color-low-text:   #b91c1c;  /* red-700 */

  /* Stat card accent colors */
  --color-stat-primary: #576dea;
  --color-stat-green:   #22c55e;
  --color-stat-red:     #ef4444;
  --color-stat-purple:  #a78bfa;
  --color-stat-amber:   #f59e0b;
}

/* ── Typography ───────────────────────────────────────── */
body {
  font-family: 'Space Grotesk Variable', system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--color-text);
}

.font-mono, code, .gene {
  font-family: 'IBM Plex Mono Variable', ui-monospace, monospace;
}

/* Rule: Headings use font-sans (Space Grotesk), never font-mono.
   Labels, tags, badges, data, product names always use font-mono (IBM Plex Mono). */

/* ── Corner Accent Cards ─────────────────────────────── */
.corner-accents {
  position: relative;
  border: 1px solid var(--color-border);
  background: var(--color-card);
  /* No border-radius — square corners */
}
.corner-accents::before,
.corner-accents::after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  transition: all 0.3s ease;
  pointer-events: none;
}
.corner-accents::before {
  top: -1px; left: -1px;
  border-top: 2px solid var(--color-primary-200);
  border-left: 2px solid var(--color-primary-200);
}
.corner-accents::after {
  bottom: -1px; right: -1px;
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

/* ── Window Chrome Panel ─────────────────────────────── */
/* Exception: uses rounded-xl (only rounded component) */
.window-chrome {
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-card);
  box-shadow: 0 8px 30px -8px rgba(15,23,42,0.08), 0 4px 12px -4px rgba(15,23,42,0.04);
  transition: all 0.5s ease;
}
.window-chrome:hover {
  transform: translateY(-4px);
  box-shadow: 0 25px 50px -12px rgba(15,23,42,0.18), 0 12px 24px -8px rgba(15,23,42,0.1);
  border-color: var(--color-border-hover);
}
.window-chrome .chrome-dots span { transition: background-color 0.3s ease; }
.window-chrome:hover .chrome-dots .dot-1 { background-color: #fb7185; }
.window-chrome:hover .chrome-dots .dot-2 { background-color: #fbbf24; }
.window-chrome:hover .chrome-dots .dot-3 { background-color: #4ade80; }

/* ── Terminal Card ───────────────────────────────────── */
.terminal-card {
  position: relative;
  overflow: hidden;
}
.terminal-card .terminal-header {
  background: #1e293b; /* slate-800 */
}
.terminal-card .terminal-body-dark {
  background: #0f172a; /* slate-900 */
  color: #e2e8f0;
}
.terminal-card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 2px,
    rgba(148, 163, 184, 0.03) 2px, rgba(148, 163, 184, 0.03) 4px
  );
  transition: opacity 0.3s ease;
}
.terminal-card:hover::after { opacity: 1; }

/* ── Block Progress Bar ──────────────────────────────── */
/* Usage: <span class="block-progress"><span class="filled-high">████████</span><span class="empty">░░</span> <span class="score">0.82</span></span> */
.block-progress {
  font-family: 'IBM Plex Mono Variable', ui-monospace, monospace;
  font-size: 14px;
}
.block-progress .filled-high { color: var(--color-primary-500); } /* ≥ 0.8 */
.block-progress .filled-mid  { color: #f59e0b; }                  /* ≥ 0.6 */
.block-progress .filled-low  { color: #f43f5e; }                  /* < 0.6 */
.block-progress .empty       { color: #e2e8f0; }
.block-progress .score       { font-size: 12px; color: #94a3b8; margin-left: 8px; }

/* ── Sidebar Navigation ──────────────────────────────── */
/* When a sidebar is rendered (#report-sidebar), the body shifts right on lg+
   to make room. Styling matches the corner-accent / mono-label language. */
@media (min-width: 1024px) {
  body:has(#report-sidebar) { padding-left: 15rem; }
}
.sidebar-link {
  border-left: 2px solid transparent;
}
.sidebar-link.active {
  color: var(--color-primary-500);
  background-color: var(--color-primary-50);
  border-left-color: var(--color-primary-500);
  font-weight: 600;
}

/* ── Insight Box ─────────────────────────────────────── */
.insight-box {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  /* No border-radius — uses corner-accents class */
}

/* ── Section Textures ────────────────────────────────── */
/* Apply to <section>: combine one pattern + noise, e.g. class="texture-dots texture-noise" */
/* Textures should be felt, not seen — low opacity, faded edges */

/* ── Fade-In ─────────────────────────────────────────── */
.fade-in {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.7s ease-out, transform 0.7s ease-out;
}
.fade-in-visible {
  opacity: 1;
  transform: translateY(0);
}
/* Stagger with data-delay attribute: <div class="fade-in" data-delay="100"> */`;

/**
 * The registered name of the ECharts theme. The skeleton registers the theme under this name, and the
 * bootstrap reads the same name. One source prevents a silent mismatch between the two sites.
 */
export const ECHARTS_THEME_NAME = "inflexa";

/**
 * The ECharts theme as a plain object. The renderer serializes this object and registers it, thus the
 * theme never rides a JSON file and no run-time read is necessary. The palette and the axis styles mirror
 * the light design tokens of the page.
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

/**
 * The page-side script that wires each chart. It finds every chart container, reads the option JSON from
 * the sibling `<script type="application/json">` element, and initializes ECharts with the registered
 * theme. The skeleton registers the theme before this script runs. A resize handler keeps each chart
 * fit to the window.
 */
export const CHART_BOOTSTRAP = `(function () {
  if (typeof echarts === "undefined") {
    return;
  }
  var containers = document.querySelectorAll("[data-echarts-id]");
  for (var i = 0; i < containers.length; i++) {
    var container = containers[i];
    var optionScript = container.nextElementSibling;
    if (!optionScript || optionScript.getAttribute("type") !== "application/json") {
      continue;
    }
    var option = JSON.parse(optionScript.textContent || "{}");
    var chart = echarts.init(container, ${JSON.stringify(ECHARTS_THEME_NAME)});
    chart.setOption(option);
  }
  window.addEventListener("resize", function () {
    var nodes = document.querySelectorAll("[data-echarts-id]");
    for (var j = 0; j < nodes.length; j++) {
      var instance = echarts.getInstanceByDom(nodes[j]);
      if (instance) {
        instance.resize();
      }
    }
  });
})();`;
