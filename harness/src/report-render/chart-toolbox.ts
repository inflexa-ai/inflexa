/**
 * The toolbox of a page chart: the download menu, the data view, and the zoom of a dense cartesian chart.
 *
 * The derivation gives a figure with no toolbox. The chart card adds the toolbox to the option of the page, and
 * each export removes it again, thus a file never shows it. The option rides to the page as inline JSON, thus
 * it holds no function. Each handler of the toolbox is the name of a page function, and the bootstrap binds the
 * function under that name after the parse, as it registers a named renderer.
 *
 * The toolbox holds no `magicType`, because a reader must not change the form that the author chose.
 */

import type { ChartType } from "../contracts/report-blocks.js";
import type { EchartOption } from "./chart.js";
import { CHART_INK, CHART_TOOLBOX_ACTIVE_COLOR, CHART_TOOLBOX_FONT, CHART_TOOLBOX_ICON_COLOR } from "./design.js";

/**
 * The chart types that get the zoom and the restore controls: the dense cartesian forms. A reader zooms into a
 * cloud of many thousands of points to read one region.
 */
export const DENSE_CARTESIAN_CHARTS: readonly ChartType[] = ["scatter", "embedding", "volcano", "ma", "manhattan", "qq", "locuszoom"];

/** The page function that opens the download menu of a chart, and the page function that gives the data view. */
export const EXPORT_MENU_FUNCTION = "reportOpenExportMenu";
export const DATA_VIEW_FUNCTION = "reportDataViewContent";

/**
 * The members of a toolbox feature that name a page function. The bootstrap replaces each name with its
 * function, and it removes a name that the page does not hold, because the runtime calls the member.
 */
export const TOOLBOX_FUNCTION_MEMBERS = ["onclick", "optionToContent"] as const;

/** The names of the page functions that a toolbox can name. Each one is a function of `CHART_TOOLBOX_SOURCE`. */
export const TOOLBOX_PAGE_FUNCTIONS = [EXPORT_MENU_FUNCTION, DATA_VIEW_FUNCTION] as const;

/** The download icon: an arrow into a tray, as the path of a 24-pixel box. The runtime strokes it in the icon color. */
export const DOWNLOAD_ICON = "path://M12 3L12 15M7 10L12 15L17 10M4 17L4 21L20 21L20 17";

/**
 * The place of the toolbox in the chart body, in pixels: the gap to the right edge and to the top edge, the
 * padding of the toolbox box, the size of one icon, and the gap between two icons. The theme reserves a top
 * band of 24 pixels over the grid, thus one icon and its padding fit the band.
 */
const TOOLBOX_RIGHT_PX = 4;
const TOOLBOX_TOP_PX = 0;
const TOOLBOX_PADDING_PX = 5;
const TOOLBOX_ITEM_PX = 14;
const TOOLBOX_ITEM_GAP_PX = 12;

/** The width of an icon stroke, in pixels. */
const TOOLBOX_STROKE_PX = 1.25;

/** The size of the title text that the runtime shows under an icon on hover, in pixels. */
const TOOLBOX_TITLE_PX = 10;

/** The gap between the download icon and the top edge of its menu, in pixels. */
const MENU_GAP_PX = 4;

/** The suffix of the id of a download menu. The menu of a chart takes the id of its container and this suffix. */
const MENU_ID_SUFFIX = "-menu";

/** The suffix of the id of the download control of a card. The control takes the id of its container and this suffix. */
const MENU_CONTROL_SUFFIX = "-download";

/** The attribute of the download control of a card. It holds the id of the container whose menu the control opens. */
export const MENU_CONTROL_ATTRIBUTE = "data-chart-menu";

/** The class of an open download menu. The design sheet shows a menu with this class, and it hides each other menu. */
export const MENU_OPEN_CLASS = "report-chart-menu-open";

/** The class of the hidden note that a menu shows when the page cannot build the file of an entry. */
export const MENU_FAULT_CLASS = "report-chart-menu-fault";

