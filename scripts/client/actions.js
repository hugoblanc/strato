// Every data-* action of the page, whatever the mode: posts, drafts, gos, busy and armed buttons, snoozes.
// A part of the board's client script. The parts share one scope: board.ts (CLIENT) concatenates them in a fixed
// order inside one function, so a part may call what another declares. The first paint and the timers are in boot.js.
document.addEventListener("click", function (ev) {
  var el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;
  var refresh = el.closest("[data-refresh]");
  if (refresh) { ev.preventDefault(); redraw(true); return; }
  // the update: a first click arms, a second within 4 s starts it; the server answers at once and works in the
  // background, the top bar shows its progress, and the page reloads when the restarted server answers (onHello)
  var upd = el.closest("[data-update-apply]");
  if (upd) {
    ev.preventDefault(); ev.stopPropagation();
    if (!("update" in armed)) { arm("update", tr("board.js.update.confirm"), 4000); return; }
    disarm("update");
    runBusy(upd, tr("board.js.update.busy"), function () { return post("/api/update", {}).then(function (x) { flash(x.ok ? tr("board.js.update.started") : tr("board.js.update.failed", { error: x.error })); return refreshVersion(); }); });
    return;
  }
  var tog = el.closest("[data-toggle]");
  if (tog) {
    ev.preventDefault();
    var id = tog.getAttribute("data-toggle");
    var p = document.getElementById(id);
    setPanel(id, !p || p.hidden);
    return;
  }
  // a click on the line itself opens or closes its card; not on a link, a button, the form, a panel, or a text selection
  var row = el.closest("[data-row]");
  if (row && row.getAttribute("data-row") && !el.closest("a, button, textarea, input, form, details, [data-panel], [data-gocard], code") && !String(window.getSelection && window.getSelection()).length) {
    var cid = row.getAttribute("data-row");
    var cp = document.getElementById(cid);
    setPanel(cid, !cp || cp.hidden);
    return;
  }
  var a = el.closest("a[data-open]");
  if (!a) return;
  ev.preventDefault();
  post("/api/open", { url: a.href }).then(function (x) { if (!x.ok) flash(tr("board.js.openFailed", { error: x.error })); });
});
// ⌘↩ (or Ctrl+↩) in the message sends it
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey)) return;
  var t = ev.target instanceof HTMLTextAreaElement ? ev.target : null;
  var form = t && t.closest("form[data-send]");
  if (!form) return;
  ev.preventDefault();
  form.requestSubmit();
});
// the sends in progress and the last feedback per topic: the page redraws during the 10 to 15 s of a send,
// and the form held in hand is then no longer the one on screen
var sending = {};
var lastStatus = {};
function paintSending(form, text) {
  form.querySelector("textarea").value = text;
  form.querySelector("button[type=submit]").disabled = true;
  form.querySelector("[data-status]").textContent = tr("board.js.sending");
}
function formFor(key) { return app.querySelector('form[data-send][data-key="' + key.replace(/"/g, '\\"') + '"]'); }
// ---- pasting an image (⌘V or Ctrl V) into the message field: the server keeps it for the topic, and a short label
// "[image 1]" goes into the text; on send it becomes "[image: <path>]", which the session reads with the Read tool.
// A text paste is left alone.
var uploading = {};
/** Per topic: label number -> path of the image on disk. */
var pasted = {};
function expandImages(key, text) {
  var m = pasted[key] || {};
  return text.replace(/\[image (\d+)\]/g, function (all, n) { return m[n] ? tr("board.js.image.ref", { path: m[n] }) : all; });
}
document.addEventListener("paste", function (ev) {
  var t = ev.target;
  var form = t instanceof HTMLTextAreaElement ? t.closest("form[data-send]") : null;
  if (!form || !ev.clipboardData) return;
  var files = [];
  for (var i = 0; i < ev.clipboardData.items.length; i++) {
    var it = ev.clipboardData.items[i];
    if (it.kind === "file" && it.type.indexOf("image/") === 0) { var f = it.getAsFile(); if (f) files.push(f); }
  }
  if (!files.length) return;
  ev.preventDefault();
  var key = form.getAttribute("data-key");
  files.forEach(function (file) {
    uploading[key] = (uploading[key] || 0) + 1;
    var status = form.querySelector("[data-status]");
    if (status) status.textContent = tr("board.js.image.uploading");
    form.querySelector("button[type=submit]").disabled = true;
    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result).replace(/^data:[^,]*,/, "");
      post("/api/paste-image", { key: key, type: file.type, data: data }).then(function (x) {
        uploading[key]--;
        var f2 = formFor(key);
        if (!f2) return;
        var ta = f2.querySelector("textarea");
        if (x.ok) {
          var m = pasted[key] || (pasted[key] = {});
          var n = Object.keys(m).length + 1;
          m[n] = x.d.path;
          var ins = "[image " + n + "]";
          var at = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
          var before = ta.value.slice(0, at), after = ta.value.slice(ta.selectionEnd == null ? at : ta.selectionEnd);
          var sep = before && !/\s$/.test(before) ? " " : "";
          ta.value = before + sep + ins + (after && !/^\s/.test(after) ? " " : "") + after;
          var pos = (before + sep + ins).length;
          ta.setSelectionRange(pos, pos);
        } else flash(tr("board.js.image.failed", { error: x.error }));
        if (x.ok) flash(tr("board.js.image.attached"));
        var st = f2.querySelector("[data-status]");
        if (st) st.textContent = "";
        if (!uploading[key]) f2.querySelector("button[type=submit]").disabled = false;
      });
    };
    reader.onerror = function () { uploading[key]--; flash(tr("board.js.image.unreadable")); };
    reader.readAsDataURL(file);
  });
});
document.addEventListener("submit", function (ev) {
  var form = ev.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-send")) return;
  ev.preventDefault();
  var key = form.getAttribute("data-key");
  var text = expandImages(key, form.querySelector("textarea").value.trim());
  if (!text || key in sending) return;
  // a "go" typed or clicked (chip) follows the same rule as the Go button: one per version of the card
  var isGo = isGoText(text);
  if (isGo && (key + "#") in goLock) { flash(tr("board.js.go.already")); return; }
  if (isGo) lockGo(key + "#");
  sending[key] = text;
  noteActed(key);
  paintSending(form, text);
  post("/api/send", { key: key, text: text })
    .then(function (x) { return { ok: x.ok, text: x.ok ? (x.d.note || tr("board.js.delivered")) : tr("board.js.notDelivered", { error: x.error }) }; })
    .then(function (r) {
      delete sending[key];
      lastStatus[key] = r.text;
      if (!r.ok) flash(r.text);
      if (isGo) goDelivered(key + "#", r.ok);
      var f = formFor(key);
      if (!f) return;
      f.querySelector("button[type=submit]").disabled = false;
      f.querySelector("[data-status]").textContent = r.text;
      // delivered: the field empties (and its images with it); refused: the text stays to fix or retry
      if (r.ok) delete pasted[key];
      f.querySelector("textarea").value = r.ok ? "" : text;
    });
});
// the feedback of a session action (terminal, stop, close, iTerm2) goes on its card's tools row
function sessionStatusOf(b) { var r = b.closest("[data-row],[data-detail]"); return r && r.querySelector("[data-session-status]"); }
// A button inside a folded panel (a task's body not opened) never acts: one click acts only on what is on screen.
function folded(b) { return !!(b && b.closest("[data-panel][hidden],[data-detail][hidden]")); }
// the "…" menus close when the click lands elsewhere
document.addEventListener("click", function (ev) {
  var el = ev.target instanceof Element ? ev.target : null;
  app.querySelectorAll("details[data-menu][open]").forEach(function (d) { if (!el || !d.contains(el)) d.open = false; });
}, true);
// a toggle drawn as a line (a task's head) opens with Enter or Space, like a button
document.addEventListener("keydown", function (ev) {
  var t = ev.target;
  if ((ev.key !== "Enter" && ev.key !== " ") || !(t instanceof HTMLElement) || t.getAttribute("role") !== "button" || !t.hasAttribute("data-toggle")) return;
  ev.preventDefault();
  t.click();
});
document.addEventListener("click", function (ev) {
  var el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;
  // stop, close or settle (close and ✅ on the original message): a first click arms the button ("Sure?"), a second
  // within 4 s runs it
  var confirm = el.closest("[data-confirm]");
  if (confirm) {
    ev.preventDefault();
    var action = confirm.getAttribute("data-confirm");
    var ckey = confirm.getAttribute("data-key");
    var st3 = sessionStatusOf(confirm);
    var cid2 = busyIdOf(confirm);
    var closing = action === "close" || action === "settle";
    if (!(cid2 in armed)) { arm(cid2, tr(action === "settle" ? "board.js.settle.confirm" : closing ? "board.js.close.confirm" : "board.js.stop.confirm"), 4000); return; }
    disarm(cid2);
    runBusy(confirm, tr(closing ? "board.js.close.busy" : "board.js.stop.busy"), function () {
      return post(closing ? "/api/close" : "/api/stop", closing ? { key: ckey, settled: action === "settle" } : { key: ckey })
        .then(function (x) {
          lastStatus[ckey] = x.ok ? x.d.note : x.error;
          if (!x.ok) flash(tr(closing ? "board.js.close.failed" : "board.js.stop.failed", { error: x.error }));
          // a closed topic leaves its card: the note (✅ added, shadow mode, ✅ not added) is shown where it stays seen
          else if (closing) flash(x.d.note);
          if (st3) st3.textContent = lastStatus[ckey];
          if (x.ok) removeTerm(ckey);
        });
    });
    return;
  }
  var dive = el.closest("[data-dive]");
  if (dive) {
    ev.preventDefault();
    var st2 = sessionStatusOf(dive);
    runBusy(dive, tr("board.js.opening"), function () {
      return post("/api/dive", { key: dive.getAttribute("data-dive") })
        .then(function (x) {
          if (!x.ok) flash(tr("board.js.dive.failed", { error: x.error }));
          if (st2) st2.textContent = x.ok ? x.d.note : x.error;
        });
    });
    return;
  }
  // Done or Drop on a task: a first click arms the button, a second within 4 s sends it
  var top = el.closest("[data-task-op]");
  if (top) {
    ev.preventDefault(); ev.stopPropagation();
    var op = top.getAttribute("data-task-op"), tkey = top.getAttribute("data-key"), tid = top.getAttribute("data-task");
    var oid = busyIdOf(top);
    if (!(oid in armed)) { arm(oid, tr(op === "done" ? "board.js.task.done.confirm" : "board.js.task.drop.confirm", { id: tid }), 4000); return; }
    disarm(oid);
    noteActed(tkey);
    runBusy(top, tr(op === "done" ? "board.js.task.done.busy" : "board.js.task.drop.busy"), function () {
      return post("/api/task", { key: tkey, taskId: tid, op: op === "done" ? "done" : "drop" }).then(function (x) {
        flash(x.ok ? x.d.note : tr("board.js.task.failed", { error: x.error }));
        return redraw(true);
      });
    });
    return;
  }
  var copy = el.closest("[data-copy]");
  if (copy) {
    ev.preventDefault();
    ev.stopPropagation();
    var box = copy.closest("[data-draft]");
    var bk = box && fidOf(box);
    // the raw text is copied (mentions <@U…> included), not the display: pasted into Slack, it still mentions
    var raw = box && box.querySelector("[data-draft-edit]");
    var value = bk && bk in editing ? editing[bk].text : raw ? raw.defaultValue : null;
    if (value && navigator.clipboard) navigator.clipboard.writeText(value).then(function () { flash(tr("board.js.copy.done")); }, function () { flash(tr("board.js.copy.refused")); });
    return;
  }
});
// ---- the draft: Send posts it from the server, on behalf of the person served, as shown (or as edited); Undo removes it
// the three maps are keyed by "<key>#<task>": two drafts of the same topic are edited and posted apart
var editing = {};   // fid -> { text: text being edited, base: raw draft text when the edit started }
var posting = {};   // fid -> "Sending…" during the call
var retrying = {};  // fid -> true when the last send may have gone out: Send becomes "Send again"
var postNote = {};  // fid -> last feedback (text + permalink + undoable until)
// the server renders data-retry when the task's last send may have gone out: a reloaded page still sends "again"
function retryOf(f, fid) { return fid in retrying || f.hasAttribute("data-retry"); }
// the draft's form on the card (the one that edits); a focus list row has its own preview form of the same draft
function draftForm(fid) { var f = null; app.querySelectorAll("form[data-draft]:not([data-preview])").forEach(function (x) { if (fidOf(x) === fid) f = x; }); return f; }
function draftForms(fid) { return Array.prototype.filter.call(app.querySelectorAll("form[data-draft]"), function (x) { return fidOf(x) === fid; }); }
function setEdit(f, on, value) {
  var ta = f.querySelector("[data-draft-edit]"), tx = f.querySelector("[data-draft-text]"), b = f.querySelector("[data-edit]"), p = f.querySelector("[data-post]");
  ta.hidden = !on; tx.hidden = on;
  b.textContent = tr(on ? "board.js.edit.cancel" : "board.js.edit");
  var pl = p && (p.querySelector("[data-label]") || p);
  if (p && !p.disabled) pl.textContent = tr(on ? "board.js.send.edited" : retryOf(f, fidOf(f)) ? "board.js.post.again" : "board.js.send");
  if (on && typeof value === "string") ta.value = value;
}
function paintPost(f, key) {
  var st = f.querySelector("[data-draft-status]"), p = f.querySelector("[data-post]");
  if (key in posting) { p.disabled = true; st.textContent = tr("board.js.sending"); return; }
  if (retryOf(f, key) && !p.disabled) { var rl = p.querySelector("[data-label]") || p; rl.textContent = tr("board.js.post.again"); }
  var n = postNote[key];
  if (!n) return;
  st.innerHTML = "";
  st.appendChild(document.createTextNode(n.text));
  if (n.url) { var a = document.createElement("a"); a.href = n.url; a.setAttribute("data-open", ""); a.className = "ml-1 text-link hover:underline"; a.textContent = tr("board.js.post.view"); st.appendChild(a); }
  if (n.undoUntil && Date.now() < n.undoUntil) { var u = document.createElement("button"); u.type = "button"; u.setAttribute("data-unpost", keyOfId(key)); u.setAttribute("data-task", key.slice(key.lastIndexOf("#") + 1)); u.setAttribute("data-undo-until", String(n.undoUntil)); u.className = "ml-2 font-medium text-warn hover:underline"; u.textContent = tr("board.js.undo", { n: Math.ceil((n.undoUntil - Date.now()) / 1000) }); st.appendChild(u); }
}
// The countdown of the Undo buttons, rendered by the server ("Draft posted" line) or by paintPost, and their removal
// when time is up: after 30 s, the server has told the session and can no longer remove the message.
function paintUndo() {
  app.querySelectorAll("[data-undo-until]").forEach(function (b) {
    if (b.getAttribute("aria-busy") === "true") return;
    var left = Math.ceil((Number(b.getAttribute("data-undo-until")) - Date.now()) / 1000);
    if (left <= 0) b.remove(); else b.textContent = tr("board.js.undo", { n: left });
  });
}
function restoreDrafts() {
  Object.keys(editing).forEach(function (k) { var f = draftForm(k); if (f) setEdit(f, true, editing[k].text); });
  Object.keys(posting).concat(Object.keys(postNote)).forEach(function (k) { draftForms(k).forEach(function (f) { paintPost(f, k); }); });
}
document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (!(t instanceof HTMLTextAreaElement) || !t.hasAttribute("data-draft-edit")) return;
  var k = fidOf(t.closest("form"));
  if (k in editing) editing[k].text = t.value; else editing[k] = { text: t.value, base: t.defaultValue };
});
// In the "just a go" queue, only the line under the cursor (or the first one) shows its whole draft (CSS .go-queue).
// A click on Send or Go of another line whose draft is cut unfolds it first, without sending anything: a text read
// halfway is not posted. Returns true if the line was unfolded.
function unfoldFirst(btn) {
  var row = btn.closest("[data-row]"), ul = row && row.parentElement, txt = row && row.querySelector("[data-draft-text]");
  if (!txt || !ul.classList.contains("go-queue") || row.hasAttribute("data-cursor")) return false;
  if (!ul.querySelector(":scope > li[data-cursor]") && ul.firstElementChild === row) return false;
  if (txt.scrollHeight <= txt.clientHeight + 1) return false;
  var key = row.getAttribute("data-key");
  select(key, true);
  markSeen(key);
  flash(tr(btn.hasAttribute("data-post") ? "board.js.unfold.send" : "board.js.unfold.go"));
  return true;
}
function postDraft(f) {
  var key = fidOf(f), topic = f.getAttribute("data-key"), task = f.getAttribute("data-task");
  if (key in posting || f.getAttribute("data-postable") !== "1") return;
  // a list row shows the draft as written: while the detail edits it, the row would post a text no longer on screen
  if (f.hasAttribute("data-preview") && key in editing) { flash(tr("board.js.focus.editing")); return; }
  noteActed(topic);
  // The server posts exactly the text sent here: the one shown, or its edited version. It also receives the raw draft
  // the person served decided on and its destination, and refuses (409, code draft-changed) if the card changed in
  // the meantime: posting the draft reread from disk could post a text a session rewrote after it was shown.
  var ta = f.querySelector("[data-draft-edit]"), ed = editing[key];
  // sha: the hash of the plan shown, which the gate checks; retry: the person was told the last send may have gone out
  var body = { key: topic, taskId: task, text: ed ? ed.text : ta.defaultValue, draft: ed ? ed.base : ta.defaultValue, draftTo: f.getAttribute("data-draft-to") || "", sha: f.getAttribute("data-sha") || "", retry: retryOf(f, key) };
  posting[key] = true;
  paintPost(f, key);
  post("/api/post-draft", body)
    .then(function (x) {
      delete posting[key];
      if (!x.ok && x.d.code === "draft-changed") {
        postNote[key] = { text: tr(ed ? "board.js.draft.changedWhileEditing" : "board.js.draft.changed") };
        flash(tr("board.js.draft.changedFlash"));
        redraw(true);
        return;
      }
      // the last send may have gone out: the person checks, then the same button sends again
      if (!x.ok && x.d.code === "unknown") retrying[key] = true;
      if (!x.ok) { postNote[key] = { text: tr("board.js.post.failedNote", { error: x.error }) }; flash(tr("board.js.post.failed", { error: x.error })); return; }
      delete retrying[key];
      delete editing[key];
      postNote[key] = { text: tr("board.js.post.done", { at: x.d.at }), url: x.d.permalink, undoUntil: Date.now() + x.d.undoMs };
      markSeen(topic);
      flash(tr("board.js.post.flash"));
      setTimeout(function () { draftForms(key).forEach(function (g) { paintPost(g, key); }); }, x.d.undoMs + 200);
    })
    .then(function () { draftForms(key).forEach(function (g) { g.querySelector("[data-post]").disabled = g.getAttribute("data-postable") !== "1"; paintPost(g, key); }); });
}
// The actions in progress, per button: a click greys the button and shows a spinner until the answer, and that
// survives the redraw. Otherwise the redraws during the 10 to 15 s of a delivery bring the Go button back active
// without a spinner, and each new click sends another "go" to the session.
var busy = {};
var BUSY_SEL = "[data-validate],[data-act-go],[data-update-apply],[data-ask-texts],[data-check],[data-revalidate],[data-revalidate-all],[data-go],[data-term],[data-dive],[data-confirm],[data-task-op],[data-revue],[data-unsnooze],[data-dismiss],[data-snooze],[data-unpost],form[data-snooze-date] button[type=submit]";
var SPIN = '<span class="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]" aria-hidden="true"></span>';
function busyIdOf(b) {
  if (b.hasAttribute("data-go")) return "go:" + goIdOf(b);
  if (b.hasAttribute("data-validate")) return "validate:" + b.getAttribute("data-key") + "#" + b.getAttribute("data-task");
  if (b.hasAttribute("data-act-go")) { var ab = b.closest("[data-actbox]"); return "act:" + (ab && ab.getAttribute("data-key")) + "#" + (ab && ab.getAttribute("data-task")); }
  if (b.hasAttribute("data-term")) return "term:" + b.getAttribute("data-term");
  if (b.hasAttribute("data-dive")) return "dive:" + b.getAttribute("data-dive");
  if (b.hasAttribute("data-confirm")) return b.getAttribute("data-confirm") + ":" + b.getAttribute("data-key");
  if (b.hasAttribute("data-task-op")) return "task-" + b.getAttribute("data-task-op") + ":" + fidOf(b);
  if (b.hasAttribute("data-revue")) return "revue";
  if (b.hasAttribute("data-update-apply")) return "update";
  if (b.hasAttribute("data-unsnooze")) return "unsnooze:" + b.getAttribute("data-unsnooze");
  if (b.hasAttribute("data-dismiss")) return "dismiss:" + b.getAttribute("data-dismiss");
  if (b.hasAttribute("data-ask-texts")) return "ask-texts:" + b.getAttribute("data-ask-texts");
  if (b.hasAttribute("data-check")) return "check:" + b.getAttribute("data-check");
  if (b.hasAttribute("data-revalidate")) return "revalidate:" + b.getAttribute("data-revalidate");
  if (b.hasAttribute("data-revalidate-all")) return "revalidate-all";
  if (b.hasAttribute("data-unpost")) return "unpost:" + b.getAttribute("data-unpost") + "#" + (b.getAttribute("data-task") || "");
  // the ready-made snoozes and the "until" form of the same topic share their lock
  if (b.hasAttribute("data-snooze")) return "snooze:" + b.getAttribute("data-key");
  var sf = b.closest("form[data-snooze-date]");
  if (sf) return "snooze:" + sf.getAttribute("data-key");
  return null;
}
function paintBusy() {
  document.querySelectorAll(BUSY_SEL).forEach(function (b) {
    var id = busyIdOf(b);
    if (id && id in busy) {
      if (!b.hasAttribute("data-idle")) b.setAttribute("data-idle", b.innerHTML);
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      b.innerHTML = SPIN + busy[id];
    } else if (b.hasAttribute("data-idle")) {
      b.innerHTML = b.getAttribute("data-idle");
      b.removeAttribute("data-idle");
      b.removeAttribute("aria-busy");
      b.disabled = false;
    }
  });
  // the feedback of the last go stays shown after a redraw
  app.querySelectorAll("[data-go]").forEach(function (b) {
    var k = goIdOf(b), st = b.parentElement.querySelector("[data-go-status]");
    if (st && !st.textContent && k in lastStatus) st.textContent = lastStatus[k];
  });
  paintGoLock();
}
// A delivered go is not sent again until the card has been rewritten: the Go button and the go chip stay greyed until
// the line's data-sig signature changes. runBusy alone only blocks during the request, and two clicks 700 ms apart
// would send two "go" to the session.
// keyed by "<key>#<task>" (a task's Go) or "<key>#" (a go written in the message box)
var goLock = {};  // id -> signature of the line when the go was delivered, or null during the delivery
function rowSig(id) { var r = rowOf(keyOfId(id)); return r ? r.getAttribute("data-sig") : null; }
function isGoText(t) { return /^go[.!]?$/i.test(String(t).trim()); }
function lockGo(key) { goLock[key] = null; paintGoLock(); }
function goDelivered(key, ok) {
  if (!ok) { delete goLock[key]; paintGoLock(); return; }
  // the answer can arrive before the redraw that carries the card rewritten by the server (session restarted, card
  // gone "working"): the page is reread before keeping the signature to get past
  redraw(true).then(function () { if (key in goLock) { goLock[key] = rowSig(key); paintGoLock(); } });
}
function paintGoLock() {
  Object.keys(goLock).forEach(function (k) { if (goLock[k] !== null && goLock[k] !== rowSig(k)) delete goLock[k]; });
  app.querySelectorAll("[data-go]").forEach(function (b) {
    if (b.getAttribute("aria-busy") === "true") return;
    var locked = goIdOf(b) in goLock;
    b.disabled = locked;
    if (locked) b.setAttribute("data-go-locked", ""); else b.removeAttribute("data-go-locked");
  });
  app.querySelectorAll("[data-validate]").forEach(function (b) {
    if (b.getAttribute("aria-busy") !== "true") b.disabled = (b.getAttribute("data-key") + "#" + b.getAttribute("data-task")) in goLock;
  });
  app.querySelectorAll("form[data-send]").forEach(function (f) {
    var locked = (f.getAttribute("data-key") + "#") in goLock;
    f.querySelectorAll("[data-chip]").forEach(function (c) { if (isGoText(c.getAttribute("data-chip"))) c.disabled = locked; });
  });
}
// The two-step buttons (Stop, Close, Drop): a first click arms ("Sure?"), a second within 4 s runs it. The armed state
// is kept by id and repainted after each render: kept in the button itself, a redraw between the two clicks would
// disarm it silently.
var armed = {};   // id (the one of busyIdOf) -> { label, token }
function arm(id, label, ms) {
  var token = {};
  armed[id] = { label: label, token: token };
  paintArmed();
  setTimeout(function () { if (armed[id] && armed[id].token === token) { delete armed[id]; paintArmed(); } }, ms);
}
function disarm(id) { delete armed[id]; paintArmed(); }
function paintArmed() {
  document.querySelectorAll("[data-confirm],[data-task-op],[data-update-apply]").forEach(function (b) {
    var id = busyIdOf(b);
    if (id && id in armed && !(id in busy)) {
      if (!b.hasAttribute("data-unarmed")) b.setAttribute("data-unarmed", b.textContent);
      b.textContent = armed[id].label;
      b.classList.add("bg-warn-soft", "text-warn");
    } else if (b.hasAttribute("data-unarmed")) {
      b.textContent = b.getAttribute("data-unarmed");
      b.removeAttribute("data-unarmed");
      b.classList.remove("bg-warn-soft", "text-warn");
    }
  });
  // g armed on the keyboard: the button the second g will press is ringed, and only it (the first ready task's)
  app.querySelectorAll("[data-row]").forEach(function (r) {
    var card = cardEl(r), on = ("g:" + r.getAttribute("data-key")) in armed, tgt = on ? gTarget(card) : null;
    card.querySelectorAll("[data-post],[data-go]").forEach(function (b) { ["ring-2", "ring-accent", "ring-offset-2", "ring-offset-bg"].forEach(function (c) { b.classList.toggle(c, b === tgt); }); });
  });
}
/** Runs the button's action once: while it runs, another click does nothing. */
function runBusy(btn, label, start) {
  var id = busyIdOf(btn);
  if (!id || id in busy) return;
  busy[id] = label;
  paintBusy();
  Promise.resolve().then(start)
    .catch(function (e) { flash(tr("board.js.unexpected", { error: e && e.message ? e.message : String(e) })); })
    .then(function () { delete busy[id]; paintBusy(); });
}
// taskId: the go names the task, the server tells the session which one
function sendText(key, text, statusEl, taskId) {
  if (statusEl) statusEl.textContent = tr("board.js.sending");
  return post("/api/send", taskId ? { key: key, text: text, taskId: taskId } : { key: key, text: text })
    .then(function (x) {
      var t = x.ok ? (x.d.note || tr("board.js.delivered")) : tr("board.js.notDelivered", { error: x.error });
      lastStatus[taskId ? key + "#" + taskId : key] = t;
      if (!x.ok) flash(t);
      if (statusEl) statusEl.textContent = t;
      return x.ok;
    });
}
function snoozeUntil(w) {
  var d = new Date();
  if (w === "1h") return new Date(d.getTime() + 3600e3);
  if (w === "pm") { d.setHours(14, 0, 0, 0); return d; }
  if (w === "eod") { d.setHours(17, 30, 0, 0); return d; }
  d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
}
function snoozeLabels() {
  var now = new Date();
  // the "until" form starts from tomorrow, and refuses a past date
  var ymd = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var tomorrow = new Date(now.getTime() + 86400e3);
  app.querySelectorAll("form[data-snooze-date] input[name=day]").forEach(function (i) { i.min = ymd(now); if (!i.value) i.value = ymd(tomorrow); });
  app.querySelectorAll("[data-snooze]").forEach(function (b) {
    var w = b.getAttribute("data-snooze"), u = snoozeUntil(w);
    var hm = String(u.getHours()).padStart(2, "0") + ":" + String(u.getMinutes()).padStart(2, "0");
    b.textContent = w === "1h" ? tr("board.js.snooze.1h", { time: hm }) : w === "pm" ? tr("board.js.snooze.pm") : w === "eod" ? tr("board.js.snooze.eod") : tr("board.js.snooze.tomorrow");
    b.hidden = u.getTime() <= now.getTime() + 15 * 60e3;
  });
}
document.addEventListener("submit", function (ev) {
  var f = ev.target instanceof Element ? ev.target.closest("form[data-snooze-date]") : null;
  if (!f) return;
  ev.preventDefault(); ev.stopPropagation();
  var day = f.elements.day.value, hour = f.elements.hour.value || "09:00";
  var until = new Date(day + "T" + hour);
  if (!day || isNaN(until.getTime()) || until.getTime() <= Date.now()) { flash(tr("board.js.snooze.pickFuture")); return; }
  var reason = f.elements.reason.value.trim();
  runBusy(f.querySelector("button[type=submit]"), tr("board.js.snooze.busy"), function () {
    return post("/api/snooze", { key: f.getAttribute("data-key"), until: until.toISOString(), reason: reason }).then(function (x) {
      flash(x.ok ? tr("board.js.snooze.untilDay", { day: until.toLocaleDateString(document.documentElement.lang || undefined, { weekday: "short", day: "2-digit", month: "2-digit" }), time: hour }) : tr("board.js.snooze.failed", { error: x.error }));
      return redraw(true);
    });
  });
}, true);
document.addEventListener("click", function (ev) {
  var el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;
  var pb = el.closest("[data-post]");
  if (pb) { ev.preventDefault(); ev.stopPropagation(); if (!folded(pb) && !unfoldFirst(pb)) postDraft(pb.closest("form[data-draft]")); return; }
  var eb = el.closest("[data-edit]");
  if (eb) {
    ev.preventDefault(); ev.stopPropagation();
    // the editor starts from the raw text rendered by the server (the textarea's defaultValue), not from the display:
    // the rendered textContent would lose the mentions <@U…>, the links <url|text> and the channels <#C…>
    var f = eb.closest("form[data-draft]"), k = fidOf(f), ta = f.querySelector("[data-draft-edit]");
    if (k in editing) { delete editing[k]; setEdit(f, false); ta.value = ta.defaultValue; }
    else { editing[k] = { text: ta.defaultValue, base: ta.defaultValue }; setEdit(f, true, editing[k].text); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return;
  }
  var exf = el.closest("[data-expand-for]");
  if (exf) { ev.preventDefault(); ev.stopPropagation(); var xt = document.getElementById(exf.getAttribute("data-expand-for")); if (xt) xt.classList.toggle(xt.getAttribute("data-expand") || "line-clamp-4"); return; }
  var ex = el.closest("[data-expand]");
  if (ex) { ev.stopPropagation(); ex.classList.toggle(ex.getAttribute("data-expand") || "line-clamp-4"); return; }
  // Approve: "go: <the proposal shown>" to the session, as the instruction form would; one per version of the card
  var va = el.closest("[data-validate]");
  if (va) {
    ev.preventDefault(); ev.stopPropagation();
    var vid = va.getAttribute("data-key") + "#" + va.getAttribute("data-task");
    if (vid in goLock || folded(va)) return;
    lockGo(vid);
    noteActed(va.getAttribute("data-key"));
    runBusy(va, tr("board.js.go.busy"), function () {
      return sendText(va.getAttribute("data-key"), va.getAttribute("data-msg"), va.parentElement.querySelector("[data-go-status]")).then(function (ok) { goDelivered(vid, ok); });
    });
    return;
  }
  var wo = el.closest("[data-write-open]");
  if (wo) {
    ev.preventDefault(); ev.stopPropagation();
    var wk = wo.getAttribute("data-write-open");
    setPanel("write-" + wk, true);
    var wf = formFor(wk), wta = wf && wf.querySelector("textarea");
    if (wta) wta.focus({ preventScroll: false });
    return;
  }
  var up = el.closest("[data-unpost]");
  if (up) {
    ev.preventDefault(); ev.stopPropagation();
    var uk = up.getAttribute("data-unpost"), ut = up.getAttribute("data-task"), ufid = uk + "#" + (ut || "");
    runBusy(up, tr("board.js.unpost.busy"), function () {
      return post("/api/unpost", { key: uk, taskId: ut }).then(function (x) {
        postNote[ufid] = { text: x.ok ? tr("board.js.unpost.done") : tr("board.js.unpost.failed", { error: x.error }) };
        flash(postNote[ufid].text);
        draftForms(ufid).forEach(function (g) { paintPost(g, ufid); });
        return redraw(true);
      });
    });
    return;
  }
  var ag = el.closest("[data-act-go]");
  if (ag) {
    ev.preventDefault(); ev.stopPropagation();
    // a status or an assignee on a ticket: the server acts through the gate, on the plan whose hash the page shows
    var box = ag.closest("[data-actbox]");
    if (folded(ag)) return;
    noteActed(box.getAttribute("data-key"));
    runBusy(ag, tr("board.js.act.busy"), function () {
      return post("/api/act-task", { key: box.getAttribute("data-key"), taskId: box.getAttribute("data-task"), sha: box.getAttribute("data-sha") || "", retry: box.hasAttribute("data-retry") }).then(function (x) {
        flash(x.ok ? tr("board.js.act.done") : tr("board.js.act.failed", { error: x.error }));
        return redraw(true);
      });
    });
    return;
  }
  var go = el.closest("[data-go]");
  if (go) {
    ev.preventDefault(); ev.stopPropagation();
    var gkey = go.getAttribute("data-go"), gtask = go.getAttribute("data-task"), gid = goIdOf(go);
    if (gid in goLock || folded(go) || unfoldFirst(go)) return;
    lockGo(gid);
    noteActed(gkey);
    runBusy(go, tr("board.js.go.busy"), function () {
      return sendText(gkey, "go", go.parentElement.querySelector("[data-go-status]"), gtask).then(function (ok) {
        var b2 = null;
        app.querySelectorAll("[data-go]").forEach(function (b) { if (goIdOf(b) === gid) b2 = b; });
        var st = b2 && b2.parentElement.querySelector("[data-go-status]");
        if (st) st.textContent = lastStatus[gid] || "";
        goDelivered(gid, ok);
      });
    });
    return;
  }
  var th = el.closest("[data-theme-toggle]");
  if (th) {
    // auto, then light, then dark: the choice stays in this browser
    var root = document.documentElement, cur = root.getAttribute("data-theme") || "auto";
    var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    if (next === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", next);
    try { if (next === "auto") localStorage.removeItem("aiguilleur-theme"); else localStorage.setItem("aiguilleur-theme", next); } catch (e) {}
    paintTheme();
    return;
  }
  // "Revalidate" (one card) and "Revalidate cards": data-revalidate, never data-refresh, which is the page's redraw
  // button at the top right
  var at = el.closest("[data-ask-texts]");
  if (at) {
    ev.preventDefault(); ev.stopPropagation();
    runBusy(at, "", function () {
      return post("/api/send", { key: at.getAttribute("data-ask-texts"), text: at.getAttribute("data-msg") }).then(function (x) {
        flash(x.ok ? (x.d.note || tr("board.js.askTexts.done")) : tr("board.js.askTexts.failed", { error: x.error }));
        return redraw(true);
      });
    });
    return;
  }
  var ck = el.closest("[data-check]");
  if (ck) {
    ev.preventDefault(); ev.stopPropagation();
    runBusy(ck, "", function () {
      return post("/api/check", { key: ck.getAttribute("data-check") }).then(function (x) {
        flash(x.ok ? tr("board.js.check.done") : tr("board.js.check.failed", { error: x.error }));
        return redraw(true);
      });
    });
    return;
  }
  var rf = el.closest("[data-revalidate],[data-revalidate-all]");
  if (rf) {
    ev.preventDefault(); ev.stopPropagation();
    var one = rf.getAttribute("data-revalidate");
    runBusy(rf, "", function () {
      return post("/api/refresh", one ? { key: one } : { all: true }).then(function (x) {
        flash(x.ok ? x.d.note : tr("board.js.refresh.failed", { error: x.error }));
        return redraw(true);
      });
    });
    return;
  }
  var dis = el.closest("[data-dismiss]");
  if (dis) {
    ev.preventDefault(); ev.stopPropagation();
    runBusy(dis, "", function () { return post("/api/master/dismiss", { id: dis.getAttribute("data-dismiss") }).then(function (x) { if (!x.ok) flash(tr("board.js.unpost.failed", { error: x.error })); return redraw(true); }); });
    return;
  }
  var chip = el.closest("[data-chip]");
  if (chip) {
    ev.preventDefault(); ev.stopPropagation();
    var form = chip.closest("form[data-send]");
    form.querySelector("textarea").value = chip.getAttribute("data-chip");
    form.requestSubmit();
    return;
  }
  var sz = el.closest("[data-snooze]");
  if (sz) {
    ev.preventDefault(); ev.stopPropagation();
    var until = snoozeUntil(sz.getAttribute("data-snooze"));
    runBusy(sz, tr("board.js.snooze.busy"), function () {
      return post("/api/snooze", { key: sz.getAttribute("data-key"), until: until.toISOString() }).then(function (x) { flash(x.ok ? tr("board.js.snooze.untilTime", { time: String(until.getHours()).padStart(2, "0") + ":" + String(until.getMinutes()).padStart(2, "0") }) : tr("board.js.snooze.failed", { error: x.error })); return redraw(true); });
    });
    return;
  }
  var un = el.closest("[data-unsnooze]");
  if (un) { ev.preventDefault(); runBusy(un, tr("board.js.unsnooze.busy"), function () { return post("/api/snooze", { key: un.getAttribute("data-unsnooze"), until: null }).then(function (x) { if (!x.ok) flash(tr("board.js.unsnooze.failed", { error: x.error })); return redraw(true); }); }); return; }
  if (el.closest("[data-snooze-menu] summary")) { snoozeLabels(); ev.stopPropagation(); return; }
  var jump = el.closest("[data-jump]");
  if (jump) { ev.preventDefault(); ev.stopPropagation(); select(jump.getAttribute("data-jump"), true); return; }
  var rv = el.closest("[data-revue]");
  if (rv) {
    ev.preventDefault(); ev.stopPropagation();
    runBusy(rv, tr("board.js.revue.busy"), function () { return post("/api/revue", { since: rv.getAttribute("data-revue") }).then(function (x) { flash(x.ok ? tr("board.js.revue.done") : tr("board.js.request.failed", { error: x.error })); return redraw(true); }); });
    return;
  }
}, true);
// what g g sends on a card: the primary button of its first ready task, in the order of the page (oldest first)
function gTarget(row) { var b = row.querySelector("[data-post]:not([disabled]),[data-go]:not([disabled]),[data-act-go]:not([disabled])"); return b && !folded(b) ? b : null; }
