/**
 * The page constants: the head references, the readiness names, and the page-side scripts.
 *
 * A script here is browser source text, not module code. Thus it reads no module binding, and each value
 * that it needs is interpolated at build time. The style rules, the ECharts theme, and the grid theme
 * parameters live in `design.ts`.
 */

import { AG_GRID_ASSET, assetSource, ECHARTS_ASSET, TSPROV_ASSET } from "./assets.js";
import { CHART_SOURCE_MEMBER, POINT_LABEL } from "./chart.js";
import {
    ECHARTS_THEME_NAME,
    GRID_HEADER_BORDER_PX,
    GRID_HEADER_HEIGHT_PX,
    GRID_MIN_COLUMN_WIDTH_PX,
    GRID_PRINT_ROW_CAP,
    GRID_ROW_HEIGHT_PX,
    GRID_THEME_PARAMS,
    GRID_TOOLTIP_DELAY_MS,
    GRID_VISIBLE_ROWS,
} from "./design.js";
import { REPORT_PROVENANCE_GLOBAL } from "./provenance-data.js";
import { scriptJson } from "./script-json.js";
import { TABLE_DATA_GLOBAL } from "./table-data.js";
import { LINEAGE_BLOCK_ATTRIBUTE, LINEAGE_CONTROL_CLASS, LINEAGE_KEY_ATTRIBUTE, LINEAGE_KEYS_ATTRIBUTE } from "./views/lineage.js";
import { CHAIN_HASH_CHARS } from "./views/references-view.js";
import { GRID_COUNT_CLASS, GRID_MOUNT_ATTRIBUTE, GRID_NOTE_CLASS, GRID_ROWS_WORD } from "./views/values.js";

/**
 * The head reference of the chart runtime. The page loads it from the sibling assets directory, thus the
 * head names no remote host. The manifest gives the staged name, thus the tag and the stage step of the
 * caller cannot disagree.
 *
 * The tag is a classic script. A `file://` page refuses a module request, thus a classic script is the one
 * form that loads beside the page.
 */
export const ASSET_HEAD = `<script src="${assetSource(ECHARTS_ASSET)}"></script>`;

/**
 * The head reference of the grid runtime.
 *
 * The bundle weighs about two megabytes, and a page with no table has nothing to build. Thus the skeleton
 * writes this tag only for a page that carries table data, and the manifest still stages the file for the
 * whole directory.
 */
export const GRID_ASSET_HEAD = `<script src="${assetSource(AG_GRID_ASSET)}"></script>`;

/**
 * The head reference of the provenance library.
 *
 * The library walks the chain of one pin, and a page with no provenance document holds no pin to walk.
 * Thus the skeleton writes this tag only for a page that carries the document, and the manifest still
 * stages the file for the whole directory.
 */
export const LINEAGE_ASSET_HEAD = `<script src="${assetSource(TSPROV_ASSET)}"></script>`;

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
 * The client twin of the chart data derivation, as browser source text.
 *
 * A dense chart ships no row. Its option states, for each series, the columns of the payload that it reads,
 * the transform of each column, the split that it holds, and the rows that carry a point label. This
 * fragment reads those descriptors and builds the data of each series.
 *
 * The fragment writes its own constants, because a page script reads no module binding. Each rule here is
 * the twin of one rule of the server derivation: the number read of a cell, the four transforms, the
 * competition rank, the compare of a sort, and the three-way classification of a preset. A shared test
 * vector runs the transforms of both sides over one set of cells, thus the two cannot drift in silence.
 *
 * The build reads the decoded rows of the payload. The decoder runs before this script, thus a row is a
 * record and a cell reads by its column name.
 */
export const CHART_SERIES_BUILDER = `function reportNumber(cell) {
  if (typeof cell === "number") {
    return isFinite(cell) ? cell : null;
  }
  if (typeof cell === "string") {
    var trimmed = cell.trim();
    if (trimmed === "") {
      return null;
    }
    var parsed = Number(trimmed);
    return isFinite(parsed) ? parsed : null;
  }
  return null;
}
function reportRank(values) {
  var counts = Object.create(null);
  var distinct = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i] === null) {
      continue;
    }
    var key = String(values[i]);
    if (counts[key] === undefined) {
      counts[key] = 0;
      distinct.push(values[i]);
    }
    counts[key] += 1;
  }
  distinct.sort(function (a, b) {
    return a - b;
  });
  var places = Object.create(null);
  var place = 1;
  for (var d = 0; d < distinct.length; d++) {
    places[String(distinct[d])] = place;
    place += counts[String(distinct[d])];
  }
  var ranked = [];
  for (var r = 0; r < values.length; r++) {
    ranked.push(values[r] === null ? null : places[String(values[r])]);
  }
  return ranked;
}
function reportTransform(cells, name) {
  var values = [];
  for (var i = 0; i < cells.length; i++) {
    values.push(reportNumber(cells[i]));
  }
  if (name === "rank") {
    return reportRank(values);
  }
  var out = [];
  for (var j = 0; j < values.length; j++) {
    var value = values[j];
    if (value === null) {
      out.push(null);
    } else if (name === "log10") {
      out.push(value > 0 ? Math.log10(value) : null);
    } else if (name === "neg_log10") {
      out.push(value > 0 ? -Math.log10(value) : null);
    } else {
      out.push(Math.abs(value));
    }
  }
  return out;
}
function reportColumn(payload, index) {
  var name = payload.columns[index];
  var rows = payload.rows || [];
  var cells = [];
  for (var i = 0; i < rows.length; i++) {
    var cell = rows[i][name];
    cells.push(cell === undefined ? null : cell);
  }
  return cells;
}
function reportChannel(payload, spec) {
  var cells = reportColumn(payload, spec.column);
  return spec.transform === undefined ? cells : reportTransform(cells, spec.transform);
}
function reportCompare(a, b) {
  var left = reportNumber(a);
  var right = reportNumber(b);
  if (left !== null && right !== null) {
    return left - right;
  }
  var x = String(a);
  var y = String(b);
  if (x < y) {
    return -1;
  }
  return x > y ? 1 : 0;
}
function reportCategory(rule, xValue, yValue) {
  // The rule gives the place of the category, and the descriptor of a series names the same place. Thus
  // the two sides compare numbers and no category name rides the page.
  var x = reportNumber(xValue);
  var y = reportNumber(yValue);
  if (!rule || x === null || y === null) {
    return -1;
  }
  if (y <= rule.cut) {
    return 2;
  }
  if (x < -rule.effect) {
    return 0;
  }
  return x > rule.effect ? 1 : 2;
}
function reportSeriesData(payload, source, rule) {
  var x = reportChannel(payload, source.x);
  var y = reportChannel(payload, source.y);
  var group = source.group === undefined ? null : reportChannel(payload, source.group);
  var labels = source.label === undefined ? null : reportColumn(payload, source.label);
  var flags = Object.create(null);
  var declared = source.flags || [];
  for (var f = 0; f < declared.length; f++) {
    flags[declared[f]] = true;
  }
  var points = [];
  for (var r = 0; r < x.length; r++) {
    if (x[r] === null || y[r] === null) {
      continue;
    }
    if (group !== null && group[r] !== source.value) {
      continue;
    }
    if (source.category !== undefined && reportCategory(rule, x[r], y[r]) !== source.category) {
      continue;
    }
    points.push({ index: r, x: x[r], y: y[r] });
  }
  if (source.sort) {
    points.sort(function (a, b) {
      return reportCompare(a.x, b.x);
    });
  }
  var data = [];
  for (var p = 0; p < points.length; p++) {
    var point = points[p];
    var pair = source.swap ? [point.y, point.x] : [point.x, point.y];
    var label = labels === null ? null : labels[point.index];
    var named = label !== null && label !== undefined;
    if (!named && flags[point.index] !== true) {
      data.push(pair);
      continue;
    }
    var item = { value: pair, name: named ? String(label) : String(point.x) };
    if (flags[point.index] === true) {
      item.label = ${JSON.stringify(POINT_LABEL)};
    }
    data.push(item);
  }
  return data;
}`;