/** The class of a fault note that the page shows. The design sheet hides each other fault note. */
export const MENU_FAULT_SHOWN_CLASS = "report-chart-menu-fault-shown";

/**
 * The most rows that the data view shows. A dense chart plots many thousands of points, and a table of each one
 * costs the page a DOM node for each cell. The note of the view then states the count that it holds back.
 */
export const DATA_VIEW_ROW_LIMIT = 1000;

/** The texts of the data view: the heading, the close control, and the refresh control that a read-only view hides. */
const DATA_VIEW_LANG = ["Data", "Close", "Refresh"] as const;

/** The id of the download menu of the chart in one container. */
export function chartMenuId(containerId: string): string {
    return `${containerId}${MENU_ID_SUFFIX}`;
}

/** The id of the download control in the card of the chart in one container. */
export function chartMenuControlId(containerId: string): string {
    return `${containerId}${MENU_CONTROL_SUFFIX}`;
}

/**
 * The toolbox of one page chart.
 *
 * Each chart gets the data view and the download control. A dense cartesian chart also gets the zoom and the
 * restore controls. A composition names no chart type, thus it gets no zoom. The download control is the last
 * feature, thus it sits at the right edge and its menu opens under it.
 */
export function chartToolbox(chartType: ChartType | undefined): EchartOption {
    const dense = chartType !== undefined && DENSE_CARTESIAN_CHARTS.includes(chartType);
    return {
        show: true,
        right: TOOLBOX_RIGHT_PX,
        top: TOOLBOX_TOP_PX,
        padding: TOOLBOX_PADDING_PX,
        itemSize: TOOLBOX_ITEM_PX,
        itemGap: TOOLBOX_ITEM_GAP_PX,
        iconStyle: { borderColor: CHART_TOOLBOX_ICON_COLOR, borderWidth: TOOLBOX_STROKE_PX },
        emphasis: {
            iconStyle: {
                borderColor: CHART_TOOLBOX_ACTIVE_COLOR,
                textFill: CHART_TOOLBOX_ACTIVE_COLOR,
                textFontFamily: CHART_TOOLBOX_FONT,
                textFontSize: TOOLBOX_TITLE_PX,
            },
        },
        feature: {
            ...(dense
                ? {
                      dataZoom: { show: true, title: { zoom: "Zoom", back: "Undo zoom" }, filterMode: "none" },
                      restore: { show: true, title: "Restore" },
                  }
                : {}),
            dataView: {
                show: true,
                title: "Data",
                readOnly: true,
                lang: [...DATA_VIEW_LANG],
                optionToContent: DATA_VIEW_FUNCTION,
                backgroundColor: "#ffffff",
                textColor: CHART_INK,
                buttonColor: CHART_TOOLBOX_ACTIVE_COLOR,
                buttonTextColor: "#ffffff",
            },
            myExport: { show: true, title: "Download", icon: DOWNLOAD_ICON, onclick: EXPORT_MENU_FUNCTION },
        },
    };
}

/** The option of the page: the derived option with the toolbox of its chart type. The derived option stays as it is. */
export function pageChartOption(option: EchartOption, chartType: ChartType | undefined): EchartOption {
    return { ...option, toolbox: chartToolbox(chartType) };
}

