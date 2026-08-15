/**
 * The page constants: the head references, the readiness names, and the three page-side scripts.
 *
 * A script here is browser source text, not module code. Thus it reads no module binding, and each value
 * that it needs is interpolated at build time. The style rules and the ECharts theme live in `design.ts`.
 */

import { assetSource, ECHARTS_ASSET } from "./assets.js";
import { ECHARTS_THEME_NAME } from "./design.js";

/**
 * The head references of the staged assets. The page loads the chart runtime from the sibling assets
 * directory, thus the head names no remote host. The manifest gives the staged name, thus the tag and the
 * stage step of the caller cannot disagree.
 */
export const ASSET_HEAD = `<script src="${assetSource(ECHARTS_ASSET)}"></script>`;

/**
 * The name of the readiness event, and the name of the window sentinel that guards a late listener. The
 * bootstrap below emits both names, thus this module owns them. A capture that waits for the page reads the
 * same two constants, thus the emitter and the waiter cannot disagree over a rename.
 */
export const THEME_READY_EVENT = "inflexa-theme-ready";
export const THEME_READY_SENTINEL = "__inflexaThemeReady";

/**
 * The navigation budget and the readiness budget of one page capture, in milliseconds. The readiness budget
 * bounds the wait for the event that the bootstrap dispatches. Every capture of this page reads the same two
 * budgets, thus two capture sites cannot drift apart.
 */
export const PAGE_NAV_TIMEOUT_MS = 20_000;
export const PAGE_READY_TIMEOUT_MS = 8_000;

/**
 * The name of the reveal gate on the window object. The fade-in script installs the gate, and the chart
 * bootstrap reads it. Both scripts read this one constant, thus the installer and the reader cannot
 * disagree over a rename.
 *
 * The gate takes one callback. It runs the callback when the first reveal pass completes, and immediately
 * when that pass already completed. A page that carries no gate runs the callback at once, thus the
 * bootstrap stays correct on its own.
 */
const REVEAL_GATE = "__inflexaWhenRevealed";

/**
 * The budget of the wait for the first observer callback, in milliseconds.
 *
 * The browser delivers that callback in the first rendering update after the observer registers. A page
 * that updates no rendering, for example a hidden tab, delivers nothing. The budget releases the readiness
 * signal in that condition, thus such a page still signals and the capture returns on the signal.
 */
const REVEAL_SETTLE_TIMEOUT_MS = 2_000;

/**
 * The class that marks the navigation link of the section in view, and the bottom root margin of the
 * scrollspy in percent.
 *
 * The design sheet holds the matching rule under the same class name. The negative bottom margin shrinks the
 * observation box to the top band of the viewport. Thus the section that sits nearest the top of the page
 * wins, and a tall section below it never steals the mark.
 */
const NAV_ACTIVE_CLASS = "report-nav-link-active";
const SPY_BOTTOM_MARGIN_PERCENT = 70;

/**
 * The page-side script that wires each chart. It finds every chart container, reads the option JSON from
 * the sibling `<script type="application/json">` element, and initializes ECharts with the registered
 * theme. The skeleton registers the theme before this script runs. A resize handler keeps each chart
 * fit to the window.
 *
 * The script signals readiness when the bootstrap completes, and immediately when no chart exists. It sets
 * the `window.__inflexaThemeReady` sentinel and dispatches the `inflexa-theme-ready` event on the document.
 * A reader that captures the page keys on this signal, thus the capture returns when the page is ready and
 * not at a timeout. The sentinel guards a listener that registers after the dispatch, thus a late listener
 * still resolves.
 *
 * The signal passes through the reveal gate of the fade-in script. Thus the signal comes after the first
 * reveal pass, and a capture reads a settled page instead of a page in the middle of a transition.
 *
 * Each chart initializes inside a guard. One malformed option is exactly the fault that a look must
 * diagnose, thus it must never stop a sibling chart and it must never withhold the readiness signal.
 */
export const CHART_BOOTSTRAP = `(function () {
  function signalReady() {
    window.${THEME_READY_SENTINEL} = true;
    document.dispatchEvent(new Event(${JSON.stringify(THEME_READY_EVENT)}));
  }
  function whenRevealed(done) {
    var gate = window.${REVEAL_GATE};
    if (typeof gate === "function") {
      gate(done);
      return;
    }
    done();
  }
  if (typeof echarts === "undefined") {
    whenRevealed(signalReady);
    return;
  }
  var containers = document.querySelectorAll("[data-echarts-id]");
  for (var i = 0; i < containers.length; i++) {
    var container = containers[i];
    var optionScript = container.nextElementSibling;
    if (!optionScript || optionScript.getAttribute("type") !== "application/json") {
      continue;
    }
    try {
      var option = JSON.parse(optionScript.textContent || "{}");
      var chart = echarts.init(container, ${JSON.stringify(ECHARTS_THEME_NAME)});
      chart.setOption(option);
    } catch (cause) {
      console.error("chart bootstrap failed for " + (container.getAttribute("data-echarts-id") || "(no id)") + ": " + (cause && cause.message ? cause.message : cause));
    }
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
  whenRevealed(signalReady);
})();`;