/**
 * The page-side script that wires each chart. It finds every chart container, reads the option JSON from
 * the sibling `<script type="application/json">` element, and initializes ECharts with the registered
 * theme. The skeleton registers the theme before this script runs. A resize handler keeps each chart
 * fit to the window.
 *
 * An option that carries the data-source member holds no row. The script then reads the registered payload
 * of the artifact and builds the data of each series from the descriptors. A mount whose payload the
 * registry does not hold keeps its empty card, and the walk continues.
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
  ${CHART_SERIES_BUILDER}
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
  var registry = window.${TABLE_DATA_GLOBAL};
  var containers = document.querySelectorAll("[data-echarts-id]");
  for (var i = 0; i < containers.length; i++) {
    var container = containers[i];
    var optionScript = container.nextElementSibling;
    if (!optionScript || optionScript.getAttribute("type") !== "application/json") {
      continue;
    }
    try {
      var option = JSON.parse(optionScript.textContent || "{}");
      var source = option.${CHART_SOURCE_MEMBER};
      if (source) {
        // The member is no field of the chart runtime, thus it leaves the option before the runtime reads it.
        delete option.${CHART_SOURCE_MEMBER};
        var payload = registry && Object.prototype.hasOwnProperty.call(registry, source.payload) ? registry[source.payload] : null;
        if (!payload || !payload.columns) {
          continue;
        }
        var series = option.series || [];
        for (var s = 0; s < series.length && s < source.series.length; s++) {
          series[s].data = reportSeriesData(payload, source.series[s], source.rule);
        }
      }
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
      // A column name is authored text. A plain object would read an inherited member such as
      // "constructor" as a dictionary, and it would send a "__proto__" column to the prototype. The
      // null-prototype record and the own-key test keep every column name an ordinary entry.
      var record = Object.create(null);
      for (var c = 0; c < columns.length; c++) {
        var cell = row[c];
        if (cell === null || cell === undefined) {
          continue;
        }
        var name = columns[c];
        var values = Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : null;
        record[name] = values && typeof cell === "number" ? values[cell] : cell;
      }
      decoded.push(record);
    }
    payload.encoded = encoded;
    payload.rows = decoded;
  }
})();`;

/**
 * The client twin of `formatTableCell`, as browser source text.
 *
 * The rows of a table reach the reader through the data asset, thus the page formats each cell. The server
 * ships the kind of each column, and this fragment reads the cell under that kind: the identifier text, the
 * bound of a stored zero, the exponent of a small probability, the grouped whole number, the rounded float,
 * the typographic minus of a negative, and the trim of a delimited name.
 *
 * The fragment writes its own constants, because a page script reads no module binding. A shared test vector
 * runs the server helper and this twin over the same entries, thus the two cannot give different text in
 * silence. `formatCell` is the one entry point, and the grid boot below inlines the whole fragment.
 */
export const TABLE_CELL_FORMATTER = `function formatCell(cell, kind, bound) {
  var text = cellText(cell, kind, bound);
  var segments = text.split("%");
  if (segments.length < 3) {
    return text;
  }
  for (var s = 0; s < segments.length; s++) {
    if (segments[s].length === 0 || /\\s/.test(segments[s])) {
      return text;
    }
  }
  return segments[0];
}
function cellText(cell, kind, bound) {
  if (kind === "identifier") {
    return String(cell).trim();
  }
  var value = finiteValue(cell);
  if (value === null) {
    return String(cell);
  }
  return shownMinus(numberText(value, kind, bound));
}
function shownMinus(text) {
  // The leading character alone. An exponent keeps its own hyphen, thus one form reads one notation.
  return text.charAt(0) === "-" ? "−" + text.slice(1) : text;
}
function numberText(value, kind, bound) {
  if (kind === "scientific") {
    if (value === 0) {
      return bound !== undefined && bound !== null && bound > 0 ? "<" + boundForm(bound) : "≈" + "0";
    }
    if (value > 0 && value < 1e-2) {
      return scientificForm(value);
    }
  }
  if (Number.isSafeInteger(value)) {
    return compactForm(value);
  }
  var magnitude = Math.abs(value);
  if (value !== 0 && magnitude < 1e-3) {
    return scientificForm(value);
  }
  var rounded = Math.round(magnitude);
  if (rounded >= 1e3 && rounded < 1e15) {
    return compactForm(value);
  }
  return tidy(value.toPrecision(3));
}
function finiteValue(cell) {
  if (typeof cell === "number") {
    return isFinite(cell) ? cell : null;
  }
  var trimmed = String(cell).trim();
  if (trimmed === "") {
    return null;
  }
  var parsed = Number(trimmed);
  return isFinite(parsed) ? parsed : null;
}
function boundForm(bound) {
  var parts = bound.toExponential().split("e");
  var digits = parts[0].replace(".", "");
  var raised = Number(digits.charAt(0)) + (digits.length > 1 ? 1 : 0);
  var carries = raised === 10;
  var digit = carries ? 1 : raised;
  var power = Number(parts[1]) + (carries ? 1 : 0);
  if (power < -2) {
    return digit + "e" + power;
  }
  return power >= 0 ? String(digit) + zeros(power) : "0." + zeros(-power - 1) + digit;
}
function zeros(count) {
  var text = "";
  for (var z = 0; z < count; z++) {
    text += "0";
  }
  return text;
}
function scientificForm(value) {
  return tidy(value.toExponential(1));
}
function compactForm(value) {
  return (value < 0 ? "-" : "") + groupDigits(Math.abs(value).toFixed(0));
}
function groupDigits(digits) {
  if (!/^[0-9]+$/.test(digits)) {
    return digits;
  }
  var grouped = "";
  for (var d = 0; d < digits.length; d++) {
    if (d > 0 && (digits.length - d) % 3 === 0) {
      grouped += ",";
    }
    grouped += digits.charAt(d);
  }
  return grouped;
}
function tidy(text) {
  var marker = text.indexOf("e");
  if (marker < 0) {
    return trimZeros(text);
  }
  return trimZeros(text.slice(0, marker)) + "e" + text.slice(marker + 1).replace("+", "");
}
function trimZeros(text) {
  if (text.indexOf(".") < 0) {
    return text;
  }
  var end = text.length;
  while (end > 0 && text.charAt(end - 1) === "0") {
    end -= 1;
  }
  if (text.charAt(end - 1) === ".") {
    end -= 1;
  }
  return text.slice(0, end);
}`;

