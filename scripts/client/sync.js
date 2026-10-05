// The redraw by morphing, the pin, the selection, the stream of server events.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
// The board always redraws, including while the cursor is in a field: holding the redraw while a field had the focus
// froze the page after each send (the focus stays in the emptied field). Only an ongoing composition (accents, IME)
// postpones the redraw.
var composing = false, redrawPending = false;
document.addEventListener("compositionstart", function () { composing = true; });
document.addEventListener("compositionend", function () { composing = false; if (redrawPending) { redrawPending = false; redraw(true); } });
// When the field being typed in is gone after a redraw (topic closed, form folded, draft gone), the focus falls on the
// page, and the rest of the typing would turn into shortcuts ("ok go": k then g would post another topic's draft).
// The script then turns off one-letter shortcuts until the next click or Escape.
function activeField() {
  var a = document.activeElement;
  if (!a || !(a.tagName === "TEXTAREA" || a.tagName === "INPUT") || !app.contains(a)) return null;
  return { el: a, start: a.selectionStart, end: a.selectionEnd };
}
function keepField(st) {
  if (!st) return true;
  if (!st.el.isConnected) return false;
  // a node moved without moveBefore loses the focus: it is given back where the caret was
  if (document.activeElement !== st.el) { try { st.el.focus({ preventScroll: true }); st.el.setSelectionRange(st.start, st.end); } catch (e) {} }
  return document.activeElement === st.el;
}
var keysLocked = false;
function lockKeys() { keysLocked = true; }
// a click anywhere gives the shortcuts back: the user knows where they are again
document.addEventListener("pointerdown", function () { keysLocked = false; }, true);
// The pin: the card the person is working on (selected or acted on), with the block and the index where they saw it.
// The server keeps it there while the pin holds, so their own action (Go, Done, a message) does not send it to
// another block under their eyes. Moving to another card, Escape, or two minutes without interaction release it.
var pinned = null, lastTouch = Date.now(), PIN_MS = 120000, PIN_BLOCS = ["attend", "revoir", "travail", "attente"];
["pointerdown", "keydown", "input"].forEach(function (t) { document.addEventListener(t, function () { lastTouch = Date.now(); }, true); });
function pinTo(key) {
  var r = key && rowOf(key), sec = r && r.closest("section[id^='bloc-']"), bloc = sec && sec.id.slice(5);
  pinned = bloc && PIN_BLOCS.indexOf(bloc) >= 0 ? { key: key, bloc: bloc, index: Array.prototype.indexOf.call(sec.querySelectorAll("[data-row]"), r), quick: !!r.closest("ul[data-quick]") || r.hasAttribute("data-quick") } : null;
}
function fragmentUrl() {
  if (pinned && Date.now() - lastTouch > PIN_MS) pinned = null;
  var q = [];
  if (pinned) q.push("pin=" + encodeURIComponent(pinned.key) + "&pinBloc=" + pinned.bloc + "&pinIndex=" + pinned.index + (pinned.quick ? "&pinQuick=1" : ""));
  // the focus mode asks for its layout and the topic it shows in the detail
  if (focusMode) q.push("mode=focus" + (cursorKey ? "&sel=" + encodeURIComponent(cursorKey) : ""));
  // the flow mode asks for the topic its sheet shows
  else if (sheetKey) q.push("sel=" + encodeURIComponent(sheetKey));
  return "/board/fragment" + (q.length ? "?" + q.join("&") : "");
}
// Morphing instead of replacing keeps the DOM identity of what did not change: the focused field, its caret, what the
// person typed, the open details and panels survive the redraw by construction. The attributes the page owns stay.
// A panel the person opened or folded is theirs; an untouched one follows the server, which opens a card's first
// task: when that task closes, the next one opens by itself.
var touched = {};
function owned(attr, el) {
  if (attr === "value") return (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && el.value !== el.defaultValue;
  if (attr === "open") return el.tagName === "DETAILS";
  if (attr === "hidden") return el.hasAttribute("data-panel") && el.id in touched;
  if (attr === "aria-expanded") return el.hasAttribute("data-toggle") && el.getAttribute("data-toggle") in touched;
  if (attr === "class") return el.hasAttribute("data-expand");
  return false;
}
function morph(html) {
  if (!window.Idiomorph) { app.innerHTML = html; return; }
  window.Idiomorph.morph(app, html, { morphStyle: "innerHTML", callbacks: { beforeAttributeUpdated: function (attr, el) { return !owned(attr, el); } } });
}
// Redraws leave in order but their answers can come back out of order: each request has its number, and an answer
// older than the last one applied is dropped, otherwise it would put back a stale state.
var drawSeq = 0, drawApplied = 0;
function redraw(keepScroll) {
  if (composing) { redrawPending = true; return Promise.resolve(); }
  redrawPending = false;
  var y = window.scrollY;
  var seq = ++drawSeq;
  return fetch(fragmentUrl(), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (html) {
      if (seq < drawApplied) return;
      drawApplied = seq;
      var field = activeField();
      morph(html);
      // what the page paints itself: a send in progress keeps its greyed button and its "Sending…", and the last
      // feedback of each topic stays under its field
      app.querySelectorAll("form[data-send]").forEach(function (f) {
        var k = f.getAttribute("data-key");
        if (k in sending) { paintSending(f, sending[k]); return; }
        if (k in lastStatus) f.querySelector("[data-status]").textContent = lastStatus[k];
      });
      restoreDrafts();
      if (!keepField(field)) lockKeys();
      afterRender();
      if (keepScroll) window.scrollTo(0, y);
    })
    .catch(function () { flash(tr("board.js.serverDown")); });
}
// a panel (card, context, message) opens with its button; the button's state follows the panel
function setPanel(id, open) {
  var p = document.getElementById(id);
  if (!p) return;
  touched[id] = true;
  p.hidden = !open;
  app.querySelectorAll('[data-toggle="' + id + '"]').forEach(function (b) { b.setAttribute("aria-expanded", open ? "true" : "false"); });
}
// ---- "new since your last visit": the page remembers what you saw when leaving (tab hidden or closed)
var SEEN = "aiguilleur.seen";
function readSeen() { try { return JSON.parse(localStorage.getItem(SEEN) || "null"); } catch (e) { return null; } }
function writeSeen(v) { try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch (e) {} }
var seenAtLoad = readSeen();
function snapshot() { var v = {}; app.querySelectorAll("[data-row][data-sig]").forEach(function (r) { v[r.getAttribute("data-key")] = r.getAttribute("data-sig"); }); return v; }
function markSeen(key) { if (!seenAtLoad) return; var r = rowOf(key); if (r) { seenAtLoad[key] = r.getAttribute("data-sig"); paintNew(); } }
function paintNew() {
  app.querySelectorAll("[data-row][data-sig]").forEach(function (r) {
    var b = r.querySelector("[data-new]");
    if (b) b.hidden = !seenAtLoad || seenAtLoad[r.getAttribute("data-key")] === r.getAttribute("data-sig");
  });
}
document.addEventListener("visibilitychange", function () { if (document.hidden) { seenAtLoad = snapshot(); writeSeen(seenAtLoad); } });
window.addEventListener("pagehide", function () { writeSeen(snapshot()); });
app.addEventListener("click", function (ev) { var r = ev.target instanceof Element && ev.target.closest("[data-row]"); if (r) markSeen(r.getAttribute("data-key")); });

// ---- counter in the tab's title and lit favicon when something waits on you
function paintTitle() {
  var v = app.querySelector("[data-view=board]");
  var n = v ? Number(v.getAttribute("data-attend") || 0) : 0;
  document.title = n ? "(" + n + ") Strato" : "Strato";
  var fav = document.getElementById("favicon");
  if (fav) fav.href = fav.getAttribute(n ? "data-on" : "data-off");
}
var cursorKey = null;
function rowOf(key) { var r = null; app.querySelectorAll("[data-row]").forEach(function (x) { if (x.getAttribute("data-key") === key) r = x; }); return r; }
function rows() { return Array.prototype.slice.call(app.querySelectorAll("[data-row]")); }
function setCursor(key, scroll) {
  rows().forEach(function (r) { r.removeAttribute("data-cursor"); });
  cursorKey = key;
  var r = key && rowOf(key);
  if (!r) { cursorKey = null; paintFocus(); return; }
  r.setAttribute("data-cursor", "");
  if (scroll) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
  paintFocus();
}
/** The person moves to a card: it becomes the cursor and the pin, which releases the previous one. */
function select(key, scroll) { setCursor(key, scroll); pinTo(cursorKey); }
// on pointerdown, not click: the action buttons stop the click before it reaches the card, and the card they act on
// must be pinned before their request leaves
app.addEventListener("pointerdown", function (ev) { var r = ev.target instanceof Element && ev.target.closest("[data-row]"); if (r) select(r.getAttribute("data-key"), false); }, true);
function afterRender() {
  paintBusy();
  paintArmed();
  paintUndo();
  paintSync();
  paintNew();
  paintTitle();
  if (cursorKey) setCursor(cursorKey, false);
  focusDefault();
  paintSheet();
  if (pinned && !rowOf(pinned.key)) pinned = null;
}
// The top bar's pill: the state of Strato and of the board, repainted every 5 s without waiting for a redraw.
// Red if the server's stream is cut, or if the Slack listener missed three heartbeats; amber if Slack no longer
// delivers live or if the last catch-up failed; green otherwise, with the time of the last heartbeat.
var streamOk = true;
function hhmm(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function paintSync() {
  var pill = document.getElementById("sync-pill"), data = app.querySelector("[data-sync]");
  if (!pill || !data) return;
  var n = function (k) { return Number(data.getAttribute("data-" + k)) || 0; };
  var now = Date.now(), tick = n("tick"), beat = n("beat") || 300000, ev = n("event"), synced = n("synced"), failed = n("failed");
  var tone, label, tip = [];
  if (tick) tip.push(tr("board.js.sync.tip.tick", { time: hhmm(tick) }));
  if (ev) tip.push(tr("board.js.sync.tip.event", { time: hhmm(ev) }));
  if (synced) tip.push(tr("board.js.sync.tip.synced", { time: hhmm(synced) }));
  if (streamOk === false) { tone = "red"; label = tr("board.js.sync.disconnected"); tip.unshift(tr("board.js.sync.disconnected.tip")); }
  else if (!tick || now - tick > 3 * beat + 30000) { tone = "red"; label = tick ? tr("board.js.sync.silent", { time: hhmm(tick) }) : tr("board.js.sync.stopped"); tip.unshift(tr("board.js.sync.silent.tip")); }
  else if (data.getAttribute("data-deaf")) { tone = "amber"; label = tr("board.js.sync.deaf"); tip.unshift(tr("board.js.sync.deaf.tip")); }
  else if (failed && failed > synced) { tone = "amber"; label = tr("board.js.sync.failed"); tip.unshift(tr("board.js.sync.failed.tip", { time: hhmm(failed) })); }
  else { tone = "green"; label = tr("board.js.sync.ok", { time: hhmm(tick) }); }
  pill.querySelector(".lamp").className = "lamp lamp-" + tone + " lit";
  pill.querySelector("[data-sync-label]").textContent = label;
  pill.className = "inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[12.5px] " + (tone === "red" ? "border-warn/50 text-warn" : tone === "amber" ? "border-accent/50 text-accent-ink" : "border-line text-muted");
  pill.title = tip.join("\n");
}
// SSE stream. After the Mac sleeps, the previous connection is half open: neither error nor message, and the page
// stays frozen. The server sends a "ping" every 15 s; 40 s without anything, or a clock jump, and the page reopens
// the stream then redraws, because everything that changed during the gap is lost.
var events = null, lastBeat = Date.now(), lastTickAt = Date.now();
// A restarted server serves a new script, which the open page does not have. The hello event carries the server's
// version, "<boot>.<focus>"; only the boot part counts, the iTerm2 focus changes without a restart. When it changes,
// the page reloads, after setting aside in sessionStorage what was being typed (messages to sessions, drafts being
// edited), which the next load puts back.
var bootSeen = null, RELOAD_KEY = "aiguilleur.reload";
function saveTyping() {
  var st = { send: {}, editing: editing, cursor: cursorKey, y: window.scrollY };
  app.querySelectorAll("form[data-send]").forEach(function (f) { var t = f.querySelector("textarea"); if (t && t.value) st.send[f.getAttribute("data-key")] = t.value; });
  try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify(st)); } catch (e) {}
}
function restoreTyping() {
  var st = null;
  try { st = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || "null"); sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
  if (!st) return;
  Object.keys(st.editing || {}).forEach(function (k) { editing[k] = st.editing[k]; });
  restoreDrafts();
  Object.keys(st.send || {}).forEach(function (k) { var f = formFor(k); if (f) { setPanel("write-" + k, true); f.querySelector("textarea").value = st.send[k]; } });
  if (st.cursor) setCursor(st.cursor, false);
  if (st.y) window.scrollTo(0, st.y);
}
// The version and the update button live in the top bar, outside #app: the fragment does not redraw them.
// They are refetched on each board event and every minute; an open "what changed" panel stays open, including
// across the busy state (which has no panel), so that a failed update shows its reason where the click was made.
var updateOpen = false;
function refreshVersion() {
  var slot = document.getElementById("version-slot");
  if (!slot) return Promise.resolve();
  return fetch("/board/version", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (html) {
      var d = slot.querySelector("details");
      if (d) updateOpen = d.open;
      slot.innerHTML = html;
      var nd = slot.querySelector("details");
      if (nd && updateOpen) nd.open = true;
      paintBusy(); paintArmed();
    })
    .catch(function () {});
}
function onHello(e) {
  var v = "";
  try { v = JSON.parse(e.data).version || ""; } catch (x) {}
  var boot = String(v).split(".")[0];
  if (!boot) return;
  if (bootSeen === null) { bootSeen = boot; return; }
  if (boot !== bootSeen) { saveTyping(); location.reload(); }
}
function connect() {
  if (events) { try { events.close(); } catch (e) {} }
  lastBeat = Date.now();
  events = new EventSource("/events");
  events.addEventListener("open", function () { lastBeat = Date.now(); streamOk = true; redraw(true); });
  events.addEventListener("error", function () { streamOk = false; paintSync(); });
  events.addEventListener("hello", function (e) { lastBeat = Date.now(); onHello(e); });
  events.addEventListener("ping", function () { lastBeat = Date.now(); if (!streamOk) { streamOk = true; paintSync(); } });
  events.addEventListener("update", function () { lastBeat = Date.now(); redraw(true); });
  events.addEventListener("board", function () { lastBeat = Date.now(); redraw(true); refreshVersion(); });
  // a ttyd that dies (claude closed) removes its tab
  events.addEventListener("terminals", function (e) {
    lastBeat = Date.now();
    var open = JSON.parse(e.data).open || [];
    Object.keys(terms).forEach(function (k) { if (open.indexOf(k) < 0) removeTerm(k); });
  });
}
