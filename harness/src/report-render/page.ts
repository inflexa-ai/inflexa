/**
 * The page constants: the head references, the readiness names, and the four page-side scripts.
 *
 * A script here is browser source text, not module code. Thus it reads no module binding, and each value
 * that it needs is interpolated at build time. The style rules and the ECharts theme live in `design.ts`.
 */

import { assetSource, ECHARTS_ASSET } from "./assets.js";
import { ECHARTS_THEME_NAME } from "./design.js";
import { TABLE_DATA_GLOBAL } from "./table-data.js";
import { SHOW_ALL_PREFIX, TABLE_ROW_CAP } from "./views/values.js";

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
 * The class that hides one table row, and the two classes that mark the sorted header.
 *
 * The table view emits the hidden class on each row past the cap, and the enhancer below writes the same
 * class as the filter and the toggle change what shows. The design sheet holds the matching rule of each of
 * the three names.
 */
const ROW_HIDDEN_CLASS = "report-row-hidden";
const SORT_ASCENDING_CLASS = "data-table-sort-asc";
const SORT_DESCENDING_CLASS = "data-table-sort-desc";

/**
 * The marker class of a card that the enhancer took.
 *
 * The rule that hides a row takes effect under this marker alone. The script writes the marker when it binds
 * a card, thus a browser with no script shows the complete plain table and no row hides behind a toggle that
 * cannot open.
 */
const TABLE_LIVE_CLASS = "report-table-live";

/**
 * The class that hides the toggle of the row cap.
 *
 * A filter that keeps the cap or less leaves no row behind the toggle. The script writes this class at that
 * time, thus the reader sees a control only while the control does something.
 */
const TOGGLE_HIDDEN_CLASS = "report-table-toggle-off";

/**
 * The label of the toggle while every row that the filter keeps shows.
 *
 * The view composes the collapsed label, because the view holds the total row count. Thus the enhancer keeps
 * the label that it finds and it restores that text, and the two sites cannot disagree over the count.
 */