/**
 * The page-side script that builds one grid for each table block.
 *
 * The script walks the grid mounts. Each mount names its block, and the registry holds the decoded rows and
 * the column display of that block. Thus the boot reads what the server resolved, and it resolves nothing
 * again. A mount whose block the registry does not hold keeps its empty card, and the walk continues.
 *
 * The column definition takes the label, the filter, and the two readings of a cell. The formatter gives the
 * shown text under the kind of the column, and the tooltip gives the raw cell where the shown text differs
 * from it. A value getter reads the own key of the row, because the field of a column reads a point as a
 * path and a column name can hold one. A number column also parses the cell for its filter, thus a column
 * of numeric text compares as a number and a sentinel matches nothing.
 *
 * The row model is the client-side model. It renders the visible slice alone, thus a table of many thousands
 * of rows costs the DOM a screen of rows. The mount takes the height of its rows, up to the visible count,
 * thus a short table leaves no empty box under it. A wide table adds the horizontal scroll bar that the
 * host paints, measured at the first data render, thus the bar covers no row.
 *
 * The status of the card reads the model of the grid. The grid gives a model event after each filter and
 * each sort, thus the count states what the reader sees against what the table holds.
 *
 * The print hooks switch the grid to its print layout. That layout lays every row out at once and it holds
 * no scroll viewport, thus each row of the print form reaches the paper. The print stops at the print bound,
 * and the note of the card then states what the paper shows and where the whole table is.
 *
 * One grid builds inside a guard. A malformed payload is exactly the fault that a look must diagnose, thus
 * it must never stop a sibling grid and it must never throw out of the page.
 */
export const GRID_BOOTSTRAP = `(function () {
  ${TABLE_CELL_FORMATTER}
  var registry = window.${TABLE_DATA_GLOBAL};
  var mounts = document.querySelectorAll("[${GRID_MOUNT_ATTRIBUTE}]");
  if (!registry || typeof agGrid === "undefined" || mounts.length === 0) {
    return;
  }
  if (agGrid.ModuleRegistry && agGrid.AllCommunityModule) {
    agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);
  }
  var theme = agGrid.themeQuartz.withParams(${scriptJson(GRID_THEME_PARAMS)});
  function columnOf(name, display) {
    var kind = display.kind;
    var bound = display.bound;
    var label = display.label || name;
    var column = {
      colId: name,
      headerName: label,
      valueGetter: function (params) {
        return params.data ? params.data[name] : undefined;
      },
      valueFormatter: function (params) {
        return params.value === undefined || params.value === null ? "" : formatCell(params.value, kind, bound);
      },
      tooltipValueGetter: function (params) {
        if (params.value === undefined || params.value === null) {
          return "";
        }
        var raw = String(params.value);
        return raw === formatCell(params.value, kind, bound) ? "" : raw;
      },
      filter: display.filter === "number" ? "agNumberColumnFilter" : "agTextColumnFilter"
    };
    if (display.filter === "number") {
      // The number filter compares numbers. A cell of numeric text would compare as text under it, thus the
      // filter reads the parsed value and a cell that parses to nothing matches no comparison.
      column.filterValueGetter = function (params) {
        var cell = params.data ? params.data[name] : undefined;
        var parsed = cell === undefined || cell === null || cell === "" ? NaN : Number(cell);
        return isFinite(parsed) ? parsed : null;
      };
    }
    if (label !== name) {
      column.headerTooltip = name;
    }
    return column;
  }
  function scrollBarHeight(mount) {
    // The grid lays its horizontal bar in a strip of its own under the rows, and that strip takes its space
    // from the box of the mount. Thus the height of the strip is what the last row loses, and an overlay bar
    // leaves the strip at zero. A grid that names the strip differently gives none, and the box then holds
    // the rows alone.
    var strip = mount.querySelector(".ag-body-horizontal-scroll");
    return strip ? strip.offsetHeight : 0;
  }
  function fitToScrollBar(mount, rowSpace) {
    var height = rowSpace + scrollBarHeight(mount) + "px";
    if (mount.style.height !== height) {
      mount.style.height = height;
    }
  }
  function onFirstRender(mount, rowSpace) {
    // The grid lays its columns out with the first data render. A measure before that render finds no
    // viewport and no bar, thus the fit waits for the grid to say that the rows are on the page.
    return function () {
      fitToScrollBar(mount, rowSpace);
    };
  }
  function statusText(shown, total) {
    var whole = formatCell(total, "compact-scientific") + " ${GRID_ROWS_WORD}";
    return shown === total ? whole : formatCell(shown, "compact-scientific") + " of " + whole;
  }
  function onModelUpdate(count, total) {
    // The grid gives this event after each filter and each sort, thus the status states what the reader
    // sees against what the table holds.
    return function (params) {
      if (count) {
        count.textContent = statusText(params.api.getDisplayedRowCount(), total);
      }
    };
  }
  function printNote(total) {
    return (
      "The print shows the first " +
      formatCell(${GRID_PRINT_ROW_CAP}, "compact-scientific") +
      " of " +
      formatCell(total, "compact-scientific") +
      " ${GRID_ROWS_WORD}. The full table rides the download."
    );
  }
  function bindPrint(api, mount, note, rows) {
    var capped = rows.length > ${GRID_PRINT_ROW_CAP};
    var height = "";
    window.addEventListener("beforeprint", function () {
      // The height of the screen form is whatever the fit left, thus the restore reads it at print time.
      height = mount.style.height;
      mount.style.height = "auto";
      if (capped) {
        api.setGridOption("rowData", rows.slice(0, ${GRID_PRINT_ROW_CAP}));
        if (note) {
          note.textContent = printNote(rows.length);
        }
      }
      api.setGridOption("domLayout", "print");
    });
    window.addEventListener("afterprint", function () {
      api.setGridOption("domLayout", "normal");
      if (capped) {
        api.setGridOption("rowData", rows);
        if (note) {
          note.textContent = "";
        }
      }
      mount.style.height = height;
    });
  }
  for (var i = 0; i < mounts.length; i++) {
    var mount = mounts[i];
    var id = mount.getAttribute("${GRID_MOUNT_ATTRIBUTE}") || "";
    var payload = Object.prototype.hasOwnProperty.call(registry, id) ? registry[id] : null;
    if (!payload || !payload.columns || !payload.display) {
      continue;
    }
    var card = mount.parentNode;
    var note = card ? card.querySelector(".${GRID_NOTE_CLASS}") : null;
    var count = card ? card.querySelector(".${GRID_COUNT_CLASS}") : null;
    try {
      var columns = [];
      for (var c = 0; c < payload.columns.length; c++) {
        columns.push(columnOf(payload.columns[c], payload.display[c] || {}));
      }
      var rows = payload.rows || [];
      // The total is the row count of the artifact before a row bound cut it. A payload that carries none
      // states the whole artifact already, thus the row count answers.
      var total = typeof payload.total === "number" ? payload.total : rows.length;
      var shown = rows.length < ${GRID_VISIBLE_ROWS} ? rows.length : ${GRID_VISIBLE_ROWS};
      var rowSpace = ${GRID_HEADER_HEIGHT_PX + GRID_HEADER_BORDER_PX} + shown * ${GRID_ROW_HEIGHT_PX};
      mount.style.height = rowSpace + "px";
      var api = agGrid.createGrid(mount, {
        theme: theme,
        columnDefs: columns,
        rowData: rows,
        defaultColDef: { sortable: true, resizable: true, flex: 1, minWidth: ${GRID_MIN_COLUMN_WIDTH_PX} },
        suppressCellFocus: true,
        // The tooltip carries the raw value of a shown cell. A reader hovers to read that value, thus the
        // delay is short and the value arrives while the pointer is still on the cell.
        tooltipShowDelay: ${GRID_TOOLTIP_DELAY_MS},
        onFirstDataRendered: onFirstRender(mount, rowSpace),
        onModelUpdated: onModelUpdate(count, total)
      });
      bindPrint(api, mount, note, rows);
    } catch (cause) {
      console.error("grid boot failed for " + id + ": " + (cause && cause.message ? cause.message : cause));
    }
  }
})();`;

