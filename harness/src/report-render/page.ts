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
 * The attribute names of the dialect that the walk reads.
 *
 * The writer of the document stamps these names on a file entity and on an activity. The popover reads
 * them and nothing else of the document, thus a pin resolves to one node and a hop reads as the appendix
 * entry of the same artifact reads.
 *
 * The label names are in the order of preference. An activity carries the first of them that fits its own
 * kind, and a file entity carries none of them, because the path already names it.
 */
const PIN_PATH_ATTRIBUTE = "inflexa:path";
const PIN_HASH_ATTRIBUTE = "inflexa:hash";
const DIALECT_TYPE_PREFIX = "inflexa:";
const DIALECT_FILE_TYPE = "File";
const HOP_LABEL_ATTRIBUTES = ["inflexa:command", "inflexa:tool", "inflexa:stepId", "inflexa:runId", "inflexa:name", "prov:label"];

/** The heading of the popover. It names what the panel holds, above the hops. */
const LINEAGE_TITLE_TEXT = "Lineage";

/** The note of a page that carries no lineage library. The chain then stops at the pin of the block. */
export const LINEAGE_NO_LIBRARY_NOTE = "The lineage library is not on this page. Thus the chain stops at this pin.";

/** The note of a library call that gave no answer. The pin stays the last hop that the page knows. */
export const LINEAGE_NO_ANSWER_NOTE = "The lineage library gave no answer for this pin. Thus the chain stops here.";

/** The note of a pin that the document holds no node for. */
export const LINEAGE_NO_NODE_NOTE = "The document holds no node for this pin. Thus the chain stops here.";

/** The note of a chain that the library cut at its own depth bound. */
export const LINEAGE_TRUNCATED_NOTE = "The library cut this chain at its depth bound. Thus the chain continues past the last hop.";

/** The kind tag of the pin hop that the page names on its own, without the library. */
const LINEAGE_ARTIFACT_KIND = "Artifact";

/** The kind tag of a hop that names an operation and carries no dialect type of its own. */
const LINEAGE_OPERATION_KIND = "Activity";

/** The kind tag of the one hop of an external record. */
const LINEAGE_RECORD_KIND = "Citation";

/**
 * The classes of the popover. The script emits each one, and the design sheet holds the matching rule.
 *
 * The hop reuses the appendix vocabulary for the kind tag, the path, the detail, and the hash head. Thus
 * one reference reads alike in the appendix and in the popover, and the sheet styles both from one rule.
 */
const LINEAGE_PANEL_CLASS = "report-lineage-popover";
const LINEAGE_PANEL_TITLE_CLASS = "report-lineage-title";
const LINEAGE_HOPS_CLASS = "report-lineage-hops";
const LINEAGE_HOP_CLASS = "report-lineage-hop";
const LINEAGE_NOTE_CLASS = "report-lineage-note";

/** The space between the control and the panel, and between the panel and the edge of the viewport, in pixels. */
const LINEAGE_PANEL_GAP_PX = 8;

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
 * panel inside a card would show as a strip. The position reads the box of the control at click time, and
 * it holds the panel inside the viewport on both sides. A resize invalidates that measure, thus a resize
 * closes the panel.
 *
 * The script builds each node and it writes each string as text. Thus a hostile path, a hostile label, and
 * a hostile hop of the document reach the panel as text and never as markup.
 *
 * The page makes no request. The document rides the page already, and the library reads it in memory. The
 * graph builds one time, on the first click, thus a reader who opens no panel pays nothing for the parse.
 */