/**
 * The page functions of the toolbox, as browser source text.
 *
 * `reportOpenExportMenu` is the click handler of the download icon of the toolbox. The runtime calls it with the
 * model, the API of the chart, the name of the icon, and the event. The runtime draws the icon on the canvas and
 * binds a mouse click alone, thus the card also carries a download control in its title line. `reportMenuClick`
 * takes a click on that control, and a button fires a click for the Enter key and the Space key. The two paths
 * open the menu of the chart under the icon, at the right edge of the chart body, and a second click closes it.
 * The control states the open menu in `aria-expanded`.
 *
 * The menu takes the keyboard: the first entry takes the focus, the arrow keys, `Home`, and `End` move the focus,
 * and `Escape` closes the menu and gives the focus back to the control of the card. `Tab` closes the menu and puts
 * the focus on the control, thus the next Tab stop comes after the control. A click outside the menu closes it,
 * and so does a click on an entry. After an entry fires, the focus goes back to the control.
 *
 * The runtime sends the click of the icon on to the document, and that click is outside the menu. Thus the menu
 * keeps the event that opened it, and the outside test skips that one event.
 *
 * `reportMenuFault` shows the fault note of the open menu and gives it the focus, when the page cannot build the
 * file of an entry. The menu then stays open, and the close hides the note again.
 *
 * `reportDataViewContent` gives the data view: the plotted rows of each series as one plain table, up to the row
 * limit. A series that the reader cannot hover, for example the anchors of the point names, holds no data of the
 * figure, thus the table skips it. A number of a category axis reads as its category. The view builds each cell
 * as text, thus a hostile name reaches the view as text and never as markup.
 *
 * `reportBindToolbox` replaces each function name of the toolbox with its page function.
 */