/**
 * The name of the provenance library on the page.
 *
 * The browser bundle of the package declares this one global, and the page and the library meet there and
 * nowhere else. The renderer imports no API of the library, thus the two ship apart.
 *
 * A page whose staged libraries were stripped registers no such global. That absence is a normal
 * condition: the popover still opens, and it shows the pin as the last hop under an explicit note.
 */
export const TSPROV_GLOBAL = "tsprov";

/**
 * The attribute names of the dialect that the rail reads.
 *
 * The writer of the document stamps these names, and the popover reads them and nothing else. A file
 * entity carries the path and the hash. A command activity carries the command line, the argument
 * vector, and the path of a script that bound to no bytes. A step activity carries the step id.
 *
 * A command activity carries no step id of its own. It names its step through the `wasInformedBy` edge
 * that the writer stamps beside it, thus the rail reads the step from the activity at the end of that
 * edge and never from the identifier of the command.
 */
const PIN_PATH_ATTRIBUTE = "inflexa:path";
const PIN_HASH_ATTRIBUTE = "inflexa:hash";
const COMMAND_ATTRIBUTE = "inflexa:command";
const COMMAND_ARGS_ATTRIBUTE = "inflexa:args";
const UNRESOLVED_SCRIPT_ATTRIBUTE = "inflexa:unresolvedScript";
const TOOL_ATTRIBUTE = "inflexa:tool";
const STEP_ID_ATTRIBUTE = "inflexa:stepId";

/**
 * The dialect types that name an execution.
 *
 * A command runs a script, and a file tool writes content that an agent authored. Every other activity of
 * the document is bookkeeping: a step, a run, and a lifecycle action. Thus the rail expands these two
 * types alone, and no bookkeeping node becomes a row.
 */
const DIALECT_TYPE_PREFIX = "inflexa:";
const DIALECT_COMMAND_TYPE = "Command";
const DIALECT_FILE_TOOL_TYPE = "FileToolWrite";

/** The heading of the popover. It names what the panel holds, above the rail. */
const LINEAGE_TITLE_TEXT = "Lineage";

/** The note of a page that carries no lineage library. The chain then stops at the pin of the block. */
export const LINEAGE_NO_LIBRARY_NOTE = "The lineage library is not on this page. Thus the chain stops at this pin.";

/** The note of a library call that gave no answer. The pin stays the last hop that the page knows. */
export const LINEAGE_NO_ANSWER_NOTE = "The lineage library gave no answer for this pin. Thus the chain stops here.";

/** The note of a pin that the document holds no node for. */
export const LINEAGE_NO_NODE_NOTE = "The document holds no node for this pin. Thus the chain stops here.";

/** The note of a chain that the library cut at its own depth bound. */
export const LINEAGE_TRUNCATED_NOTE = "The library cut this chain at its depth bound. Thus the chain continues past the last hop.";

/** The note of an external record. A paper is no artifact, thus no data chain reaches it. */
export const LINEAGE_RECORD_NOTE = "An external record has no data chain. Thus this reference ends at the record.";

/**
 * The footer note of a chain that reached the raw data.
 *
 * The signed form states the attestation, and the page carries one only where the source held one. Thus
 * the footer never claims a signature that the page does not hold.
 */
export const LINEAGE_COMPLETE_NOTE = "The chain is complete · each hop is content-addressed";
export const LINEAGE_SIGNED_NOTE = "The chain is complete · each hop is content-addressed · an attestation covers it";

/**
 * The tag of each row form.
 *
 * The pinned row takes a neutral tag and never the kind of its block. One marker of a claim can pin a
 * table that sits in a different section, thus a tag such as "THIS TABLE" would name the wrong element of
 * the page. "PINNED" names the one relation that always holds: the marker pins these bytes.
 *
 * A file takes the raw tag where the rail found no command that made it. That is what ends a branch, thus
 * the tag and the terminal tint state the same fact.
 */
const LINEAGE_PIN_TAG = "PINNED";
const LINEAGE_ARTIFACT_TAG = "ARTIFACT";
const LINEAGE_RAW_TAG = "RAW INPUT";
const LINEAGE_RECORD_TAG = "CITATION";

/** The connector label above a producer row. */
const LINEAGE_MADE_BY_LABEL = "MADE BY";

/** The name of the close control for a reader who hears the page instead of seeing it. */
const LINEAGE_CLOSE_LABEL = "Close the lineage panel";

/** The glyph of the close control. */
const LINEAGE_CLOSE_GLYPH = "✕";

/**
 * The classes of the popover. The script emits each one, and the design sheet holds the matching rule.
 *
 * The rail carries three row forms over one base row: the pinned artifact, a producer, and a raw input.
 * A row that carries no modifier is an artifact that the rail continues past, thus the base rule is the
 * form that the panel shows most.
 */
const LINEAGE_PANEL_CLASS = "report-lineage-popover";
const LINEAGE_HEADER_CLASS = "report-lineage-header";
const LINEAGE_PANEL_TITLE_CLASS = "report-lineage-title";
const LINEAGE_COUNT_CLASS = "report-lineage-count";
const LINEAGE_CLOSE_CLASS = "report-lineage-close";
const LINEAGE_BODY_CLASS = "report-lineage-body";
const LINEAGE_ROW_CLASS = "report-lineage-row";
const LINEAGE_ROW_PIN_CLASS = "report-lineage-row-pin";
const LINEAGE_ROW_PRODUCER_CLASS = "report-lineage-row-producer";
const LINEAGE_ROW_RAW_CLASS = "report-lineage-row-raw";
const LINEAGE_TAG_CLASS = "report-lineage-tag";
const LINEAGE_TAG_PIN_CLASS = "report-lineage-tag-pin";
const LINEAGE_TAG_RAW_CLASS = "report-lineage-tag-raw";
const LINEAGE_PATH_CLASS = "report-lineage-path";
const LINEAGE_DIR_CLASS = "report-lineage-dir";
const LINEAGE_HASH_CLASS = "report-lineage-hash";
const LINEAGE_PROMPT_CLASS = "report-lineage-prompt";
const LINEAGE_SCRIPT_CLASS = "report-lineage-script";
const LINEAGE_META_CLASS = "report-lineage-meta";
const LINEAGE_LINK_CLASS = "report-lineage-link";
const LINEAGE_RAIL_CLASS = "report-lineage-rail";
const LINEAGE_RAIL_PIN_CLASS = "report-lineage-rail-pin";
const LINEAGE_LINK_LABEL_CLASS = "report-lineage-link-label";
const LINEAGE_MORE_CLASS = "report-lineage-more";
const LINEAGE_FOOTER_CLASS = "report-lineage-footer";
const LINEAGE_CHECK_CLASS = "report-lineage-check";
const LINEAGE_NOTE_CLASS = "report-lineage-note";

