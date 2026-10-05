// What runs once every part is loaded: the first paint, the timers, the stream.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
paintTheme();
// on load, the terminals already open on the server side take their place again
fetch("/api/terminals", { cache: "no-store" })
  .then(function (r) { return r.json(); })
  .then(function (d) { (d.terminals || []).forEach(addTerm); if (Object.keys(terms).length) { setDrawer(false); paintTabs(); } })
  .catch(function () {});
setInterval(paintUndo, 1000);
afterRender();
setInterval(paintSync, 5000);
restoreTyping();
connect();
setInterval(function () {
  var now = Date.now(), slept = now - lastTickAt > 20000;
  lastTickAt = now;
  if (now - lastBeat > 40000) { streamOk = false; paintSync(); }
  if (slept || now - lastBeat > 40000) connect();
}, 5000);
// relative ages are computed by the server: one redraw per minute keeps them right when nothing moves
setInterval(function () { if (!document.hidden) { redraw(true); refreshVersion(); } }, 60000);
// back on the tab or back online: redraw without waiting for the next event
document.addEventListener("visibilitychange", function () { if (!document.hidden) redraw(true); });
window.addEventListener("online", connect);