export const CHART_TOOLBOX_SOURCE = `var reportMenuOpen = null;
var reportMenuEvent = null;
var reportMenuFocus = null;
var reportMenuControl = null;
var reportMenuRight = 0;
function reportToolboxList(member) {
  if (member === undefined || member === null) {
    return [];
  }
  return Array.isArray(member) ? member : [member];
}
function reportMenuItems(menu) {
  return menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])');
}
function reportCloseExportMenu(restore) {
  var menu = reportMenuOpen;
  if (menu === null) {
    return;
  }
  menu.classList.remove(${JSON.stringify(MENU_OPEN_CLASS)});
  var fault = menu.querySelector(${JSON.stringify(`.${MENU_FAULT_CLASS}`)});
  if (fault) {
    fault.classList.remove(${JSON.stringify(MENU_FAULT_SHOWN_CLASS)});
  }
  if (reportMenuControl) {
    reportMenuControl.setAttribute("aria-expanded", "false");
  }
  reportMenuOpen = null;
  reportMenuEvent = null;
  reportMenuControl = null;
  var focus = reportMenuFocus;
  reportMenuFocus = null;
  if (restore && focus && typeof focus.focus === "function") {
    focus.focus();
  }
}
function reportToggleExportMenu(container, event) {
  var menu = container && container.id ? document.getElementById(container.id + ${JSON.stringify(MENU_ID_SUFFIX)}) : null;
  if (!menu) {
    return;
  }
  if (reportMenuOpen === menu) {
    reportCloseExportMenu(true);
    return;
  }
  reportCloseExportMenu(false);
  menu.classList.add(${JSON.stringify(MENU_OPEN_CLASS)});
  // The download control is the last icon, thus its right edge sits at the right gap and the padding of the
  // toolbox from the right edge of the chart body.
  reportMenuRight = container.offsetLeft + container.clientWidth - ${TOOLBOX_RIGHT_PX + TOOLBOX_PADDING_PX};
  var left = reportMenuRight - menu.offsetWidth;
  menu.style.left = (left > 0 ? left : 0) + "px";
  menu.style.top = container.offsetTop + ${TOOLBOX_TOP_PX + TOOLBOX_PADDING_PX + TOOLBOX_ITEM_PX + MENU_GAP_PX} + "px";
  reportMenuOpen = menu;
  reportMenuEvent = event;
  reportMenuControl = document.getElementById(container.id + ${JSON.stringify(MENU_CONTROL_SUFFIX)});
  reportMenuFocus = reportMenuControl || document.activeElement;
  if (reportMenuControl) {
    reportMenuControl.setAttribute("aria-expanded", "true");
  }
  var items = reportMenuItems(menu);
  if (items.length > 0) {
    items[0].focus();
  }
}
function reportOpenExportMenu(ecModel, api, iconName, event) {
  reportToggleExportMenu(api.getDom(), event && event.event ? event.event : null);
}
function reportMenuFault(entry) {
  var menu = entry && typeof entry.closest === "function" ? entry.closest('[role="menu"]') : null;
  var fault = menu ? menu.querySelector(${JSON.stringify(`.${MENU_FAULT_CLASS}`)}) : null;
  if (!fault) {
    return;
  }
  fault.classList.add(${JSON.stringify(MENU_FAULT_SHOWN_CLASS)});
  if (menu === reportMenuOpen) {
    var left = reportMenuRight - menu.offsetWidth;
    menu.style.left = (left > 0 ? left : 0) + "px";
  }
  fault.focus();
}
function reportMenuClick(event) {
  var target = event.target;
  var control = target && typeof target.closest === "function" ? target.closest(${JSON.stringify(`[${MENU_CONTROL_ATTRIBUTE}]`)}) : null;
  if (control) {
    reportToggleExportMenu(document.getElementById(control.getAttribute(${JSON.stringify(MENU_CONTROL_ATTRIBUTE)}) || ""), event);
    return;
  }
  if (reportMenuOpen === null || event === reportMenuEvent) {
    return;
  }
  var inside = target && typeof target.closest === "function" ? target.closest('[role="menu"]') : null;
  if (inside === reportMenuOpen) {
    var item = target.closest('[role="menuitem"]');
    if (!item || item.getAttribute("aria-disabled") === "true") {
      return;
    }
    // The entry fired, and the menu that held the focus closes, thus the focus goes back to the control.
    reportCloseExportMenu(true);
    return;
  }
  reportCloseExportMenu(false);
}
function reportMenuKey(event) {
  var menu = reportMenuOpen;
  if (menu === null) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    reportCloseExportMenu(true);
    return;
  }
  if (event.key === "Tab") {
    reportCloseExportMenu(true);
    return;
  }
  var items = reportMenuItems(menu);
  if (items.length === 0) {
    return;
  }
  var at = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i] === document.activeElement) {
      at = i;
    }
  }
  var next = -1;
  if (event.key === "ArrowDown") {
    next = at < 0 || at === items.length - 1 ? 0 : at + 1;
  } else if (event.key === "ArrowUp") {
    next = at <= 0 ? items.length - 1 : at - 1;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = items.length - 1;
  }
  if (next >= 0) {
    event.preventDefault();
    items[next].focus();
  }
}
function reportCategoryCell(axis, cell) {
  if (!axis || axis.type !== "category" || !Array.isArray(axis.data) || typeof cell !== "number" || cell % 1 !== 0 || cell < 0 || cell >= axis.data.length) {
    return cell;
  }
  var entry = axis.data[cell];
  return typeof entry === "object" && entry !== null ? entry.value : entry;
}
function reportViewCell(cell) {
  if (cell === null || cell === undefined || cell === "-") {
    return "";
  }
  if (typeof cell === "number") {
    return isFinite(cell) ? String(Number.isInteger(cell) ? cell : Number(cell.toPrecision(6))) : "";
  }
  return String(cell);
}
function reportDataViewRows(option, limit) {
  var series = reportToolboxList(option.series);
  var xAxes = reportToolboxList(option.xAxis);
  var yAxes = reportToolboxList(option.yAxis);
  var rows = [];
  var total = 0;
  var named = false;
  var width = 0;
  var heads = null;
  function keep(seriesName, itemName, cells) {
    total += 1;
    if (rows.length >= limit) {
      return;
    }
    if (itemName !== "") {
      named = true;
    }
    if (cells.length > width) {
      width = cells.length;
    }
    rows.push([seriesName, itemName].concat(cells));
  }
  for (var s = 0; s < series.length; s++) {
    var entry = series[s];
    if (!entry || entry.silent === true || (entry.tooltip && entry.tooltip.show === false)) {
      continue;
    }
    var seriesName = entry.name === undefined || entry.name === null ? "" : String(entry.name);
    if (Array.isArray(entry.links)) {
      for (var l = 0; l < entry.links.length; l++) {
        var link = entry.links[l];
        keep(seriesName, reportViewCell(link.source) + " → " + reportViewCell(link.target), [reportViewCell(link.value)]);
      }
      continue;
    }
    var data = Array.isArray(entry.data) ? entry.data : [];
    var xAxis = xAxes[typeof entry.xAxisIndex === "number" ? entry.xAxisIndex : 0];
    var yAxis = yAxes[typeof entry.yAxisIndex === "number" ? entry.yAxisIndex : 0];
    var cartesian = entry.coordinateSystem === undefined || entry.coordinateSystem === "cartesian2d";
    if (cartesian && heads === null && xAxis && yAxis) {
      heads = [xAxis.name ? String(xAxis.name) : "x", yAxis.name ? String(yAxis.name) : "y"];
    }
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var boxed = typeof item === "object" && item !== null && !Array.isArray(item);
      var value = boxed ? item.value : item;
      var itemName = boxed && item.name !== undefined && item.name !== null ? String(item.name) : "";
      var cells = [];
      if (Array.isArray(value)) {
        for (var d = 0; d < value.length; d++) {
          var axis = !cartesian ? null : d === 0 ? xAxis : d === 1 ? yAxis : null;
          cells.push(reportViewCell(reportCategoryCell(axis, value[d])));
        }
      } else if (cartesian && xAxis && xAxis.type === "category") {
        cells = [reportViewCell(reportCategoryCell(xAxis, i)), reportViewCell(value)];
      } else if (cartesian && yAxis && yAxis.type === "category") {
        cells = [reportViewCell(value), reportViewCell(reportCategoryCell(yAxis, i))];
      } else {
        cells = [reportViewCell(value)];
      }
      keep(seriesName, itemName, cells);
    }
  }
  var columns = ["Series"];
  if (named) {
    columns.push("Name");
  }
  for (var c = 0; c < width; c++) {
    columns.push(heads !== null && c < heads.length ? heads[c] : c === 0 ? "Value" : "Value " + (c + 1));
  }
  var shaped = [];
  for (var r = 0; r < rows.length; r++) {
    var row = named ? rows[r].slice(0) : [rows[r][0]].concat(rows[r].slice(2));
    while (row.length < columns.length) {
      row.push("");
    }
    shaped.push(row);
  }
  return { columns: columns, rows: shaped, total: total };
}
function reportDataViewContent(option) {
  var view = reportDataViewRows(option, ${DATA_VIEW_ROW_LIMIT});
  var root = document.createElement("div");
  root.className = "report-data-view";
  if (view.total > view.rows.length) {
    var note = document.createElement("p");
    note.className = "report-data-view-note";
    note.textContent = "The view shows the first " + view.rows.length.toLocaleString("en-US") + " of " + view.total.toLocaleString("en-US") + " rows.";
    root.appendChild(note);
  }
  var table = document.createElement("table");
  var head = document.createElement("thead");
  var headRow = document.createElement("tr");
  for (var c = 0; c < view.columns.length; c++) {
    var th = document.createElement("th");
    th.textContent = view.columns[c];
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  var body = document.createElement("tbody");
  for (var r = 0; r < view.rows.length; r++) {
    var tr = document.createElement("tr");
    for (var k = 0; k < view.rows[r].length; k++) {
      var td = document.createElement("td");
      td.textContent = view.rows[r][k];
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  root.appendChild(table);
  return root;
}
var reportToolboxFunctions = { ${TOOLBOX_PAGE_FUNCTIONS.map((name) => `${name}: ${name}`).join(", ")} };
function reportBindToolbox(option) {
  var toolbox = option.toolbox;
  var features = toolbox && typeof toolbox === "object" ? toolbox.feature : null;
  if (!features || typeof features !== "object") {
    return;
  }
  var members = ${JSON.stringify(TOOLBOX_FUNCTION_MEMBERS)};
  for (var name in features) {
    if (!Object.prototype.hasOwnProperty.call(features, name) || !features[name]) {
      continue;
    }
    for (var m = 0; m < members.length; m++) {
      var bound = features[name][members[m]];
      if (typeof bound !== "string") {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(reportToolboxFunctions, bound)) {
        features[name][members[m]] = reportToolboxFunctions[bound];
      } else {
        delete features[name][members[m]];
      }
    }
  }
}`;