/** The space between the control and the panel, and between the panel and the top and bottom edges, in pixels. */
const LINEAGE_PANEL_GAP_PX = 8;

/** The space between the panel and the left and right edges of the viewport, in pixels. */
const LINEAGE_PANEL_MARGIN_PX = 12;

/** The head of the run directory of the storage layout. A path under it carries the run id in its next segment. */
const RUN_DIRECTORY_HEAD = "runs/";

/**
 * The head of a path that the row shows in place of the segments that it cut.
 *
 * The cut takes whole segments off the front, thus the mark stands where a directory stood and the reader
 * sees that the row shows a tail. The hover then gives the whole path.
 */
const LINEAGE_CUT_MARK = "…";

/**
 * The longest tail that reads as an extension, and the tail of a name that carries none, in characters.
 *
 * The extension states the kind of the file, thus it is the part of a cut name that must survive. A dot far
 * from the end belongs to the name itself, and a tail from that dot would leave no start. Thus a tail longer
 * than the bound falls back to a fixed count of characters, and the cut still reads from both ends.
 */
const LINEAGE_EXTENSION_MAX_CHARS = 8;
const LINEAGE_NAME_TAIL_CHARS = 4;

/**
 * The indent of one rail level, and the inset of a connector, in pixels.
 *
 * A row of one level sits at its own indent, and the connector above it sits between the two levels. Thus
 * the rail of a connector reads as the line that joins the row above to the rows below.
 */
const LINEAGE_INDENT_PX = 24;
const LINEAGE_RAIL_INSET_PX = 14;

/**
 * The page-side script of the lineage popover.
 *
 * A grounded block stamps its block id and its keys. A control beside a marker names the place of its key
 * in that stamp. Thus the script reads the markup for everything that it shows, and it holds no copy of the
 * document model.
 *
 * One delegated listener serves the whole page. It opens the panel of the clicked control, it closes the
 * open panel when a second control opens its own, and it closes on a click outside the panel and on the
 * `Escape` key. As a result at most one panel stands at one time, and the page needs no listener for each
 * control.
 *
 * The panel is a child of the body, positioned against the document. A card clips its own overflow, thus a
 * panel inside a card would show as a strip. The position reads the box of the control, and it holds the
 * panel inside the viewport on each side. The panel opens under the control, and it opens over the control
 * where the space under it is short. It never covers the control that opened it: where neither side holds
 * the whole panel, the body shrinks instead. A resize invalidates the measure, thus a resize places the
 * open panel again.
 *
 * The rail comes from the edges of the walk and never from its node set. A `generated` edge binds an
 * artifact to the command that made it, and a `used` edge binds that command to a file that it read. Each
 * input file continues the rail with its own producer, down to a file that no command made. Thus the panel
 * shows the chain and it shows nothing else: a sibling output collapses behind one count row, and a step,
 * a run, and an agent never become a row.
 *
 * The panel takes the width of its longest row, up to the cap of the sheet. Thus a normal window shows each
 * name whole, and the cut answers a window too narrow for the row. The fit measures against the width of the
 * laid-out panel, which the open pins before the first cut. Without the pin a cut would shrink the panel and
 * the next measure would read a narrower box, thus the rows would cut each other down.
 *
 * The hover of a row gives the whole path, and it answers for the run prefix and for a cut alike.
 *
 * The script builds each node and it writes each string as text. Thus a hostile path, a hostile command,
 * and a hostile step of the document reach the panel as text and never as markup.
 *
 * The page makes no request. The document rides the page already, and the library reads it in memory. The
 * graph builds one time, on the first click, thus a reader who opens no panel pays nothing for the parse.
 */
