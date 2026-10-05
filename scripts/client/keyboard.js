// The keyboard shortcuts and the ⌘K palette.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
// ---- keyboard: j/k move from topic to topic, g twice sends (draft or go), e edits the draft, m writes to the session,
// c opens the card, o opens the thread, p snoozes 1 h, ? shows the help. Nothing while a field has the focus.
var HELP = tr("board.js.help");
document.addEventListener("keydown", function (ev) {
  var t = ev.target;
  if (ev.key === "Escape" && t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) { t.blur(); return; }
  if (ev.key === "Escape" && keysLocked) { keysLocked = false; flash(tr("board.js.keys.back")); return; }
  var openMenu = app.querySelector("details[data-menu][open]");
  if (ev.key === "Escape" && openMenu) { openMenu.open = false; return; }
  if (ev.key === "Escape" && !ev.defaultPrevented && (pinned || cursorKey)) { pinned = null; setCursor(null, false); redraw(true); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || (t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable))) return;
  if (keysLocked) {
    if (ev.key.length === 1) { ev.preventDefault(); flash(tr("board.js.keys.locked")); }
    return;
  }
  var list = rows();
  if (!list.length) return;
  var i = list.findIndex(function (r) { return r.getAttribute("data-key") === cursorKey; });
  var row = i >= 0 ? list[i] : null;
  var k = ev.key;
  if (k === "j" || k === "k") { ev.preventDefault(); var n = k === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1); select(list[n].getAttribute("data-key"), true); markSeen(list[n].getAttribute("data-key")); return; }
  if (k === "?") { ev.preventDefault(); flash(HELP); clearTimeout(timer); timer = setTimeout(function () { toast.hidden = true; }, 9000); return; }
  if (!row) return;
  var key = row.getAttribute("data-key");
  // g arms, a second g within 2 s sends: a single stray key never posts anything to Slack
  if (k === "g") {
    ev.preventDefault();
    var target = gTarget(row);
    if (!target) { flash(tr("board.js.gg.none")); return; }
    var gid = "g:" + key;
    if (gid in armed) { disarm(gid); target.click(); return; }
    arm(gid, "", 2000);
    var item = target.closest("[data-task-item]");
    flash(tr(target.hasAttribute("data-post") ? "board.js.gg.post" : "board.js.gg.go", { id: item ? item.getAttribute("data-task") : "", letter: row.getAttribute("data-letter") || "" }));
    return;
  }
  if (k === "e") { ev.preventDefault(); var eb2 = row.querySelector("[data-edit]"); if (eb2 && !folded(eb2)) eb2.click(); return; }
  if (k === "m") { ev.preventDefault(); setPanel("write-" + key, true); var ta2 = row.querySelector("form[data-send] textarea"); if (ta2) ta2.focus({ preventScroll: false }); return; }
  if (k === "c") { ev.preventDefault(); var cid = row.getAttribute("data-row"), cp = document.getElementById(cid); setPanel(cid, !cp || cp.hidden); return; }
  if (k === "o") { ev.preventDefault(); var a2 = row.querySelector("a[data-open]"); if (a2) a2.click(); return; }
  if (k === "p") { ev.preventDefault(); var sb = row.querySelector('[data-snooze="1h"]'); if (sb) sb.click(); return; }
});
// The ⌘K bar: a single field to find a topic (word, letter, Slack or tracker link, closed ones included) or to write
// to the master (question, link to sort, draft to write). The master's answer shows under the board's counter.
var palette = document.getElementById("palette");
var pin = palette.querySelector("input");
var plist = palette.querySelector("[data-palette-list]");
// pQuery: the input the shown results answer. An Enter typed before the search answers waits for that answer (pEnter)
// instead of acting on the results of the previous input; pSending blocks a second Enter while sending to the master.
var pItems = [], pSel = 0, pTimer = null, pSeq = 0, pQuery = null, pEnter = false, pSending = false;
var STATUS = { working: tr("board.js.status.working"), preparing: tr("board.js.status.preparing"), gate: tr("board.js.status.gate"), waiting: tr("board.js.status.waiting"), closed: tr("board.js.status.closed") };
function openPalette() { palette.hidden = false; pin.value = ""; findP(); setTimeout(function () { pin.focus(); }, 0); }
function closePalette() { palette.hidden = true; pEnter = false; }
function findP() {
  clearTimeout(pTimer);
  var q = pin.value, seq = ++pSeq;
  pTimer = setTimeout(function () {
    fetch("/api/find?q=" + encodeURIComponent(q), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== pSeq) return;
      var t = q.trim();
      pItems = (d.hits || []).map(function (h) { return { type: "sujet", h: h }; });
      if (t) pItems.push({ type: "master", text: t, link: d.link && !(d.hits || []).length });
      pQuery = q;
      pSel = 0;
      paintP();
      if (pEnter) { pEnter = false; runP(pSel); }
    }).catch(function () { if (seq === pSeq && pEnter) { pEnter = false; flash(tr("board.js.search.failed")); } });
  }, 80);
}
function paintP() {
  if (!pItems.length) { plist.innerHTML = '<li class="px-3 py-2 text-[13.5px] text-muted">' + esc(tr("board.js.search.empty")) + '</li>'; return; }
  plist.innerHTML = pItems.map(function (it, i) {
    var on = i === pSel ? " bg-soft" : "";
    if (it.type === "master") {
      var label = it.link ? esc(tr("board.js.search.linkToMaster")) : esc(tr("board.js.search.askMaster", { text: it.text.length > 90 ? it.text.slice(0, 89) + "…" : it.text }));
      return '<li><button type="button" data-pi="' + i + '" class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] text-ink hover:bg-soft' + on + '"><span class="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-soft px-1 text-[12.5px] font-semibold">↵</span><span class="min-w-0 truncate">' + label + '</span></button></li>';
    }
    var h = it.h;
    return '<li><button type="button" data-pi="' + i + '" class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-soft' + on + '"><span class="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[12.5px] font-semibold ' + (h.open ? "text-ink" : "text-muted") + '">' + esc(h.letter) + '</span><span class="min-w-0 flex-1 truncate text-[13.5px] ' + (h.open ? "text-ink" : "text-muted") + '">' + esc(h.title) + '</span><span class="shrink-0 text-[12.5px] text-muted">' + esc((STATUS[h.status] || h.status) + " · " + h.asker + " · " + h.channel) + '</span></button></li>';
  }).join("");
  var sel = plist.querySelector('[data-pi="' + pSel + '"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}
function runP(i) {
  var it = pItems[i];
  if (!it) return;
  if (it.type === "master") {
    if (pSending) return;
    // the text is reread from the field at send time, not taken from the last search's results
    var typed = pin.value.trim() || it.text;
    var text = it.link ? tr("board.js.master.isItOurs", { text: typed }) : typed;
    pSending = true;
    post("/api/master", { text: text }).then(function (x) {
      pSending = false;
      flash(x.ok ? tr("board.js.master.delivered") : tr("board.js.request.failed", { error: x.error }));
      if (x.ok) { closePalette(); redraw(true); }
    });
    return;
  }
  closePalette();
  var key = it.h.key;
  if (it.h.open && rowOf(key)) { select(key, false); rowOf(key).scrollIntoView({ block: "center", behavior: "smooth" }); markSeen(key); return; }
  var paused = document.getElementById("paused");
  if (it.h.open && paused) { paused.open = true; paused.scrollIntoView({ block: "center", behavior: "smooth" }); flash(tr("board.js.search.paused", { letter: it.h.letter })); return; }
  window.open("/?sujet=" + encodeURIComponent(key), "_blank", "noopener");
}
pin.addEventListener("input", findP);
pin.addEventListener("keydown", function (ev) {
  if (ev.key === "ArrowDown") { ev.preventDefault(); pSel = Math.min(pItems.length - 1, pSel + 1); paintP(); return; }
  if (ev.key === "ArrowUp") { ev.preventDefault(); pSel = Math.max(0, pSel - 1); paintP(); return; }
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (pSending || pEnter) return;
    if (pin.value !== pQuery) { pEnter = true; findP(); return; }
    runP(pSel);
    return;
  }
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePalette(); }
});
plist.addEventListener("click", function (ev) { var b = ev.target instanceof Element ? ev.target.closest("[data-pi]") : null; if (b) runP(Number(b.getAttribute("data-pi"))); });
palette.addEventListener("click", function (ev) { if (ev.target === palette) closePalette(); });
document.addEventListener("keydown", function (ev) {
  var t = ev.target;
  var inField = t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "K")) { ev.preventDefault(); if (palette.hidden) openPalette(); else closePalette(); return; }
  if (ev.key === "/" && !inField && palette.hidden && !keysLocked) { ev.preventDefault(); openPalette(); }
}, true);
document.addEventListener("click", function (ev) { if (ev.target instanceof Element && ev.target.closest("[data-palette-open]")) { ev.preventDefault(); openPalette(); } });
