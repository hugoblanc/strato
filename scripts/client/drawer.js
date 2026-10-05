// The terminal drawer: one ttyd per topic in an iframe outside #app, docked at the bottom or on the right.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
// ---- the terminal drawer: one ttyd per topic, in an iframe outside #app to survive the redraws
var drawer = document.getElementById("drawer");
var tabs = document.getElementById("drawer-tabs");
var body = document.getElementById("drawer-body");
var showBtn = document.getElementById("drawer-show");
// The drawer hides without display:none: a hidden terminal keeps its size. With display:none, xterm recomputed to zero
// columns, claude redrew in narrow columns, and reopening showed a garbled screen until a second resize.
function drawerOpen() { return !drawer.classList.contains("drawer-closed"); }
function setDrawer(open) { drawer.classList.toggle("drawer-closed", !open); drawer.setAttribute("aria-hidden", open ? "false" : "true"); paintDock(); }
// ---- where the drawer sits: "bottom" or "right", and its size, remembered per browser (a convenience, never required)
var dockPref = remembered("strato-dock") === "right" ? "right" : "bottom";
var dockBtn = drawer.querySelector("[data-drawer-dock]");
var root = document.documentElement;
["--dock-w", "--dock-h"].forEach(function (v) { var x = remembered("strato" + v); if (x) root.style.setProperty(v, x); });
// too narrow for two columns: the drawer goes back to the bottom without forgetting the choice
function dock() { return dockPref === "right" && window.innerWidth >= 900 ? "right" : "bottom"; }
function paintDock() {
  var d = dock();
  drawer.setAttribute("data-dock", d);
  if (drawerOpen()) document.body.setAttribute("data-split", d); else document.body.removeAttribute("data-split");
  var next = dockPref === "right" ? "toBottom" : "toRight";
  dockBtn.textContent = tr("board.js.dock." + next);
  dockBtn.title = tr("board.js.dock." + next + ".tip");
  dockBtn.hidden = window.innerWidth < 900;
}
window.addEventListener("resize", paintDock);
paintDock();
dockBtn.addEventListener("click", function () {
  dockPref = dockPref === "right" ? "bottom" : "right";
  remember("strato-dock", dockPref);
  paintDock();
});
// the grip: a drag on the drawer's inner edge sets its width (right) or its height (bottom)
document.getElementById("drawer-grip").addEventListener("pointerdown", function (ev) {
  ev.preventDefault();
  var right = dock() === "right";
  var v = right ? "--dock-w" : "--dock-h";
  var grip = ev.currentTarget;
  grip.setPointerCapture(ev.pointerId);
  document.body.setAttribute("data-resizing", "");
  function move(e) {
    var px = right ? window.innerWidth - e.clientX : window.innerHeight - e.clientY;
    var max = right ? window.innerWidth - 420 : window.innerHeight - 120;
    root.style.setProperty(v, Math.round(Math.max(right ? 360 : 240, Math.min(max, px))) + "px");
  }
  function up() {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    document.body.removeAttribute("data-resizing");
    remember("strato" + v, root.style.getPropertyValue(v));
  }
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
});
var terms = {};
var current = null;
function paintTabs() {
  var keys = Object.keys(terms);
  tabs.innerHTML = keys.map(function (k) {
    var t = terms[k];
    var on = k === current;
    return '<span class="inline-flex items-center gap-1 rounded-md ' + (on ? "bg-soft text-ink" : "text-muted hover:text-ink") + ' px-2 py-1 text-[12.5px] whitespace-nowrap">' +
      '<button type="button" data-tab="' + k + '" class="font-medium"><span class="mr-1.5 rounded bg-ink/10 px-1 font-semibold">' + t.letter + '</span>' + t.title.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }) + '</button>' +
      '<button type="button" data-tab-close="' + k + '" class="rounded px-1 text-muted hover:text-warn" title="' + esc(tr("board.js.terminal.close")) + '">×</button></span>';
  }).join("");
  var n = keys.length;
  showBtn.textContent = n ? (n === 1 ? tr("board.js.terminals.one") : tr("board.js.terminals.other", { n: n })) : "";
  showBtn.hidden = !n || drawerOpen();
  if (!n) { setDrawer(false); showBtn.hidden = true; }
}
function showTerm(k) {
  current = k;
  Object.keys(terms).forEach(function (o) { terms[o].frame.style.visibility = o === k ? "visible" : "hidden"; });
  setDrawer(true);
  paintTabs();
  var f = terms[k] && terms[k].frame;
  if (f) { try { f.contentWindow.focus(); } catch (e) {} }
}
function addTerm(t) {
  if (terms[t.key]) { showTerm(t.key); return; }
  var frame = document.createElement("iframe");
  frame.src = t.url;
  frame.title = t.letter + " · " + t.title;
  frame.className = "absolute inset-0 h-full w-full border-0";
  body.appendChild(frame);
  terms[t.key] = { letter: t.letter, title: t.title, url: t.url, frame: frame };
  showTerm(t.key);
}
function removeTerm(k) {
  var t = terms[k];
  if (!t) return;
  t.frame.remove();
  delete terms[k];
  if (current === k) { var rest = Object.keys(terms); current = rest[rest.length - 1] || null; }
  if (current) showTerm(current); else paintTabs();
}
document.addEventListener("click", function (ev) {
  var el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;
  var term = el.closest("[data-term]");
  if (term) {
    ev.preventDefault();
    var key = term.getAttribute("data-term");
    if (terms[key]) { showTerm(key); return; }
    var st = sessionStatusOf(term);
    runBusy(term, tr("board.js.opening"), function () {
      return post("/api/terminal", { key: key })
        .then(function (x) {
          if (x.ok) { addTerm(x.d); if (st) st.textContent = ""; return; }
          flash(tr("board.js.terminal.failed", { error: x.error }));
          if (st) st.textContent = x.error;
        });
    });
    return;
  }
  var tab = el.closest("[data-tab]");
  if (tab) { showTerm(tab.getAttribute("data-tab")); return; }
  var close = el.closest("[data-tab-close]");
  if (close) {
    var ck = close.getAttribute("data-tab-close");
    removeTerm(ck);
    post("/api/terminal/close", { key: ck }).then(function (x) { if (!x.ok) flash(tr("board.js.terminal.closeFailed", { error: x.error })); });
    return;
  }
  if (el.closest("[data-drawer-hide]")) { setDrawer(false); paintTabs(); return; }
  if (el.closest("[data-drawer-show]")) { setDrawer(true); paintTabs(); return; }
});
