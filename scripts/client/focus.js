// The focus mode: the list on the left, the detail of the selected topic in the centre, the drawer on the right.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
var focusMode = document.body.getAttribute("data-mode") === "focus";
// the topic acted on last (Send, Go, Approve, Done, an instruction): j or k then goes to the next one waiting on you
var acted = null;
var shownDetail = null;
function noteActed(key) { if (focusMode && key) acted = key; }
function detailOf(key) { var d = null; app.querySelectorAll("[data-detail]").forEach(function (x) { if (x.getAttribute("data-key") === key) d = x; }); return d; }
/** Where a row's actions live: its detail (the focus mode's, or the flow mode's sheet), else the card itself. */
function cardEl(row) { return (row && detailOf(row.getAttribute("data-key"))) || row; }
/** The selection drives the detail: only the selected topic's is shown, and the page comes back to its top. */
function paintFocus() {
  if (!focusMode) return;
  rows().forEach(function (r) { r.setAttribute("aria-selected", r.getAttribute("data-key") === cursorKey ? "true" : "false"); });
  var d = cursorKey && detailOf(cursorKey);
  app.querySelectorAll("[data-detail]").forEach(function (x) { x.hidden = x !== d; });
  if (!d || shownDetail === cursorKey) return;
  shownDetail = cursorKey;
  var nav = document.querySelector("nav"), top = d.getBoundingClientRect().top - (nav ? nav.offsetHeight : 0);
  if (top < 0) window.scrollTo(0, Math.max(0, window.scrollY + top - 20));
}
/** Nothing selected (first load, the topic closed): the detail the server rendered, else the first row. */
function focusDefault() {
  if (!focusMode || (cursorKey && rowOf(cursorKey))) return;
  var d = app.querySelector("[data-detail]:not([hidden])"), first = rows()[0];
  var key = d ? d.getAttribute("data-key") : first ? first.getAttribute("data-key") : null;
  if (key && rowOf(key)) setCursor(key, false); else paintFocus();
}
/**
 * After an action on the selected topic, j and k skip to the next row waiting on you (below for j, above for k, around
 * the list), instead of a neighbour: the topic acted on stays pinned in place, and is no longer what waits.
 */
function nextWaiting(dir) {
  var was = acted;
  acted = null;
  if (!focusMode || !was || was !== cursorKey) return null;
  var all = rows(), at = all.indexOf(rowOf(cursorKey));
  var waiting = Array.prototype.filter.call(app.querySelectorAll("#bloc-attend [data-row]"), function (r) { return r.getAttribute("data-key") !== was; });
  if (!waiting.length) return null;
  var after = waiting.filter(function (r) { return dir > 0 ? all.indexOf(r) > at : all.indexOf(r) < at; });
  return after.length ? (dir > 0 ? after[0] : after[after.length - 1]) : dir > 0 ? waiting[0] : waiting[waiting.length - 1];
}
// "Open" on a list row: the topic is selected and that task unfolds in the detail, where its button acts
document.addEventListener("click", function (ev) {
  var b = ev.target instanceof Element ? ev.target.closest("[data-open-task]") : null;
  if (!b) return;
  ev.preventDefault();
  var key = b.getAttribute("data-key"), id = b.getAttribute("data-open-task");
  select(key, false);
  setPanel(id, true);
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
// the switch remembers the mode in this browser; the link itself carries it in the URL
document.addEventListener("click", function (ev) {
  var a = ev.target instanceof Element ? ev.target.closest("[data-mode-switch]") : null;
  if (a) remember("strato-mode", a.getAttribute("data-mode-switch"));
});
// the list sticks under the top bar, whose height changes when it wraps
function paintNavHeight() { var nav = document.querySelector("nav"); if (nav) document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px"); }
window.addEventListener("resize", paintNavHeight);
paintNavHeight();
