// Shared helpers: the strings, the toast, the POSTs, escaping, per-browser memory.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
// the board.js.* strings of the profile's locale, written into the page by boardPage (core/i18n.ts)
var I18N = window.STRATO_I18N || {};
function tr(key, vars) {
  var text = I18N[key] || key;
  if (vars) Object.keys(vars).forEach(function (k) { text = text.split("{" + k + "}").join(String(vars[k])); });
  return text;
}
// A task element (draft form, Go button, Done/Drop) is identified by its topic and its task: "<key>#<task>".
function fidOf(el) { return el.getAttribute("data-key") + "#" + (el.getAttribute("data-task") || ""); }
function goIdOf(b) { return b.getAttribute("data-go") + "#" + (b.getAttribute("data-task") || ""); }
function keyOfId(id) { return id.slice(0, id.lastIndexOf("#")); }
var app = document.getElementById("app");
var toast = document.getElementById("toast");
var timer;
function flash(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(function () { toast.hidden = true; }, 3000);
}
function remembered(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function remember(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function paintTheme() {
  var t = document.documentElement.getAttribute("data-theme");
  var b = document.querySelector("[data-theme-toggle]");
  if (b) b.textContent = tr(t === "light" ? "board.js.theme.light" : t === "dark" ? "board.js.theme.dark" : "board.js.theme.auto");
}
// Every POST of the board goes through here. The promise always resolves { ok, status, d, error }: a network cut or
// an answer that is not JSON (error page, proxy) becomes a readable failure, never a swallowed exception.
function post(url, data) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
    .then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) {}
        if (!d || typeof d !== "object") return { ok: false, status: r.status, d: {}, error: tr("board.js.badResponse", { status: r.status }) };
        return { ok: r.ok, status: r.status, d: d, error: r.ok ? "" : (d.error || tr("board.js.httpFailed", { status: r.status })) };
      });
    })
    .catch(function () { return { ok: false, status: 0, d: {}, error: tr("board.js.serverDown") }; });
}
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
