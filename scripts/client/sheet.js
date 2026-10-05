// The flow mode's sheet: a topic's detail, the focus mode's own, sliding in from the left.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
// The server renders the sheet when the fragment asks for it (sel=<key>): it survives the redraws like any card, and
// its card in the list keeps only its first line, so each form and button exists once on the page.
var sheetKey = focusMode ? null : new URLSearchParams(location.search).get("sel");
var sheetShown = null;
function sheetEl() { return document.getElementById("sheet"); }
function sheetPanel() { var s = sheetEl(); return s && s.querySelector("[data-sheet-panel]"); }
// the URL carries the open sheet: a reload or a copied link opens it again
function paintSheetUrl() {
  try {
    var u = new URL(location.href);
    if (sheetKey) u.searchParams.set("sel", sheetKey); else u.searchParams.delete("sel");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  } catch (e) {}
}
function openSheet(key) {
  if (focusMode || !key) return;
  sheetKey = key;
  select(key, false);
  markSeen(key);
  paintSheetUrl();
  redraw(true);
}
// the focus goes back to the title that opened the sheet, re-read after the redraw that turned its card back
function returnFocus(key) {
  var a = null;
  app.querySelectorAll("[data-sheet-open]").forEach(function (x) { if (x.getAttribute("data-sheet-open") === key) a = x; });
  if (a) a.focus({ preventScroll: true });
}
function closeSheet() {
  var key = sheetKey, s = sheetEl();
  if (!key) return;
  sheetKey = null;
  paintSheetUrl();
  var done = function () { redraw(true).then(function () { returnFocus(key); }); };
  if (!s || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { if (s) s.remove(); done(); return; }
  s.setAttribute("data-closing", "");
  setTimeout(function () { if (s.isConnected && s.hasAttribute("data-closing")) s.remove(); done(); }, 160);
}
/** After each render: the sheet's topic gone (closed, snoozed), the sheet closes; newly shown, it takes the focus. */
function paintSheet() {
  var s = sheetEl();
  if (s && s.hasAttribute("data-closing")) return;
  if (sheetKey && !s) { var gone = sheetKey; sheetKey = null; sheetShown = null; paintSheetUrl(); document.body.removeAttribute("data-sheet"); returnFocus(gone); return; }
  if (!sheetKey) { sheetShown = null; document.body.removeAttribute("data-sheet"); return; }
  document.body.setAttribute("data-sheet", "");
  if (sheetShown === sheetKey) return;
  sheetShown = sheetKey;
  var p = sheetPanel();
  if (p) { p.scrollTop = 0; if (!p.contains(document.activeElement)) p.focus({ preventScroll: true }); }
}
// a click on a card's title opens its detail; ⌘, Ctrl, Shift or a middle click keep the link to the report
document.addEventListener("click", function (ev) {
  var a = ev.target instanceof Element ? ev.target.closest("[data-sheet-open]") : null;
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
  ev.preventDefault();
  openSheet(a.getAttribute("data-sheet-open"));
});
document.addEventListener("click", function (ev) {
  var c = ev.target instanceof Element ? ev.target.closest("[data-sheet-close]") : null;
  if (!c) return;
  ev.preventDefault();
  closeSheet();
});
// Tab and Shift-Tab stay in the sheet while it is open; a terminal docked beside it keeps its own focus
var FOCUSABLE = "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Tab" || !sheetKey) return;
  var p = sheetPanel(), drawer = document.getElementById("drawer");
  if (!p || (drawer && drawer.contains(document.activeElement)) || !palette.hidden) return;
  // what a closed menu holds still has boxes, but cannot take the focus: only its summary can
  var list = Array.prototype.filter.call(p.querySelectorAll(FOCUSABLE), function (x) { var d = x.closest("details:not([open])"); return x.getClientRects().length > 0 && !x.closest("[hidden]") && (!d || x.parentElement === d && x.tagName === "SUMMARY"); });
  if (!list.length) { ev.preventDefault(); p.focus(); return; }
  var first = list[0], last = list[list.length - 1], at = document.activeElement;
  if (!p.contains(at)) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); return; }
  if (ev.shiftKey && (at === first || at === p)) { ev.preventDefault(); last.focus(); return; }
  if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
});
