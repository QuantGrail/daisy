// Official CLI terminal page, served by the control plane as a fixed
// document (no interpolated data, no inline script) so it runs under the
// strict CSP. Non-secret parameters come from the query string; a Bearer
// token (non-host mode) arrives only by postMessage from the parent frame,
// which targets this origin. In host mode the gateway cookie authenticates.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var hex = function (v, d) {
    return /^#[0-9a-fA-F]{3,8}$/.test(v || "") ? v : d;
  };
  var colors = {
    bg: hex(q.get("bg"), "#101418"),
    ink: hex(q.get("ink"), "#e8ecef"),
    muted: hex(q.get("muted"), "#9aa4ad"),
    key: hex(q.get("key"), "#252b31"),
    "key-ink": hex(q.get("keyInk"), "#e8ecef"),
  };
  for (var k in colors)
    document.documentElement.style.setProperty("--" + k, colors[k]);
  var sid = q.get("sid") || "",
    jid = q.get("jid") || "";
  var base =
    location.origin +
    location.pathname.replace(/\/terminal-assets\/terminal\.html$/, "");
  var status = document.getElementById("status");
  // P6-23b (ADR-159): the page's words come from the language pack
  // (`server-app.terminal.*`, GET /api/locales): the language the frame
  // asks for (`lang`), else the owner's (/api/health), else the browser's.
  var lang = q.get("lang") || "";
  var texts = {};
  function tx(key, params) {
    var s = texts["server-app.terminal." + key];
    if (typeof s !== "string") return key;
    for (var p in params || {}) s = s.split("{" + p + "}").join(String(params[p]));
    return s;
  }
  async function loadTexts() {
    try {
      if (!lang) {
        var h = await fetch(base + "/api/health", { credentials: "same-origin" });
        lang = (h.ok && (await h.json()).language) || navigator.language || "en";
      }
      var r = await fetch(base + "/api/locales/" + encodeURIComponent(lang) + "?areas=server-app", {
        credentials: "same-origin",
      });
      if (r.ok) {
        var d = await r.json();
        texts = d.messages || {};
        lang = d.lang || lang;
      }
    } catch (e) {}
    document.documentElement.lang = lang;
    document.title = tx("title");
    status.textContent = tx("connecting");
  }
  loadTexts().then(main);
  function main() {
  if (!/^[\w-]{1,100}$/.test(sid) || !/^[\w-]{1,100}$/.test(jid)) {
    status.textContent = tx("badParams");
    return;
  }
  var token = "";
  function start() {
    var term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: colors.bg, foreground: colors.ink },
      allowProposedApi: false,
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById("term"));
    var path = "/sessions/" + sid + "/terminal/" + jid;
    var cursor = 0,
      finished = false,
      reading = false,
      writing = false,
      buffer = "",
      pending = null;
    var uid = function () {
      return (
        (globalThis.crypto &&
          globalThis.crypto.randomUUID &&
          globalThis.crypto.randomUUID()) ||
        Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
      );
    };
    async function api(p, body) {
      var abort = new AbortController();
      var timer = setTimeout(function () {
        abort.abort();
      }, 10000);
      try {
        var headers = { "Content-Type": "application/json", "Accept-Language": lang };
        if (token) headers.Authorization = "Bearer " + token;
        var r = await fetch(base + "/api" + p, {
          method: body ? "POST" : "GET",
          headers: headers,
          credentials: "same-origin",
          signal: abort.signal,
          body: body ? JSON.stringify(body) : undefined,
        });
        var data = await r.json();
        if (!r.ok) throw Error(data.error || tx("connectFailed"));
        return data;
      } finally {
        clearTimeout(timer);
      }
    }
    async function send() {
      if (writing || finished || (!buffer && !pending)) return;
      writing = true;
      if (!pending) {
        pending = { id: uid(), text: buffer };
        buffer = "";
      }
      try {
        await api(path + "/input", pending);
        pending = null;
      } catch (e) {
        status.textContent = tx("inputRetry", { why: e.message });
      } finally {
        writing = false;
      }
    }
    term.onData(function (s) {
      buffer += s;
    });
    setInterval(send, 80);
    function resize() {
      fit.fit();
      if (!finished)
        api(path + "/input", {
          id: uid(),
          cols: Math.max(20, term.cols),
          rows: Math.max(5, term.rows),
        }).catch(function () {});
    }
    new ResizeObserver(resize).observe(document.getElementById("term"));
    setTimeout(resize, 100);
    var keys = {
      esc: "\x1b",
      tab: "\t",
      up: "\x1b[A",
      down: "\x1b[B",
      ctrlc: "\x03",
      ctrls: "\x13",
      enter: "\r",
    };
    document.querySelectorAll("[data-key]").forEach(function (b) {
      b.onclick = function () {
        buffer += keys[b.dataset.key];
        term.focus();
      };
    });
    async function poll() {
      if (reading || finished) return;
      reading = true;
      try {
        var r = await api(path + "/output?after=" + cursor);
        if (r.truncated) {
          term.reset();
          status.textContent = tx("outputTrimmed");
        }
        for (var i = 0; i < r.chunks.length; i++) {
          var x = r.chunks[i];
          term.write(
            Uint8Array.from(atob(x.data), function (c) {
              return c.charCodeAt(0);
            }),
          );
          cursor = x.seq;
        }
        if (
          ["queued", "running"].indexOf(r.status) < 0 &&
          r.chunks.length < 100
        ) {
          finished = true;
          status.textContent = tx("ended", { status: r.status });
        } else
          status.textContent =
            r.status === "queued"
              ? tx("waitingNode")
              : tx("connected");
      } catch (e) {
        status.textContent = tx("reconnecting", { why: e.message });
      } finally {
        reading = false;
      }
    }
    setInterval(poll, 300);
    poll();
  }
  if (q.get("auth") === "bearer") {
    var started = false;
    window.addEventListener("message", function (e) {
      if (started || e.source !== window.parent) return;
      var d = e.data;
      if (
        !d ||
        // P6-03 (ADR-153): an older page around it still says harbor-.
        (d.type !== "daisy-terminal-token" &&
          d.type !== "harbor-terminal-token") ||
        typeof d.token !== "string"
      )
        return;
      started = true;
      token = d.token;
      start();
    });
    window.parent.postMessage({ type: "daisy-terminal-ready" }, "*");
    window.parent.postMessage({ type: "harbor-terminal-ready" }, "*");
  } else start();
  }
})();