export const LINEAGE_POPOVER = `(function () {
  var SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  var openPanel = null;
  var openControl = null;
  var graph = null;
  var graphFailed = false;
  function elementOf(node) {
    while (node && node.nodeType !== 1) {
      node = node.parentNode;
    }
    return node;
  }
  function controlOf(node) {
    var element = elementOf(node);
    while (element) {
      if (element.classList && element.classList.contains("${LINEAGE_CONTROL_CLASS}")) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }
  function stampOf(control) {
    var element = control.parentElement;
    while (element) {
      if (element.hasAttribute("${LINEAGE_BLOCK_ATTRIBUTE}")) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }
  function keyOf(control) {
    var stamp = stampOf(control);
    if (!stamp) {
      return null;
    }
    var keys;
    try {
      keys = JSON.parse(stamp.getAttribute("${LINEAGE_KEYS_ATTRIBUTE}") || "[]");
    } catch (cause) {
      return null;
    }
    var place = parseInt(control.getAttribute("${LINEAGE_KEY_ATTRIBUTE}") || "", 10);
    if (!isFinite(place) || place < 0 || place >= keys.length) {
      return null;
    }
    return keys[place];
  }
  function markerOf(control) {
    // The control sits inside the marker, beside the link that carries the shown number. Thus the header
    // names the number that the reader clicked, and no attribute of the markup repeats it.
    var marker = control.parentElement;
    var link = marker ? marker.querySelector("a") : null;
    return link ? String(link.textContent || "") : "";
  }
  function graphOf(library, text) {
    if (graph === null && !graphFailed) {
      try {
        // The read takes no format name. The writer of the document owns the format, thus the library
        // detects it and a document of another serialization still opens.
        graph = library.provToGraph(library.read(text));
      } catch (cause) {
        graphFailed = true;
      }
    }
    return graph;
  }
  function attrText(record, name) {
    var values = record.getAttribute(name);
    if (!values || values.length === 0) {
      return "";
    }
    var value = values[0];
    // A typed value arrives inside a literal wrapper, and a plain string arrives bare.
    return String(value !== null && typeof value === "object" && "value" in value ? value.value : value);
  }
  function dialectType(record) {
    var types = record.getAssertedTypes();
    for (var i = 0; i < types.length; i++) {
      var text = String(types[i]);
      if (text.indexOf("${DIALECT_TYPE_PREFIX}") === 0) {
        return text.slice(${DIALECT_TYPE_PREFIX.length});
      }
    }
    return "";
  }
  function chainOf(library, built, walked, key) {
    var made = Object.create(null);
    var read = Object.create(null);
    var ranIn = Object.create(null);
    var cut = Object.create(null);
    for (var e = 0; e < walked.edges.length; e++) {
      var edge = walked.edges[e];
      // A generation edge runs from the artifact to its command, a usage edge from a command to a file
      // that it read, and a communication edge from a command to its step. The three classes carry the
      // whole rail, thus every other traversed edge stays out of it.
      if (edge.relation instanceof library.ProvGeneration) {
        made[edge.from] = edge.to;
      } else if (edge.relation instanceof library.ProvUsage) {
        if (read[edge.from] === undefined) {
          read[edge.from] = [];
        }
        read[edge.from].push(edge.to);
      } else if (edge.relation instanceof library.ProvCommunication) {
        ranIn[edge.from] = edge.to;
      }
    }
    for (var f = 0; f < walked.frontier.length; f++) {
      cut[walked.frontier[f].uri] = true;
    }
    function fileParts(uri) {
      var node = built.getNode(uri);
      if (!node) {
        return { path: "", hash: "" };
      }
      return { path: attrText(node.element, "${PIN_PATH_ATTRIBUTE}"), hash: attrText(node.element, "${PIN_HASH_ATTRIBUTE}") };
    }
    function commandOf(uri) {
      var node = built.getNode(uri);
      if (!node) {
        return null;
      }
      var type = dialectType(node.element);
      if (type !== "${DIALECT_COMMAND_TYPE}" && type !== "${DIALECT_FILE_TOOL_TYPE}") {
        return null;
      }
      var stepUri = ranIn[uri];
      var stepNode = stepUri === undefined ? undefined : built.getNode(stepUri);
      return {
        label: type === "${DIALECT_COMMAND_TYPE}" ? attrText(node.element, "${COMMAND_ATTRIBUTE}") : attrText(node.element, "${TOOL_ATTRIBUTE}"),
        args: attrText(node.element, "${COMMAND_ARGS_ATTRIBUTE}"),
        unresolved: attrText(node.element, "${UNRESOLVED_SCRIPT_ATTRIBUTE}"),
        step: stepNode ? attrText(stepNode.element, "${STEP_ID_ATTRIBUTE}") : ""
      };
    }
    function producerOf(uri) {
      // A file that a step generated names no execution, thus the rail treats it the same as a file that
      // the document never generated: the branch ends there.
      var commandUri = made[uri];
      if (commandUri === undefined || commandOf(commandUri) === null) {
        return null;
      }
      return commandUri;
    }
    function scriptOf(command, inputs) {
      // The writer bound the script by an exact match of one path against the command line and its
      // arguments. The panel repeats that match, thus the row that names the script and the row that
      // names a data input never swap.
      var tokens = (command.label + " " + command.args).split(/\\s+/);
      for (var i = 0; i < inputs.length; i++) {
        var parts = fileParts(inputs[i]);
        for (var t = 0; t < tokens.length; t++) {
          if (parts.path !== "" && tokens[t] === parts.path) {
            return { uri: inputs[i], path: parts.path, hash: parts.hash };
          }
        }
      }
      // A script that bound to no bytes rides the activity by its path alone. Thus the row still names it,
      // and it carries no hash because the document holds none.
      return command.unresolved === "" ? null : { uri: "", path: command.unresolved, hash: "" };
    }
    function otherOutputs(commandUri, onRail) {
      // The walk runs backward, thus it never traverses the generation edge of a sibling output. The graph
      // holds every one of them, and the count states what the rail leaves out.
      var into = built.inEdges(commandUri);
      var total = 0;
      for (var i = 0; i < into.length; i++) {
        if (into[i].relation instanceof library.ProvGeneration) {
          total += 1;
        }
      }
      return total - onRail;
    }
    var rows = [{ form: "pin", level: 0, path: String(key.path), hash: String(key.hash) }];
    var seenFile = Object.create(null);
    var seenCommand = Object.create(null);
    var deepest = 0;
    function expand(uris, level) {
      var order = [];
      var onRail = Object.create(null);
      for (var u = 0; u < uris.length; u++) {
        var producerUri = producerOf(uris[u]);
        if (producerUri === null) {
          continue;
        }
        if (onRail[producerUri] === undefined) {
          onRail[producerUri] = 0;
          order.push(producerUri);
        }
        onRail[producerUri] += 1;
      }
      for (var c = 0; c < order.length; c++) {
        var commandUri = order[c];
        // The visited set bounds a document whose edges lead back to a command that the rail already
        // showed. Without it such a document would build rows forever.
        if (seenCommand[commandUri]) {
          continue;
        }
        seenCommand[commandUri] = true;
        var command = commandOf(commandUri);
        var inputs = read[commandUri] === undefined ? [] : read[commandUri];
        var script = scriptOf(command, inputs);
        rows.push({ form: "link", level: level, label: ${JSON.stringify(LINEAGE_MADE_BY_LABEL)}, pin: level === 0 });
        rows.push({
          form: "producer",
          level: level,
          name: baseName(script === null ? command.label : script.path),
          hash: script === null ? "" : script.hash,
          command: script === null ? "" : command.label,
          step: command.step
        });
        var next = [];
        for (var i = 0; i < inputs.length; i++) {
          if (script !== null && inputs[i] === script.uri) {
            continue;
          }
          if (seenFile[inputs[i]]) {
            continue;
          }
          seenFile[inputs[i]] = true;
          next.push(inputs[i]);
        }
        if (next.length > 0) {
          rows.push({ form: "link", level: level, label: readLabel(next.length), pin: false });
          deepest = level + 1 > deepest ? level + 1 : deepest;
        }
        for (var n = 0; n < next.length; n++) {
          var parts = fileParts(next[n]);
          rows.push({
            form: "file",
            level: level + 1,
            path: parts.path,
            hash: parts.hash,
            raw: producerOf(next[n]) === null && cut[next[n]] !== true
          });
        }
        var others = otherOutputs(commandUri, onRail[commandUri]);
        if (others > 0) {
          rows.push({ form: "more", level: level + 1, count: others, step: command.step });
        }
        expand(next, level + 1);
      }
    }
    var root = walked.roots.length > 0 ? walked.roots[0] : null;
    if (root === null) {
      return { rows: [], note: ${JSON.stringify(LINEAGE_NO_NODE_NOTE)}, hops: 1 };
    }
    seenFile[root] = true;
    expand([root], 0);
    return { rows: rows, note: walked.frontier.length > 0 ? ${JSON.stringify(LINEAGE_TRUNCATED_NOTE)} : "", hops: deepest + 1 };
  }
  function walk(key) {
    var library = window.${TSPROV_GLOBAL};
    var carrier = window.${REPORT_PROVENANCE_GLOBAL};
    if (!library || typeof library.lineage !== "function" || !carrier || typeof carrier.document !== "string") {
      return { rows: [], note: ${JSON.stringify(LINEAGE_NO_LIBRARY_NOTE)}, hops: 1 };
    }
    var built = graphOf(library, carrier.document);
    if (!built) {
      // A document that the library refuses is exactly the fault that a look must diagnose, thus it must
      // never leave the reader with a control that does nothing.
      return { rows: [], note: ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)}, hops: 1 };
    }
    var walked = null;
    var found = null;
    try {
      found = library.resolveUnique(built, {
        type: library.ProvEntity,
        attributes: [
          { name: "${PIN_PATH_ATTRIBUTE}", equals: key.path },
          { name: "${PIN_HASH_ATTRIBUTE}", equals: key.hash }
        ]
      });
      if (found.kind === "resolved") {
        walked = library.lineage(built, found.record, { direction: "backward", relations: "dataflow" });
      }
    } catch (cause) {
      return { rows: [], note: ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)}, hops: 1 };
    }
    if (walked === null) {
      // Two nodes of one pin answer no better than none: the page cannot state which chain it shows.
      return { rows: [], note: found.kind === "ambiguous" ? ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)} : ${JSON.stringify(LINEAGE_NO_NODE_NOTE)}, hops: 1 };
    }
    return chainOf(library, built, walked, key);
  }
  function part(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function boxed(tag, base, extra) {
    var node = document.createElement(tag);
    node.className = extra === "" ? base : base + " " + extra;
    return node;
  }
  function glyph(className, size, width, paths) {
    // A stroke drawing takes the current color, thus one rule of the sheet colors the glyph and its row.
    var svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", width);
    svg.setAttribute("aria-hidden", "true");
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute("d", paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }
  function hashHead(hash) {
    return hash.slice(hash.lastIndexOf(":") + 1).slice(0, ${CHAIN_HASH_CHARS});
  }
  function baseName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function readLabel(count) {
    return count === 1 ? "READ 1 FILE" : "READ " + count + " FILES";
  }
  function moreText(count, step) {
    var files = count === 1 ? "1 other file" : count + " other files";
    var origin = step === "" ? "the same command" : "Step " + step;
    return "▸ " + files + " came from " + origin + " — not on this chain";
  }
  function metaText(row) {
    var parts = [];
    if (row.hash !== "") {
      parts.push(hashHead(row.hash));
    }
    if (row.command !== "") {
      parts.push(row.command);
    }
    if (row.step !== "") {
      parts.push("Step " + row.step);
    }
    return parts.join(" · ");
  }
  function countText(marker, hops, complete) {
    var text = (hops === 1 ? "1 hop" : hops + " hops") + (complete ? " to the raw data" : "");
    return marker === "" ? text : marker + " · " + text;
  }
  function completeNote() {
    var carrier = window.${REPORT_PROVENANCE_GLOBAL};
    var signed = carrier && typeof carrier.attestation === "string";
    return signed ? ${JSON.stringify(LINEAGE_SIGNED_NOTE)} : ${JSON.stringify(LINEAGE_COMPLETE_NOTE)};
  }
  function runPrefix(path) {
    // Every hop of one chain sits under the run directory of the pinned artifact. The head repeats on each
    // row and the tail holds the meaning, thus the rows drop the head. A path outside the run, for example
    // a raw input under the data directory, matches no prefix and keeps its whole form.
    if (path.indexOf("${RUN_DIRECTORY_HEAD}") !== 0) {
      return "";
    }
    var cut = path.indexOf("/", ${RUN_DIRECTORY_HEAD.length});
    return cut < 0 ? "" : path.slice(0, cut + 1);
  }
  function shownPath(path, prefix) {
    return prefix !== "" && path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path;
  }
  function writePath(node, shown) {
    // The directory prefix dims, thus the file name reads first and the whole tail stays on the row. The fit
    // writes the same node again with fewer segments, thus the write clears what stands there.
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    var cut = shown.lastIndexOf("/");
    if (cut >= 0) {
      node.appendChild(part("span", "${LINEAGE_DIR_CLASS}", shown.slice(0, cut + 1)));
    }
    node.appendChild(document.createTextNode(shown.slice(cut + 1)));
  }
  function pathNode(shown, full) {
    var node = document.createElement("span");
    node.className = "${LINEAGE_PATH_CLASS}";
    // The title carries the whole path on each row, cut or not. Thus the hover answers for the run prefix
    // that the row drops and for a segment that the fit cuts.
    node.setAttribute("title", full);
    writePath(node, shown);
    return node;
  }
  function nameTail(name) {
    // The extension states the kind of the file, thus the tail starts at the last dot. A dot far from the
    // end belongs to the name, and a tail from there would leave no start, thus the fixed count answers.
    var dot = name.lastIndexOf(".");
    var extension = dot > 0 ? name.length - dot : 0;
    return name.slice(name.length - (extension > 0 && extension <= ${LINEAGE_EXTENSION_MAX_CHARS} ? extension : ${LINEAGE_NAME_TAIL_CHARS}));
  }
  function fitName(node, head, name) {
    // One name that overflows the row on its own has no segment left to cut. The start names the file and
    // the tail carries the extension, thus the mark stands between them and both ends stay on the row. Two
    // siblings that differ in their extension alone then read apart.
    var tail = nameTail(name);
    var keep = name.length - tail.length;
    while (keep > 1 && node.scrollWidth > node.clientWidth) {
      keep -= 1;
      writePath(node, head + name.slice(0, keep) + ${JSON.stringify(LINEAGE_CUT_MARK)} + tail);
    }
  }
  function fitPath(node) {
    // A row holds one line. A cut at the end would take the file name, which is the part that names the
    // file, thus the cut takes whole segments off the front and the end stays. The measure needs a laid-out
    // row, thus the fit runs after the panel joins the document.
    var parts = String(node.textContent || "").split("/");
    var whole = parts.length;
    while (parts.length > 1 && node.scrollWidth > node.clientWidth) {
      parts.shift();
      writePath(node, ${JSON.stringify(`${LINEAGE_CUT_MARK}/`)} + parts.join("/"));
    }
    if (parts.length === 1) {
      // The segments are gone and the row can still overflow. The mark of the segment cut stands where the
      // directories stood, thus the name cut writes it again in front of the name that it cuts.
      fitName(node, whole > 1 ? ${JSON.stringify(`${LINEAGE_CUT_MARK}/`)} : "", parts[0]);
    }
  }
  function fitPaths(panel) {
    var nodes = panel.querySelectorAll(".${LINEAGE_PATH_CLASS}");
    for (var i = 0; i < nodes.length; i++) {
      fitPath(nodes[i]);
    }
  }
  function fileRow(row, prefix) {
    var kind = row.form === "pin" ? "${LINEAGE_ROW_PIN_CLASS}" : row.raw ? "${LINEAGE_ROW_RAW_CLASS}" : "";
    var node = boxed("div", "${LINEAGE_ROW_CLASS}", kind);
    node.style.marginLeft = row.level * ${LINEAGE_INDENT_PX} + "px";
    var tag = row.form === "pin" ? "${LINEAGE_TAG_PIN_CLASS}" : row.raw ? "${LINEAGE_TAG_RAW_CLASS}" : "";
    var text = row.form === "record" ? ${JSON.stringify(LINEAGE_RECORD_TAG)} : row.form === "pin" ? ${JSON.stringify(LINEAGE_PIN_TAG)} : row.raw ? ${JSON.stringify(LINEAGE_RAW_TAG)} : ${JSON.stringify(LINEAGE_ARTIFACT_TAG)};
    node.appendChild(part("span", tag === "" ? "${LINEAGE_TAG_CLASS}" : "${LINEAGE_TAG_CLASS}" + " " + tag, text));
    node.appendChild(pathNode(shownPath(row.path, prefix), row.path));
    if (row.hash !== "") {
      node.appendChild(part("code", "${LINEAGE_HASH_CLASS}", hashHead(row.hash)));
    }
    return node;
  }
  function rowNode(row, prefix) {
    if (row.form === "link") {
      var link = boxed("div", "${LINEAGE_LINK_CLASS}", "");
      link.style.paddingLeft = ${LINEAGE_RAIL_INSET_PX} + row.level * ${LINEAGE_INDENT_PX} + "px";
      link.appendChild(boxed("div", "${LINEAGE_RAIL_CLASS}", row.pin ? "${LINEAGE_RAIL_PIN_CLASS}" : ""));
      link.appendChild(part("span", "${LINEAGE_LINK_LABEL_CLASS}", row.label));
      return link;
    }
    if (row.form === "more") {
      var more = part("div", "${LINEAGE_MORE_CLASS}", moreText(row.count, row.step));
      more.style.marginLeft = row.level * ${LINEAGE_INDENT_PX} + "px";
      return more;
    }
    if (row.form === "producer") {
      var producer = boxed("div", "${LINEAGE_ROW_CLASS}", "${LINEAGE_ROW_PRODUCER_CLASS}");
      producer.style.marginLeft = row.level * ${LINEAGE_INDENT_PX} + "px";
      producer.appendChild(glyph("${LINEAGE_PROMPT_CLASS}", "14", "1.5", ["M4 3l4 5-4 5", "M9 13h4"]));
      producer.appendChild(part("span", "${LINEAGE_SCRIPT_CLASS}", row.name));
      producer.appendChild(part("span", "${LINEAGE_META_CLASS}", metaText(row)));
      return producer;
    }
    return fileRow(row, prefix);
  }
  function recordName(key) {
    return String(key.idKind) + ":" + String(key.id);
  }
  function panelOf(key, marker) {
    var pinned = typeof key.path === "string";
    var walked = pinned ? walk(key) : { rows: [], note: ${JSON.stringify(LINEAGE_RECORD_NOTE)}, hops: 1 };
    var rows = walked.rows;
    if (!pinned) {
      rows = [{ form: "record", level: 0, path: recordName(key), hash: "" }];
    } else if (rows.length === 0) {
      // The pin is the last hop that the page knows on its own. A walk that gave nothing still names it,
      // thus the reader sees what the block binds and reads the note against it.
      rows = [{ form: "pin", level: 0, path: String(key.path), hash: String(key.hash) }];
    }
    var panel = document.createElement("div");
    panel.className = "${LINEAGE_PANEL_CLASS}";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", pinned ? String(key.path) : recordName(key));
    var header = boxed("div", "${LINEAGE_HEADER_CLASS}", "");
    header.appendChild(part("span", "${LINEAGE_PANEL_TITLE_CLASS}", ${JSON.stringify(LINEAGE_TITLE_TEXT)}));
    header.appendChild(part("span", "${LINEAGE_COUNT_CLASS}", countText(marker, walked.hops, walked.note === "")));
    var closer = part("button", "${LINEAGE_CLOSE_CLASS}", ${JSON.stringify(LINEAGE_CLOSE_GLYPH)});
    closer.setAttribute("type", "button");
    closer.setAttribute("aria-label", ${JSON.stringify(LINEAGE_CLOSE_LABEL)});
    closer.addEventListener("click", close);
    header.appendChild(closer);
    panel.appendChild(header);
    var body = boxed("div", "${LINEAGE_BODY_CLASS}", "");
    // The pinned artifact names the run of the whole chain. Thus one prefix serves each row, and a chain
    // that the pin does not root under a run keeps each path whole.
    var prefix = pinned ? runPrefix(String(key.path)) : "";
    for (var i = 0; i < rows.length; i++) {
      body.appendChild(rowNode(rows[i], prefix));
    }
    panel.appendChild(body);
    var footer = boxed("div", "${LINEAGE_FOOTER_CLASS}", "");
    if (walked.note === "") {
      footer.appendChild(glyph("${LINEAGE_CHECK_CLASS}", "12", "1.8", ["M2 8l4 4 8-9"]));
    }
    footer.appendChild(part("span", "${LINEAGE_NOTE_CLASS}", walked.note === "" ? completeNote() : walked.note));
    panel.appendChild(footer);
    return panel;
  }
  function place(panel, control) {
    var box = control.getBoundingClientRect();
    var root = document.documentElement;
    var body = panel.querySelector(".${LINEAGE_BODY_CLASS}");
    // A prior placement can hold a cap of its own. The reset measures the natural height again, thus a
    // resize into a taller window never keeps a cap that the new viewport does not need.
    body.style.maxHeight = "";
    var left = box.left;
    var last = root.clientWidth - panel.offsetWidth - ${LINEAGE_PANEL_MARGIN_PX};
    if (left > last) {
      left = last;
    }
    if (left < ${LINEAGE_PANEL_MARGIN_PX}) {
      left = ${LINEAGE_PANEL_MARGIN_PX};
    }
    // The panel opens under the control, because a reader reads down from what was clicked. It opens over
    // the control where the space under it is short and the space over it is larger.
    var below = root.clientHeight - box.bottom - ${LINEAGE_PANEL_GAP_PX} * 2;
    var above = box.top - ${LINEAGE_PANEL_GAP_PX} * 2;
    var over = panel.offsetHeight > below && above > below;
    var room = over ? above : below;
    if (panel.offsetHeight > room) {
      // Neither side holds the whole panel. The body scrolls already, thus the cap shrinks the body to the
      // larger side. An overlap would hide the control that the reader clicked, and the shrink prevents it.
      var chrome = panel.offsetHeight - body.offsetHeight;
      body.style.maxHeight = (room - chrome > 0 ? room - chrome : 0) + "px";
    }
    var top = over ? box.top - panel.offsetHeight - ${LINEAGE_PANEL_GAP_PX} : box.bottom + ${LINEAGE_PANEL_GAP_PX};
    panel.style.left = left + window.pageXOffset + "px";
    panel.style.top = top + window.pageYOffset + "px";
  }
  function close() {
    if (openPanel && openPanel.parentNode) {
      openPanel.parentNode.removeChild(openPanel);
    }
    if (openControl) {
      openControl.setAttribute("aria-expanded", "false");
    }
    openPanel = null;
    openControl = null;
  }
  function openFor(control) {
    var key = keyOf(control);
    if (!key) {
      return;
    }
    var panel = panelOf(key, markerOf(control));
    document.body.appendChild(panel);
    // The sheet sizes the panel to its longest row, up to a cap. A cut shortens that row, thus the panel
    // would shrink under the fit and each row would then measure against a narrower box. The pin holds the
    // resolved width of the laid-out panel, and the cap of the sheet still bounds it in a narrow window.
    panel.style.width = panel.getBoundingClientRect().width + "px";
    // The fit measures a row against its width, thus it runs on the panel that stands in the document. It
    // runs before the place, because a cut row can change the height that the place reads.
    fitPaths(panel);
    place(panel, control);
    control.setAttribute("aria-expanded", "true");
    openPanel = panel;
    openControl = control;
  }
  function insidePanel(node) {
    var element = elementOf(node);
    while (element) {
      if (element === openPanel) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }
  document.addEventListener("click", function (event) {
    var control = controlOf(event.target);
    if (control) {
      var same = control === openControl;
      close();
      if (!same) {
        openFor(control);
      }
      return;
    }
    if (!insidePanel(event.target)) {
      close();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      close();
    }
  });
  window.addEventListener("resize", function () {
    if (openPanel !== null && openControl !== null) {
      // The place reads the box of the control, and a resize moves that box. Thus the panel follows the
      // control instead of standing where the control was.
      place(openPanel, openControl);
    }
  });
})();`;