const SHOW_FEWER_LABEL = "Show fewer";

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
 * A page can leave the observation box empty. At scroll 0, each section can start below the box. A short
 * tail also holds the last section below the box for the whole scroll. Thus the paint step has a fallback.
 * The fallback marks the last section whose top sits at the end of the box or above it. It marks the first
 * section when every top sits below the box.
 *
 * The fallback reads each position with `getBoundingClientRect` at paint time. A scroll moves each section,
 * thus a cached position names the wrong link. As a result, exactly one link carries the active class on a
 * page that has a section.
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
    function boxEnd() {
      var root = document.documentElement;
      var height = root ? root.clientHeight : 0;
      return (height * (100 - ${SPY_BOTTOM_MARGIN_PERCENT})) / 100;
    }
    function nearestAbove() {
      var end = boxEnd();
      var last = -1;
      for (var n = 0; n < sections.length; n++) {
        if (sections[n].getBoundingClientRect().top <= end) {
          last = n;
        }
      }
      return last < 0 ? 0 : last;
    }
    function paint() {
      var active = -1;
      for (var a = 0; a < inBand.length; a++) {
        if (inBand[a]) {
          active = a;
          break;
        }
      }
      if (active < 0) {
        active = nearestAbove();
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

/**
 * The page-side script that gives each table its sort, its filter, and its row cap.
 *
 * The enhancer is presentation over a complete DOM. Every resolved row is already in the markup, thus the
 * script moves a row and hides a row, and it never adds one and never removes one.
 *
 * The script marks each card that it takes. The rule that hides a row reads that marker, thus a browser with
 * no script keeps the plain table with every row, and the cap costs the reader nothing there.
 *
 * A click on a header cycles the column: ascending, then descending, then the document order. The Enter key
 * and the Space key give the same cycle, thus a reader sorts from the keyboard. The script records the
 * initial index of each row at start, thus the document order is always recoverable.
 *
 * The sort reads the `data-value` attribute of a cell, thus a rounded number still orders by its full
 * magnitude. A column sorts numerically when one non-empty value of it parses as a number, thus a sentinel
 * such as `NA` cannot drop the column to text order and rank `10` before `9`. A value that holds no rank,
 * which is an empty cell and a cell that the numeric column cannot parse, stays at the end under both
 * directions. Two equal cells keep the document order, thus one sort gives one order and not the order of
 * the engine.
 *
 * The filter reads the `data-value` attributes of a row, and never the shown text. Thus a reader finds the
 * accession that the trim hides, and a match cannot form across two cells. The comparison lowercases both
 * texts with `toLowerCase`. That method reads no locale, and it is exact over the ASCII range of a gene name
 * and an accession.
 *
 * The cap composes with both. After each change the first rows that the filter keeps show, up to the cap,
 * and the rest hide. The toggle opens the table, and each row that the filter keeps then shows. The label of
 * the toggle flips between the collapsed label and the label above, and the collapsed label counts the rows
 * that the filter keeps. A filter that keeps the cap or less hides the toggle, because nothing then waits
 * behind it.
 *
 * The script registers no reveal work. It touches neither the reveal gate nor the readiness sentinel, thus a
 * capture of the page still signals at the same point.
 */
export const TABLE_ENHANCER = `(function () {
  var CAP = ${TABLE_ROW_CAP};
  var HIDDEN = ${JSON.stringify(ROW_HIDDEN_CLASS)};
  var ASCENDING = ${JSON.stringify(SORT_ASCENDING_CLASS)};
  var DESCENDING = ${JSON.stringify(SORT_DESCENDING_CLASS)};
  var LIVE = ${JSON.stringify(TABLE_LIVE_CLASS)};
  var TOGGLE_OFF = ${JSON.stringify(TOGGLE_HIDDEN_CLASS)};
  var FEWER = ${JSON.stringify(SHOW_FEWER_LABEL)};
  var ALL = ${JSON.stringify(SHOW_ALL_PREFIX)};
  function rawValue(row, index) {
    var cell = row.cells[index];
    return cell ? cell.getAttribute("data-value") || "" : "";
  }
  function rowValues(row) {
    var joined = "";
    for (var c = 0; c < row.cells.length; c++) {
      joined += (row.cells[c].getAttribute("data-value") || "") + "\\n";
    }
    return joined.toLowerCase();
  }
  function numericColumn(rows, index) {
    for (var i = 0; i < rows.length; i++) {
      var value = rawValue(rows[i], index);
      if (value !== "" && !isNaN(Number(value))) {
        return true;
      }
    }
    return false;
  }
  function rankless(value, numeric) {
    return value === "" || (numeric && isNaN(Number(value)));
  }
  function enhance(card) {
    var table = card.querySelector("table.data-table");
    var body = table ? table.querySelector("tbody") : null;
    if (!body || body.rows.length === 0) {
      return;
    }
    var rows = [];
    var order = [];
    var values = [];
    for (var r = 0; r < body.rows.length; r++) {
      rows.push(body.rows[r]);
      order.push(r);
      values.push(rowValues(body.rows[r]));
    }
    var headers = table.querySelectorAll("th[data-sort-index]");
    var filter = card.querySelector(".report-table-filter");
    var toggle = card.querySelector(".report-table-toggle");
    var query = "";
    var open = false;
    var sorted = null;
    var descending = false;
    function paint() {
      var kept = 0;
      for (var i = 0; i < order.length; i++) {
        var index = order[i];
        var row = rows[index];
        if (query !== "" && values[index].indexOf(query) < 0) {
          row.classList.add(HIDDEN);
          continue;
        }
        kept += 1;
        if (open || kept <= CAP) {
          row.classList.remove(HIDDEN);
        } else {
          row.classList.add(HIDDEN);
        }
      }
      if (toggle) {
        toggle.textContent = open ? FEWER : ALL + kept;
        if (kept > CAP) {
          toggle.classList.remove(TOGGLE_OFF);
        } else {
          toggle.classList.add(TOGGLE_OFF);
        }
      }
      for (var h = 0; h < headers.length; h++) {
        headers[h].classList.remove(ASCENDING);
        headers[h].classList.remove(DESCENDING);
        headers[h].setAttribute("aria-sort", "none");
      }
      if (sorted) {
        sorted.classList.add(descending ? DESCENDING : ASCENDING);
        sorted.setAttribute("aria-sort", descending ? "descending" : "ascending");
      }
    }
    function place() {
      for (var p = 0; p < order.length; p++) {
        body.appendChild(rows[order[p]]);
      }
    }
    function sort(index) {
      var numeric = numericColumn(rows, index);
      var direction = descending ? -1 : 1;
      order.sort(function (left, right) {
        var a = rawValue(rows[left], index);
        var b = rawValue(rows[right], index);
        var aOut = rankless(a, numeric);
        var bOut = rankless(b, numeric);
        if (aOut || bOut) {
          return aOut === bOut ? left - right : aOut ? 1 : -1;
        }
        var rank = numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;
        return rank === 0 ? left - right : rank * direction;
      });
      place();
    }
    function reset() {
      order.sort(function (left, right) {
        return left - right;
      });
      place();
    }
    function cycle(header, index) {
      if (sorted !== header) {
        sorted = header;
        descending = false;
        sort(index);
      } else if (!descending) {
        descending = true;
        sort(index);
      } else {
        sorted = null;
        descending = false;
        reset();
      }
      paint();
    }
    function bind(header, index) {
      header.addEventListener("click", function () {
        cycle(header, index);
      });
      header.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        // The Space key scrolls the page by default. The header takes the key instead, thus the keyboard
        // gives the same cycle as the pointer.
        event.preventDefault();
        cycle(header, index);
      });
    }
    for (var k = 0; k < headers.length; k++) {
      bind(headers[k], parseInt(headers[k].getAttribute("data-sort-index") || "0", 10) || 0);
    }
    if (filter) {
      filter.addEventListener("input", function () {
        query = (filter.value || "").toLowerCase();
        paint();
      });
    }
    if (toggle) {
      toggle.addEventListener("click", function () {
        open = !open;
        paint();
      });
    }
    card.classList.add(LIVE);
  }
  function start() {
    if (!document.querySelectorAll || typeof document.documentElement.classList === "undefined") {
      return;
    }
    var cards = document.querySelectorAll(".report-table");
    for (var c = 0; c < cards.length; c++) {
      enhance(cards[c]);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`;

/**
 * The decoder of the table data assets.
 *
 * Each data asset registers its payload under the global map, keyed by the block id. The payload is
 * columnar: a row is an array in column order, and a number in a column that carries a dictionary is the
 * index of its value. This script materializes the decoded rows one time, thus a reader of the data takes
 * plain row objects and no reader repeats the decode.
 *
 * The decoded rows land on the payload itself, under `rows`. The encoded arrays stay under `encoded`, thus
 * the decode runs one time even when the script runs again. A cell of `null` names a column that the row
 * does not hold, and the decoded row omits that key. Thus a ragged row stays ragged and no key reads as an
 * empty value.
 *
 * The script runs after the data assets and before the page scripts. A page with no table registers no
 * map, and the guard leaves such a page untouched.
 */
export const TABLE_DATA_DECODER = `(function () {
  var registry = window.${TABLE_DATA_GLOBAL};
  if (!registry) {
    return;
  }
  var ids = Object.keys(registry);
  for (var i = 0; i < ids.length; i++) {
    var payload = registry[ids[i]];
    if (!payload || payload.encoded) {
      continue;
    }
    var columns = payload.columns || [];
    var dict = payload.dict || {};
    var encoded = payload.rows || [];
    var decoded = [];
    for (var r = 0; r < encoded.length; r++) {
      var row = encoded[r];
      var record = {};
      for (var c = 0; c < columns.length; c++) {
        var cell = row[c];
        if (cell === null || cell === undefined) {
          continue;
        }
        var values = dict[columns[c]];
        record[columns[c]] = values && typeof cell === "number" ? values[cell] : cell;
      }
      decoded.push(record);
    }
    payload.encoded = encoded;
    payload.rows = decoded;
  }
})();`;