/**
 * The page-side script that reveals each `fade-in` element as it enters the viewport. The `data-delay`
 * attribute holds a stagger in milliseconds, and the observer releases each element one time.
 *
 * The threshold is zero, thus one visible pixel reveals an element. A band is a whole top-level section,
 * and a tall band can never cover a fraction of the viewport. A threshold above zero leaves such a band at
 * zero opacity for the whole life of the page.
 *
 * The first callback of the observer is the first reveal pass. It reveals what the viewport already holds,
 * and it drops the transition for that reveal with the `fade-in-instant` class. Thus the page settles in
 * one frame. An element that arrives later keeps the transition and the stagger.
 *
 * The script installs the reveal gate on the window object before it observes anything. The chart bootstrap
 * runs after this script and it signals readiness through that gate. Thus the readiness signal always comes
 * after the first reveal pass. A page with no `fade-in` element, and a browser with no
 * `IntersectionObserver`, opens the gate at once.
 *
 * A browser with no `IntersectionObserver` reveals every element at once. Thus the content is visible in
 * each browser, and the reveal is decoration alone. The print rules and the reduced-motion rules show every
 * element without this script.
 */
export const FADE_IN_OBSERVER = `(function () {
  var waiting = [];
  var settled = false;
  function settle() {
    if (settled) {
      return;
    }
    settled = true;
    for (var w = 0; w < waiting.length; w++) {
      waiting[w]();
    }
    waiting = [];
  }
  window.${REVEAL_GATE} = function (done) {
    if (settled) {
      done();
      return;
    }
    waiting.push(done);
  };
  function reveal(node) {
    node.classList.add("fade-in-visible");
  }
  function revealSettled(node) {
    node.classList.add("fade-in-instant");
    node.classList.add("fade-in-visible");
  }
  function start() {
    var nodes = document.querySelectorAll(".fade-in");
    if (typeof IntersectionObserver === "undefined" || nodes.length === 0) {
      for (var i = 0; i < nodes.length; i++) {
        revealSettled(nodes[i]);
      }
      settle();
      return;
    }
    var firstPass = true;
    var observer = new IntersectionObserver(function (entries) {
      var instant = firstPass;
      firstPass = false;
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (!entry.isIntersecting) {
          continue;
        }
        var target = entry.target;
        observer.unobserve(target);
        if (instant) {
          revealSettled(target);
          continue;
        }
        var delay = parseInt(target.getAttribute("data-delay") || "0", 10) || 0;
        setTimeout(reveal.bind(null, target), delay);
      }
      if (instant) {
        settle();
      }
    }, { threshold: 0 });
    for (var k = 0; k < nodes.length; k++) {
      observer.observe(nodes[k]);
    }
    setTimeout(settle, ${REVEAL_SETTLE_TIMEOUT_MS});
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`;

/**
 * The page-side script that marks the navigation link of the section in view.
 *
 * Each navigation anchor targets one top-level section by its id. The script resolves each anchor to its
 * section, and an `IntersectionObserver` over those sections drives the active class. The observation box
 * covers the top band of the viewport alone, thus the script marks the first section of that band in
 * document order and exactly one link carries the class.
 *
 * A section that no anchor targets, and an anchor whose target is absent, drop out of the walk. Thus the
 * reference band never takes the mark.
 *
 * The highlight is decoration. A browser with no `IntersectionObserver`, and a page with no navigation,
 * keep the plain links. The script writes one class and it reads nothing that the reveal script writes,
 * thus the two observers never contend.
 */
export const SECTION_SPY = `(function () {
  function start() {
    var links = document.querySelectorAll(".report-nav-link");
    if (typeof IntersectionObserver === "undefined" || links.length === 0) {
      return;
    }
    var anchors = [];
    var sections = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var section = href.charAt(0) === "#" ? document.getElementById(href.slice(1)) : null;
      if (!section) {
        continue;
      }
      anchors.push(links[i]);
      sections.push(section);
    }
    if (sections.length === 0) {
      return;
    }
    var inBand = [];
    for (var s = 0; s < sections.length; s++) {
      inBand.push(false);
    }
    function paint() {
      var active = -1;
      for (var a = 0; a < inBand.length; a++) {
        if (inBand[a]) {
          active = a;
          break;
        }
      }
      for (var b = 0; b < anchors.length; b++) {
        if (b === active) {
          anchors[b].classList.add(${JSON.stringify(NAV_ACTIVE_CLASS)});
        } else {
          anchors[b].classList.remove(${JSON.stringify(NAV_ACTIVE_CLASS)});
        }
      }
    }
    var observer = new IntersectionObserver(function (entries) {
      for (var e = 0; e < entries.length; e++) {
        var index = sections.indexOf(entries[e].target);
        if (index >= 0) {
          inBand[index] = entries[e].isIntersecting === true;
        }
      }
      paint();
    }, { rootMargin: "0px 0px -${SPY_BOTTOM_MARGIN_PERCENT}% 0px", threshold: 0 });
    for (var k = 0; k < sections.length; k++) {
      observer.observe(sections[k]);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`;