export const LINEAGE_POPOVER = `(function () {
  var openPanel = null;
  var openControl = null;
  var graph = null;
  var graphFailed = false;
  var labelNames = ${JSON.stringify(HOP_LABEL_ATTRIBUTES)};
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
  function labelOf(record) {
    for (var i = 0; i < labelNames.length; i++) {
      var text = attrText(record, labelNames[i]);
      if (text !== "") {
        return text;
      }
    }
    return "";
  }
  function hopOf(library, node) {
    var element = node.element;
    var type = dialectType(element);
    // A read of raw data carries no dialect type, and the walk still reaches it. Thus the fallback reads
    // the record class, and a file of that kind names itself the same as the pin of a block does.
    var named = type !== "" && type !== "${DIALECT_FILE_TYPE}";
    var artifact = element instanceof library.ProvEntity;
    return {
      kind: named ? type : artifact ? "${LINEAGE_ARTIFACT_KIND}" : "${LINEAGE_OPERATION_KIND}",
      label: labelOf(element),
      path: attrText(element, "${PIN_PATH_ATTRIBUTE}"),
      hash: attrText(element, "${PIN_HASH_ATTRIBUTE}")
    };
  }
  function walk(key) {
    var library = window.${TSPROV_GLOBAL};
    var carrier = window.${REPORT_PROVENANCE_GLOBAL};
    if (!library || typeof library.lineage !== "function" || !carrier || typeof carrier.document !== "string") {
      return { hops: [], note: ${JSON.stringify(LINEAGE_NO_LIBRARY_NOTE)} };
    }
    var built = graphOf(library, carrier.document);
    if (!built) {
      // A document that the library refuses is exactly the fault that a look must diagnose, thus it must
      // never leave the reader with a control that does nothing.
      return { hops: [], note: ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)} };
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
      return { hops: [], note: ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)} };
    }
    if (walked === null) {
      // Two nodes of one pin answer no better than none: the page cannot state which chain it shows.
      return { hops: [], note: found.kind === "ambiguous" ? ${JSON.stringify(LINEAGE_NO_ANSWER_NOTE)} : ${JSON.stringify(LINEAGE_NO_NODE_NOTE)} };
    }
    var hops = [];
    for (var i = 0; i < walked.nodes.length; i++) {
      hops.push(hopOf(library, walked.nodes[i]));
    }
    return { hops: hops, note: walked.frontier.length > 0 ? ${JSON.stringify(LINEAGE_TRUNCATED_NOTE)} : "" };
  }
  function part(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function hashHead(hash) {
    return hash.slice(hash.lastIndexOf(":") + 1).slice(0, ${CHAIN_HASH_CHARS});
  }
  function detail(item, tag, className, text) {
    item.appendChild(document.createTextNode(" "));
    item.appendChild(part(tag, className, text));
  }
  function hopItem(hop) {
    var item = document.createElement("li");
    item.className = "${LINEAGE_HOP_CLASS}";
    item.appendChild(part("span", "report-ref-kind", String(hop.kind === undefined ? "" : hop.kind)));
    if (hop.label) {
      detail(item, "span", "report-ref-detail", String(hop.label));
    }
    if (hop.path) {
      detail(item, "code", "report-ref-path", String(hop.path));
    }
    if (hop.hash) {
      detail(item, "code", "report-ref-hash", hashHead(String(hop.hash)));
    }
    return item;
  }
  function recordName(key) {
    return String(key.idKind) + ":" + String(key.id);
  }
  function panelOf(key) {
    var pinned = typeof key.path === "string";
    var walked = pinned ? walk(key) : { hops: [], note: "" };
    var hops = walked.hops.slice();
    if (!pinned) {
      hops.push({ kind: "${LINEAGE_RECORD_KIND}", label: recordName(key) });
    } else if (hops.length === 0) {
      // The pin is the last hop that the page knows on its own. A walk that gave nothing still names it,
      // thus the reader sees what the block binds and reads the note against it.
      hops.push({ kind: "${LINEAGE_ARTIFACT_KIND}", path: key.path, hash: key.hash });
    }
    var panel = document.createElement("div");
    panel.className = "${LINEAGE_PANEL_CLASS}";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", pinned ? String(key.path) : recordName(key));
    panel.appendChild(part("div", "${LINEAGE_PANEL_TITLE_CLASS}", ${JSON.stringify(LINEAGE_TITLE_TEXT)}));
    var list = document.createElement("ol");
    list.className = "${LINEAGE_HOPS_CLASS}";
    for (var i = 0; i < hops.length; i++) {
      list.appendChild(hopItem(hops[i]));
    }
    panel.appendChild(list);
    if (walked.note) {
      panel.appendChild(part("div", "${LINEAGE_NOTE_CLASS}", walked.note));
    }
    return panel;
  }
  function place(panel, control) {
    var box = control.getBoundingClientRect();
    var width = document.documentElement.clientWidth;
    var left = box.left;
    var last = width - panel.offsetWidth - ${LINEAGE_PANEL_GAP_PX};
    if (left > last) {
      left = last;
    }
    if (left < ${LINEAGE_PANEL_GAP_PX}) {
      left = ${LINEAGE_PANEL_GAP_PX};
    }
    panel.style.left = left + window.pageXOffset + "px";
    panel.style.top = box.bottom + window.pageYOffset + ${LINEAGE_PANEL_GAP_PX} + "px";
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
    var panel = panelOf(key);
    document.body.appendChild(panel);
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
  window.addEventListener("resize", close);
})();`;
