/* Learning Grounds app shell: login, topics tree, reader tabs, chat.
 * Renderers live in render.js (window.LG). Every URL is relative because the
 * site is served under /learn/ behind Tailscale Funnel. */
(function () {
  "use strict";
  const LG = window.LG;
  const h = LG.h;
  const $ = (id) => document.getElementById(id);

  const S = {
    me: null,
    tree: [],
    paths: new Map(),        // path -> node
    open: [],                // open tab paths
    active: null,
    cache: new Map(),        // path -> text
    editing: false,
    collapsed: new Set(),
    chats: [],
    chatId: null,
    busy: false,
    pane: "chat",
    pending: [],             // attachments waiting in the composer
  };
  const mobile = () => matchMedia("(max-width: 900px)").matches;

  // ---- storage (per-viewer conveniences only) ---------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("lg-" + (S.me ? S.me.user + "-" : "") + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("lg-" + (S.me ? S.me.user + "-" : "") + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---- api ----------------------------------------------------------------------
  async function api(path, body) {
    const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opt));
    if (r.status === 401) { showLogin(); throw new Error("Please log in again."); }
    const ct = r.headers.get("Content-Type") || "";
    const data = ct.includes("json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || "Request failed (" + r.status + ")");
    return data;
  }

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  // ---- modal + menu ---------------------------------------------------------------
  function ask(o) {
    return new Promise((res) => {
      const m = $("modal"), inp = $("modal-input");
      $("modal-title").textContent = o.title || "";
      $("modal-text").textContent = o.text || "";
      $("modal-text").hidden = !o.text;
      inp.hidden = o.input === false;
      inp.value = o.value || "";
      inp.placeholder = o.placeholder || "";
      $("modal-ok").textContent = o.ok || "OK";
      $("modal-ok").className = "btn " + (o.danger ? "danger" : "primary");
      m.hidden = false;
      setTimeout(() => { if (!inp.hidden) { inp.focus(); const dot = inp.value.indexOf("."); inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length); } else $("modal-ok").focus(); }, 30);
      const done = (v) => { m.hidden = true; $("modal-card").onsubmit = null; $("modal-cancel").onclick = null; m.onclick = null; document.removeEventListener("keydown", esc); res(v); };
      const esc = (e) => { if (e.key === "Escape") done(null); };
      document.addEventListener("keydown", esc);
      $("modal-card").onsubmit = (e) => { e.preventDefault(); done(o.input === false ? true : inp.value.trim() || null); };
      $("modal-cancel").onclick = () => done(null);
      m.onclick = (e) => { if (e.target === m) done(null); };
    });
  }

  function menu(anchor, items) {
    const m = $("menu");
    m.replaceChildren(...items.map((it) => h("button", { class: it.danger ? "danger" : "", onclick: () => { m.hidden = true; it.fn(); } }, it.label)));
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + "px";
    m.style.top = (r.bottom + hh + 8 > innerHeight ? Math.max(8, r.top - hh - 4) : r.bottom + 4) + "px";
  }
  document.addEventListener("pointerdown", (e) => { const m = $("menu"); if (!m.hidden && !m.contains(e.target)) m.hidden = true; });

  // ---- theme ---------------------------------------------------------------------
  const THEMES = ["auto", "light", "dark"];
  function applyTheme() {
    const t = (() => { try { return localStorage.getItem("lg-theme") || "auto"; } catch (e) { return "auto"; } })();
    if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    $("theme-btn").textContent = t === "auto" ? "🌓" : t === "light" ? "☀️" : "🌙";
    $("theme-btn").title = "Theme: " + t + " (click to change)";
    const dark = LG.isDark();
    $("hl-dark").disabled = !dark; $("hl-light").disabled = dark;
    LG.redrawPlots();
  }
  $("theme-btn").onclick = () => {
    let t; try { t = localStorage.getItem("lg-theme") || "auto"; } catch (e) { t = "auto"; }
    t = THEMES[(THEMES.indexOf(t) + 1) % 3];
    try { localStorage.setItem("lg-theme", t); } catch (e) { /* ignore */ }
    applyTheme();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // ---- login ----------------------------------------------------------------------
  function showLogin() {
    $("boot").hidden = true; $("app").hidden = true; $("login").hidden = false;
    setTimeout(() => $("login-user").focus(), 50);
  }
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    $("login-err").textContent = "";
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const r = await fetch("api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ user: $("login-user").value.trim().toLowerCase(), pass: $("login-pass").value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not log in.");
      $("login-pass").value = "";
      await boot();
    } catch (err) {
      $("login-err").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  $("logout-btn").onclick = async () => {
    try { await fetch("api/logout", { method: "POST", credentials: "same-origin" }); } catch (e) { /* ignore */ }
    endTour(false);
    S.me = null; S.cache.clear(); S.open = []; S.active = null; S.chatId = null; clearPending();
    $("messages").replaceChildren(); $("reader").replaceChildren(); $("tabs").replaceChildren();
    showLogin();
  };

  // ---- panes (mobile) -------------------------------------------------------------
  function setPane(p) {
    S.pane = p;
    $("app").dataset.pane = p;
    document.querySelectorAll("#bottom-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.pane === p));
    if (p === "reader") document.querySelector("#bottom-tabs .dot").hidden = true;
    if (p === "reader" || p === "chat") setTimeout(LG.redrawPlots, 0);
  }
  document.querySelectorAll("#bottom-tabs button").forEach((b) => { b.onclick = () => setPane(b.dataset.pane); });

  // ---- tree -----------------------------------------------------------------------
  const TOPIC_COLORS = ["#5b5bd6", "#e5484d", "#12a594", "#f76b15", "#8e4ec6", "#0090ff", "#d6409f", "#978365", "#30a46c"];
  function topicColor(name) { let x = 0; for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0; return TOPIC_COLORS[x % TOPIC_COLORS.length]; }
  function topicGlyph(name) { const ch = [...name.replace(/^[^\p{L}\p{N}]+/u, "")][0] || name[0] || "?"; return ch.toUpperCase(); }

  async function loadTree() {
    const d = await api("api/tree");
    S.tree = d.tree || [];
    S.paths.clear();
    const walk = (ns) => ns.forEach((n) => { S.paths.set(n.path, n); if (n.children) walk(n.children); });
    walk(S.tree);
    drawTree();
  }

  function drawTree(flashPath) {
    const root = $("tree");
    root.replaceChildren();
    const topics = S.tree.filter((n) => n.dir);
    const loose = S.tree.filter((n) => !n.dir);
    if (!S.tree.length) {
      root.append(h("div", { class: "tree-empty" }, "Nothing here yet. Ask your teacher in the chat what you want to learn, and your topics will appear here. Or press ", h("b", { text: "+ Topic" }), "."));
      return;
    }
    for (const t of topics) {
      const sec = h("div", { class: "topic" + (S.collapsed.has(t.path) ? " collapsed" : ""), role: "treeitem" });
      const more = h("button", { class: "more", title: "More", "aria-label": "More actions for " + t.name, onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, t, true); } }, "⋯");
      const head = h("div", { class: "topic-head", tabindex: "0" },
        h("span", { class: "caret", text: "▾" }),
        h("span", { class: "topic-badge", style: "background:" + topicColor(t.name), text: topicGlyph(t.name) }),
        h("span", { class: "topic-name", text: t.name, title: t.name }), more);
      const toggle = () => { toggleCollapsed(t.path); sec.classList.toggle("collapsed"); };
      head.onclick = toggle;
      head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
      const kids = h("div", { class: "children" });
      drawNodes(t.children || [], kids, flashPath);
      if (!(t.children || []).length) kids.append(h("div", { class: "muted small", style: "padding:4px 8px", text: "(empty)" }));
      sec.append(head, kids);
      root.append(sec);
    }
    if (loose.length) {
      const sec = h("div", { class: "topic" + (S.collapsed.has("") ? " collapsed" : "") });
      const head = h("div", { class: "topic-head" }, h("span", { class: "caret", text: "▾" }),
        h("span", { class: "topic-badge", style: "background:#8b8b9e", text: "…" }), h("span", { class: "topic-name", text: "Other files" }));
      head.onclick = () => { toggleCollapsed(""); sec.classList.toggle("collapsed"); };
      const kids = h("div", { class: "children" });
      drawNodes(loose, kids, flashPath);
      sec.append(head, kids);
      root.append(sec);
    }
  }
  function toggleCollapsed(p) {
    if (S.collapsed.has(p)) S.collapsed.delete(p); else S.collapsed.add(p);
    store.set("collapsed", [...S.collapsed]);
  }
  function drawNodes(nodes, host, flashPath) {
    for (const n of nodes) {
      if (n.dir) {
        const wrap = h("div", { class: S.collapsed.has(n.path) ? "collapsed" : "" });
        const row = h("div", { class: "node-row", tabindex: "0", title: n.path },
          h("span", { class: "caret", text: "▾" }), h("span", { class: "ico", text: "📁" }), h("span", { class: "label", text: n.name }),
          h("button", { class: "more", "aria-label": "More actions", onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, n); } }, "⋯"));
        row.onclick = () => { toggleCollapsed(n.path); wrap.classList.toggle("collapsed"); };
        const kids = h("div", { class: "children" });
        drawNodes(n.children || [], kids, flashPath);
        wrap.append(row, kids);
        host.append(wrap);
      } else {
        const kind = LG.kindOf(n.path);
        const row = h("div", { class: "node-row" + (S.active === n.path ? " active" : "") + (flashPath === n.path ? " flash-new" : ""), tabindex: "0", title: n.path, "data-path": n.path },
          h("span", { class: "caret" }), h("span", { class: "ico", text: LG.ICON[kind] || "📄" }), h("span", { class: "label", text: prettyName(n.name) }),
          h("button", { class: "more", "aria-label": "More actions", onclick: (e) => { e.stopPropagation(); fileMenu(e.currentTarget, n); } }, "⋯"));
        row.onclick = () => { openFile(n.path); if (mobile()) setPane("reader"); };
        row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(); };
        host.append(row);
      }
    }
  }
  function prettyName(name) {
    return name.replace(/\.(quiz|flash|flashcards|plot|lab)\.json$/i, "").replace(/\.(md|markdown|html?)$/i, "");
  }
  function parentOf(p) { return LG.dirOf(p); }
  function join(a, b) { return a ? a + "/" + b : b; }

  function folderMenu(btn, n, isTopic) {
    menu(btn, [
      { label: "📝 New file here", fn: () => newFile(n.path) },
      { label: "📁 New folder here", fn: () => newFolder(n.path) },
      { label: "⬆️ Upload files here", fn: () => pickTreeUpload(n.path) },
      { label: "✏️ Rename", fn: () => renamePath(n) },
      { label: "🗑 Delete" + (isTopic ? " topic" : " folder"), danger: true, fn: () => deletePath(n) },
    ]);
  }
  function fileMenu(btn, n) {
    menu(btn, [
      { label: "📖 Open", fn: () => openFile(n.path) },
      { label: "💬 Ask teacher about it", fn: () => attachExisting(n.path) },
      { label: "✏️ Rename", fn: () => renamePath(n) },
      { label: "🗑 Delete", danger: true, fn: () => deletePath(n) },
    ]);
  }
  $("new-topic").onclick = async () => {
    const name = await ask({ title: "New topic", text: "A topic is a big folder, like Math, C++ or Space.", placeholder: "Topic name", ok: "Create" });
    if (!name) return;
    try { await api("api/mkdir", { path: cleanName(name) }); await loadTree(); } catch (e) { toast(e.message); }
  };
  $("refresh-tree").onclick = () => loadTree().catch((e) => toast(e.message));
  function cleanName(s) { return s.replace(/[\\/]+/g, "-").replace(/^\.+/, "").trim(); }
  async function newFile(dir) {
    const name = await ask({ title: "New file", text: "End it with .md for notes. Other kinds: .quiz.json, .flash.json, .plot.json, .lab.json, .html", value: "notes.md", ok: "Create" });
    if (!name) return;
    let n = cleanName(name);
    if (!/\.[a-z0-9]+$/i.test(n)) n += ".md";
    const p = join(dir, n);
    if (S.paths.has(p)) return toast("A file with that name exists.");
    const starter = n.endsWith(".md") ? "# " + prettyName(n).replace(/[-_]/g, " ") + "\n\n" : "";
    try {
      await api("api/file", { path: p, content: starter });
      S.collapsed.delete(dir);
      await loadTree();
      await openFile(p);
      startEdit();
      if (mobile()) setPane("reader");
    } catch (e) { toast(e.message); }
  }
  async function newFolder(dir) {
    const name = await ask({ title: "New folder", placeholder: "Folder name", ok: "Create" });
    if (!name) return;
    try { await api("api/mkdir", { path: join(dir, cleanName(name)) }); S.collapsed.delete(dir); await loadTree(); } catch (e) { toast(e.message); }
  }
  async function renamePath(n) {
    const name = await ask({ title: "Rename", value: n.name, ok: "Rename" });
    if (!name || name === n.name) return;
    const dst = join(parentOf(n.path), cleanName(name));
    try {
      await api("api/move", { src: n.path, dst });
      S.open = S.open.map((p) => (p === n.path || p.startsWith(n.path + "/") ? dst + p.slice(n.path.length) : p));
      if (S.active && (S.active === n.path || S.active.startsWith(n.path + "/"))) S.active = dst + S.active.slice(n.path.length);
      S.cache.clear();
      await loadTree();
      drawTabs(); renderActive();
    } catch (e) { toast(e.message); }
  }
  async function deletePath(n) {
    const ok = await ask({ title: "Delete " + n.name + "?", text: n.dir ? "The folder and everything inside it will be removed." : "This file will be removed.", input: false, ok: "Delete", danger: true });
    if (!ok) return;
    try {
      await api("api/delete", { path: n.path });
      S.open = S.open.filter((p) => p !== n.path && !p.startsWith(n.path + "/"));
      if (S.active && !S.open.includes(S.active)) S.active = S.open[S.open.length - 1] || null;
      await loadTree();
      drawTabs(); renderActive();
    } catch (e) { toast(e.message); }
  }

  // ---- reader ---------------------------------------------------------------------
  async function openFile(path, opts) {
    opts = opts || {};
    if (!S.paths.has(path)) {
      await loadTree().catch(() => {});
      const n = S.paths.get(path);
      if (!n) { toast("Can't find " + path); return; }
      if (n.dir) { S.collapsed.delete(path); drawTree(); if (mobile()) setPane("topics"); return; }
    } else if (S.paths.get(path).dir) {
      S.collapsed.delete(path); drawTree(); if (mobile()) setPane("topics"); return;
    }
    if (S.editing && S.active !== path) stopEdit();
    if (!S.open.includes(path)) S.open.push(path);
    S.active = path;
    if (opts.reload) S.cache.delete(path);
    // make sure it is visible in the tree
    let p = parentOf(path);
    while (p) { S.collapsed.delete(p); p = parentOf(p); }
    store.set("tabs", { open: S.open, active: S.active });
    drawTabs();
    drawTree();
    await renderActive();
  }

  function drawTabs() {
    const t = $("tabs");
    t.hidden = !S.open.length;
    t.replaceChildren(...S.open.map((p) => {
      const kind = LG.kindOf(p);
      const name = prettyName(p.split("/").pop());
      const tab = h("div", { class: "tab" + (p === S.active ? " active" : ""), role: "tab", title: p, "aria-selected": String(p === S.active) },
        h("span", { text: LG.ICON[kind] || "📄" }), h("span", { class: "t", text: name }),
        h("button", { class: "x", "aria-label": "Close " + name, onclick: (e) => { e.stopPropagation(); closeTab(p); } }, "×"));
      tab.onclick = () => { if (p !== S.active) openFile(p); };
      return tab;
    }));
    const act = t.querySelector(".tab.active");
    if (act) act.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function closeTab(p) {
    const i = S.open.indexOf(p);
    S.open.splice(i, 1);
    S.cache.delete(p);
    if (S.active === p) { stopEdit(); S.active = S.open[Math.min(i, S.open.length - 1)] || null; }
    store.set("tabs", { open: S.open, active: S.active });
    drawTabs(); drawTree(); renderActive();
  }

  let renderSeq = 0;
  async function renderActive() {
    const seq = ++renderSeq;
    const body = $("reader");
    body.classList.remove("full");
    if (!S.active) {
      $("reader-bar").hidden = true;
      body.replaceChildren(welcome());
      return;
    }
    const path = S.active, kind = LG.kindOf(path);
    $("reader-bar").hidden = false;
    $("reader-path").textContent = path;
    $("edit-btn").hidden = S.editing || !LG.editable(kind);
    $("save-btn").hidden = $("cancel-btn").hidden = !S.editing;
    if (LG.isBinaryKind(kind)) { body.replaceChildren(); body.dataset.path = path; LG.renderFile(path, "", body); return; }
    let text = S.cache.get(path);
    if (text == null) {
      if (!body.firstChild) body.append(h("div", { class: "boot", style: "position:static;padding:40px" }, h("div", { class: "spinner" })));
      try { text = await api("api/file?path=" + encodeURIComponent(path)); }
      catch (e) { if (seq === renderSeq) body.replaceChildren(LG.problem(e.message)); return; }
      if (typeof text !== "string") text = JSON.stringify(text, null, 2);
      S.cache.set(path, text);
    }
    if (seq !== renderSeq) return;
    const scroll = body.dataset.path === path ? body.scrollTop : 0;
    body.replaceChildren();
    body.dataset.path = path;
    if (S.editing) {
      const ta = h("textarea", { class: "editor", spellcheck: "false", "aria-label": "Edit " + path });
      ta.value = text;
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveEdit(); }
        if (e.key === "Tab") { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("  ", s, ta.selectionEnd, "end"); }
      });
      body.append(h("div", { style: "max-width:900px;margin:0 auto" }, ta));
      ta.focus();
      return;
    }
    const r = LG.renderFile(path, text, body) || {};
    if (r.full) body.classList.add("full");
    body.scrollTop = scroll;
  }

  function welcome() {
    const name = S.me ? S.me.display : "";
    const starters = [
      ["🧮", "Math", "Teach me something new in math, at my level."],
      ["💻", "Coding", "I want to learn to code. Where should I start?"],
      ["🔭", "Science", "Show me something amazing about space or nature."],
      ["✨", "Surprise me", "Surprise me with a fun thing to learn today."],
    ];
    return h("div", { class: "welcome" },
      h("div", { class: "big-emoji", text: "🌱" }),
      h("h1", { text: "Hi" + (name ? " " + name : "") + "!" }),
      h("p", { class: "muted", text: "This is your learning space. Tell your teacher what you want to learn. It will make notes, quizzes, flashcards and practice labs for you, and they show up here." }),
      h("p", { class: "muted", text: "Got homework or school papers? Press 📎 in the chat (or 📷 on a phone) to send a photo, PDF or Word file, and your teacher will look at it with you." }),
      S.me && !S.me.about ? h("button", { class: "btn", onclick: openProfile }, "✏️ Tell your teacher about you") : null,
      h("div", { class: "starters" }, starters.map(([e, t, msg]) =>
        h("button", { class: "starter", onclick: () => { if (mobile()) setPane("chat"); send(msg); } }, h("b", { text: e + " " + t }), h("span", { class: "muted", text: msg })))));
  }

  function startEdit() {
    if (!S.active) return;
    S.editing = true;
    renderActive();
  }
  function stopEdit() { S.editing = false; }
  async function saveEdit() {
    const ta = document.querySelector("#reader textarea.editor");
    if (!ta || !S.active) return;
    try {
      await api("api/file", { path: S.active, content: ta.value });
      S.cache.set(S.active, ta.value);
      S.editing = false;
      toast("Saved ✓");
      renderActive();
      loadTree().catch(() => {});
    } catch (e) { toast(e.message); }
  }
  $("edit-btn").onclick = startEdit;
  $("save-btn").onclick = saveEdit;
  $("cancel-btn").onclick = () => { S.editing = false; renderActive(); };

  // ---- chat -----------------------------------------------------------------------
  const TOOL_TEXT = {
    write_file: ["Writing a file…", "Wrote"], edit_file: ["Editing a file…", "Edited"], read_file: ["Reading…", "Read"],
    list_files: ["Looking at your files…", "Looked at your files"], show_file: ["Opening…", "Opened"],
    delete_path: ["Deleting…", "Deleted"], move_path: ["Moving…", "Moved"], list_blocks: ["Checking the building blocks…", "Checked the building blocks"],
    get_block: ["Getting a building block…", "Used building block"], save_block: ["Saving a building block…", "Saved a new building block"],
    web_search: ["Searching the web…", "Searched the web"], quiz: ["Making a quiz…", "Quiz"], ask_user_question: ["Asking you something…", "Question"],
  };

  async function loadChats(selectId) {
    const d = await api("api/chats");
    S.chats = d.chats || [];
    const sel = $("chat-pick");
    sel.replaceChildren(...(S.chats.length ? S.chats : [{ id: "", title: "New chat" }]).map((c) => h("option", { value: c.id, text: c.title || "Chat" })));
    const want = selectId || S.chatId || store.get("chat", null);
    S.chatId = S.chats.some((c) => c.id === want) ? want : (S.chats[0] && S.chats[0].id) || null;
    sel.value = S.chatId || "";
    $("del-chat").hidden = !S.chatId;
  }
  $("chat-pick").onchange = () => { S.chatId = $("chat-pick").value || null; store.set("chat", S.chatId); loadChat(); };
  $("new-chat").onclick = async () => {
    if (S.busy) return toast("Wait until the teacher finishes, or press Stop.");
    try {
      const d = await api("api/chat/new", {});
      await loadChats(d.id);
      store.set("chat", d.id);
      await loadChat();
      $("input").focus();
    } catch (e) { toast(e.message); }
  };
  $("del-chat").onclick = async () => {
    if (!S.chatId) return;
    const c = S.chats.find((x) => x.id === S.chatId);
    const ok = await ask({ title: "Delete this chat?", text: "\"" + (c ? c.title : "Chat") + "\" will be gone. Your files stay.", input: false, ok: "Delete", danger: true });
    if (!ok) return;
    try { await api("api/chat/delete", { id: S.chatId }); S.chatId = null; store.set("chat", null); await loadChats(); await loadChat(); } catch (e) { toast(e.message); }
  };

  let pollTm = null;
  async function loadChat() {
    clearTimeout(pollTm);
    const box = $("messages");
    if (!S.chatId) { box.replaceChildren(chatEmpty()); return; }
    let d;
    try { d = await api("api/chat?id=" + S.chatId); } catch (e) { box.replaceChildren(LG.problem(e.message)); return; }
    box.replaceChildren();
    const items = d.items || [];
    if (!items.length) box.append(chatEmpty());
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      if (it.role === "user") addUser(it.text, it.attachments);
      else if (it.role === "assistant") addAssistant(it.text);
      else if (it.role === "tool") addTool(it.name, it.detail, true);
      else if (it.role === "quiz") addQuiz(it.questions, !last || d.busy);
      else if (it.role === "choice") addChoice(it, !last || d.busy);
    });
    if (items.length) scrollDown(true);
    if (d.busy && !S.busy) {
      box.append(h("div", { class: "thinking" }, h("span", { class: "mini-spin" }), "Still answering (in another window)…"));
      pollTm = setTimeout(loadChat, 2500);
    }
  }
  function chatEmpty() {
    const ideas = ["What can you teach me?", "Explain integration like I'm new to it.", "Quiz me on what I learned last time."];
    return h("div", { class: "chat-empty" }, h("div", { class: "big-emoji", text: "👋" }),
      h("p", { text: "Say hi to your teacher! Ask a question or say what you want to learn." }),
      h("div", { class: "starters" }, ideas.map((t) => h("button", { class: "starter", onclick: () => send(t) }, t))));
  }

  function nearBottom() { const b = $("messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }
  function scrollDown(force) { const b = $("messages"); if (force || nearBottom()) b.scrollTop = b.scrollHeight; }
  function clearEmpty() { const e = $("messages").querySelector(".chat-empty"); if (e) e.remove(); }

  function addUser(text, atts) {
    clearEmpty();
    const m = h("div", { class: "msg user" });
    if (atts && atts.length) {
      const row = h("div", { class: "atts" });
      for (const p of atts) {
        const open = () => { openFile(p); if (mobile()) setPane("reader"); };
        if (LG.kindOf(p) === "image") row.append(h("img", { class: "big", src: LG.fileUrl(p), alt: p.split("/").pop(), title: p, loading: "lazy", onclick: open }));
        else row.append(h("span", { class: "chip", title: p, onclick: open }, h("span", { class: "thumb", text: LG.ICON[LG.kindOf(p)] || "📄" }), h("span", { class: "nm", text: p.split("/").pop() })));
      }
      m.append(row);
    }
    if (text) m.append(h("div", { class: "bubble", text }));
    $("messages").append(m);
    return m;
  }
  function addAssistant(text) {
    clearEmpty();
    const b = h("div", { class: "bubble" });
    const m = h("div", { class: "msg assistant" }, b);
    $("messages").append(m);
    LG.renderMarkdown(text, b, { chat: true });
    return { m, b, text };
  }
  function addTool(name, detail, done) {
    const t = TOOL_TEXT[name] || [name + "…", name];
    const line = h("div", { class: "msg tool", "data-tool": name });
    setTool(line, name, detail, done, t);
    $("messages").append(line);
    return line;
  }
  function setTool(line, name, detail, done, t) {
    t = t || TOOL_TEXT[name] || [name + "…", name];
    line.replaceChildren();
    if (!done) { line.append(h("span", { class: "mini-spin" }), t[0]); line.dataset.pending = "1"; return; }
    delete line.dataset.pending;
    line.append(h("span", { text: "✓" }), t[1]);
    if (detail) {
      line.append(" ");
      const isPath = ["write_file", "edit_file", "read_file", "show_file", "move_path"].includes(name) && !detail.includes(" -> ");
      if (isPath) {
        const a = h("a", { text: detail, onclick: () => { openFile(detail); if (mobile()) setPane("reader"); } });
        line.append(a);
      } else line.append(h("span", { text: detail }));
    }
  }
  function addError(msg) {
    $("messages").append(h("div", { class: "msg error" }, h("div", { class: "bubble", text: "⚠️ " + msg })));
  }
  function addQuiz(questions, readOnly) {
    clearEmpty();
    const card = h("div", { class: "card" });
    $("messages").append(h("div", { class: "msg assistant" }, card));
    try { LG.renderQuiz(questions, card, { mode: "chat", readOnly }); } catch (e) { card.append(LG.problem(e.message)); }
  }
  function addChoice(it, readOnly) {
    clearEmpty();
    const card = h("div", { class: "card" });
    const q = h("div", { class: "q-text" });
    LG.renderMarkdown(String(it.question || ""), q, { inline: true });
    card.append(q);
    const btns = h("div", { class: "choice-btns" });
    const lock = () => card.querySelectorAll("button, input").forEach((x) => { x.disabled = true; });
    (it.options || []).forEach((o) => {
      const b = h("button", { class: "btn", type: "button", disabled: readOnly });
      LG.renderMarkdown(String(o), b, { inline: true });
      b.onclick = () => { if (S.busy) return; b.classList.add("primary"); lock(); send(String(o)); };
      btns.append(b);
    });
    card.append(btns);
    if (!readOnly && it.allow_other !== false) {
      const inp = h("input", { placeholder: "Or type your own answer…", "aria-label": "Your own answer" });
      const go = h("button", { class: "btn", type: "button", text: "Send" });
      const submit = () => { const v = inp.value.trim(); if (!v || S.busy) return; lock(); send(v); };
      go.onclick = submit;
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
      card.append(h("div", { class: "choice-other" }, inp, go));
    }
    $("messages").append(h("div", { class: "msg assistant" }, card));
  }

  function setBusy(b) {
    S.busy = b;
    $("send-btn").hidden = b;
    $("stop-btn").hidden = !b;
    $("new-chat").disabled = b;
    $("chat-pick").disabled = b;
  }

  async function send(text, display, atts) {
    text = String(text || "").trim();
    atts = (atts || []).filter(Boolean);
    if (!text && !atts.length) return;
    if (S.busy) { toast("Wait until the teacher finishes, or press Stop."); return; }
    setBusy(true);
    try {
      if (!S.chatId) {
        const d = await api("api/chat/new", {});
        S.chatId = d.id;
        store.set("chat", d.id);
        await loadChats(d.id);
        $("messages").replaceChildren();
      }
    } catch (e) { setBusy(false); toast(e.message); return; }
    clearTimeout(pollTm);
    addUser(display || text, atts);
    scrollDown(true);
    const thinking = h("div", { class: "thinking" }, h("span", { class: "mini-spin" }), "Thinking…");
    $("messages").append(thinking);
    let cur = null, rafPending = false;
    const flushText = () => {
      rafPending = false;
      if (cur) { LG.renderMarkdown(cur.text, cur.b, { chat: true }); scrollDown(); }
    };
    const showThinking = (on, label) => {
      if (on) { thinking.lastChild.textContent = label || "Thinking…"; $("messages").append(thinking); scrollDown(); }
      else thinking.remove();
    };
    const handle = (ev) => {
      switch (ev.t) {
        case "text":
          showThinking(false);
          if (!cur) cur = addAssistant("");
          cur.text += ev.d || "";
          if (!rafPending) { rafPending = true; requestAnimationFrame(flushText); }
          break;
        case "thinking":
          if (!cur) showThinking(true, "Thinking…");
          break;
        case "tool_start":
          if (cur) flushText();
          cur = null; showThinking(false);
          if (ev.name !== "quiz" && ev.name !== "ask_user_question") addTool(ev.name, "", false);
          scrollDown();
          break;
        case "tool": {
          const pend = [...$("messages").querySelectorAll('.msg.tool[data-pending="1"]')].find((l) => l.dataset.tool === ev.name);
          if (ev.name === "quiz" || ev.name === "ask_user_question") break;
          if (pend) setTool(pend, ev.name, ev.detail, true); else addTool(ev.name, ev.detail, true);
          showThinking(true, "Working…");
          break;
        }
        case "tree":
          onTreeChanged(ev.changed);
          break;
        case "show":
          openFile(ev.path, { reload: true }).then(() => {
            if (mobile() && S.pane !== "reader") { document.querySelector("#bottom-tabs .dot").hidden = false; setPane("reader"); }
          });
          break;
        case "quiz":
          showThinking(false); cur = null;
          addQuiz(ev.questions, false); scrollDown(true);
          break;
        case "choice":
          showThinking(false); cur = null;
          addChoice(ev, false); scrollDown(true);
          break;
        case "usage":
          if (S.me) { S.me.spent = (S.me.spent || 0) + (+ev.usd || 0); drawMeter(); }
          break;
        case "error":
          showThinking(false); cur = null;
          addError(ev.msg || "Something went wrong.");
          break;
        case "done":
          break;
      }
    };
    try {
      const r = await fetch("api/send", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: S.chatId, text, display: display || undefined, model: S.me.model, attachments: atts.length ? atts : undefined }) });
      if (r.status === 401) { showLogin(); return; }
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "The teacher could not answer (" + r.status + ").");
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try { handle(JSON.parse(line.slice(5).trim())); } catch (e) { console.warn("bad event", line, e); }
          }
        }
      }
      if (cur) flushText();
    } catch (e) {
      addError(e.message);
    } finally {
      thinking.remove();
      $("messages").querySelectorAll('.msg.tool[data-pending="1"]').forEach((l) => setTool(l, l.dataset.tool, "", true));
      setBusy(false);
      scrollDown();
      loadChats(S.chatId).catch(() => {});
      refreshMe().catch(() => {});
    }
  }
  LG.ctx.send = (text, display, atts) => { if (mobile()) setPane("chat"); send(text, display, atts); };
  LG.ctx.open = (p) => { openFile(p); };
  LG.ctx.toast = toast;

  let treeTm = null;
  function onTreeChanged(changed) {
    if (changed) S.cache.delete(changed);
    clearTimeout(treeTm);
    treeTm = setTimeout(async () => {
      try { await loadTree(); } catch (e) { return; }
      if (changed) {
        let p = parentOf(changed);
        while (p) { S.collapsed.delete(p); p = parentOf(p); }
        drawTree(changed);
      }
      if (changed && changed === S.active && !S.editing) renderActive();
    }, 150);
  }

  $("stop-btn").onclick = () => { api("api/stop", {}).catch(() => {}); };
  const input = $("input");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; };
  input.addEventListener("input", grow);
  // keep what they typed if the phone kills the tab (e.g. while in the camera app)
  input.addEventListener("input", () => store.set("draft", input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").onsubmit = (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (S.busy) return;
    if (S.pending.some((a) => a.status === "up")) { toast("Wait a moment, still uploading…"); return; }
    const atts = S.pending.filter((a) => a.status === "ok").map((a) => a.path);
    if (!t && !atts.length) return;
    input.value = ""; grow(); store.set("draft", "");
    clearPending();
    send(t, null, atts);
  };

  // ---- attachments + uploads ----------------------------------------------------------
  // Photos are shrunk in the browser first: a phone photo is 3-12 MB, the
  // teacher sees at most ~2500 px anyway, and small files upload fast on mobile.
  async function shrinkImage(file) {
    const type = (file.type || "").toLowerCase();
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return file;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const MAX = 2000, big = Math.max(bmp.width, bmp.height);
      const heic = /hei[cf]/.test(type) || /\.hei[cf]$/i.test(file.name);
      if (big <= MAX && file.size < 1.5e6 && !heic) { bmp.close && bmp.close(); return file; }
      const k = Math.min(1, MAX / big);
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const g = c.getContext("2d");
      const keepPng = type === "image/png" && big <= MAX;
      if (!keepPng) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
      g.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const out = await new Promise((res) => c.toBlob(res, keepPng ? "image/png" : "image/jpeg", 0.85));
      if (!out || (out.size >= file.size && !heic)) return file;
      const base = (file.name || "photo").replace(/\.[^.]+$/, "");
      return new File([out], base + (keepPng ? ".png" : ".jpg"), { type: out.type });
    } catch (e) {
      return file;                      // can't decode here (e.g. HEIC on Chrome): send as is
    }
  }
  function photoName(file) {
    if (file.name && !/^image\.(jpe?g|png)$/i.test(file.name)) return file.name;
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return "photo " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes()) + "." + p(d.getSeconds()) + ".jpg";
  }
  function uploadFile(file, folder, onProgress) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open("POST", "api/upload?folder=" + encodeURIComponent(folder || "Uploads") + "&name=" + encodeURIComponent(file.name || "file"));
      x.withCredentials = true;
      x.setRequestHeader("Content-Type", "application/octet-stream");
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = {}; try { d = JSON.parse(x.responseText); } catch (e) { /* not json */ }
        if (x.status === 401) { showLogin(); rej(new Error("Please log in again.")); }
        else if (x.status >= 200 && x.status < 300 && d.path) res(d);
        else rej(new Error(d.error || "Upload failed (" + x.status + ")"));
      };
      x.onerror = () => rej(new Error("Upload failed. Check the connection."));
      x.send(file);
    });
  }
  async function prepare(file, camera) {
    let f = file;
    if (camera || (file.type || "").startsWith("image/") || /\.hei[cf]$/i.test(file.name)) {
      const named = camera ? new File([file], photoName(file), { type: file.type || "image/jpeg" }) : file;
      f = await shrinkImage(named);
    }
    if (f.size > 40e6) throw new Error(f.name + " is too big (40 MB limit).");
    return f;
  }

  function drawPending() {
    const row = $("attach-row");
    row.hidden = !S.pending.length;
    row.replaceChildren(...S.pending.map((a) => {
      const thumb = a.thumb ? h("img", { class: "thumb", src: a.thumb, alt: "" }) : h("span", { class: "thumb", text: LG.ICON[LG.kindOf(a.name)] || "📄" });
      const kids = [thumb, h("span", { class: "nm", text: a.name, title: a.path || a.name })];
      if (a.status === "up") { a.bar = h("progress", { max: "1", value: String(a.progress || 0) }); kids.push(a.bar); }
      if (a.status === "bad") kids.push(h("span", { class: "small", text: "failed" }));
      kids.push(h("button", { class: "x", type: "button", "aria-label": "Remove " + a.name, onclick: () => removePending(a) }, "×"));
      return h("span", { class: "chip" + (a.status === "up" ? " busy" : "") + (a.status === "bad" ? " bad" : ""), title: a.error || a.path || a.name }, ...kids);
    }));
  }
  function removePending(a) {
    S.pending = S.pending.filter((x) => x !== a);
    if (a.thumb && a.thumb.startsWith("blob:")) URL.revokeObjectURL(a.thumb);
    drawPending();
  }
  function clearPending() {
    S.pending.forEach((a) => { if (a.thumb && a.thumb.startsWith("blob:")) URL.revokeObjectURL(a.thumb); });
    S.pending = []; drawPending();
  }
  async function attachFiles(files, camera) {
    files = [...(files || [])];
    if (!files.length) return;
    if (mobile() && S.pane !== "chat") setPane("chat");
    for (const file of files) {
      if (S.pending.length >= 10) { toast("At most 10 files per message."); break; }
      const a = { name: file.name || "file", status: "up", progress: 0 };
      if ((file.type || "").startsWith("image/")) { try { a.thumb = URL.createObjectURL(file); } catch (e) { /* no preview */ } }
      S.pending.push(a); drawPending();
      (async () => {
        try {
          const f = await prepare(file, camera);
          a.name = f.name;
          const d = await uploadFile(f, "Uploads", (p) => { a.progress = p; if (a.bar) a.bar.value = p; });
          a.path = d.path; a.name = d.path.split("/").pop(); a.status = "ok";
        } catch (e) {
          a.status = "bad"; a.error = e.message; toast(e.message, 4000);
        }
        drawPending();
        onTreeChanged();
      })();
    }
    $("input").focus();
  }
  function attachExisting(path) {
    if (S.pending.some((a) => a.path === path)) return;
    S.pending.push({ name: path.split("/").pop(), path, status: "ok", thumb: LG.kindOf(path) === "image" ? LG.fileUrl(path) : null });
    drawPending();
    if (mobile()) setPane("chat");
    $("input").focus();
  }
  $("attach-btn").onclick = () => $("attach-input").click();
  $("camera-btn").onclick = () => openCamera();
  $("gallery-input").onchange = (e) => { const f = e.target.files; e.target.value = ""; closeCamera(); attachFiles(f, false); };

  // ---- in-page camera ---------------------------------------------------------------------
  // Opening the system camera app (input capture) sends the browser to the
  // background, and on a phone low on memory Android kills the tab: the photo
  // never comes back ("Unable to complete previous operation due to low
  // memory"). getUserMedia keeps everything inside the page. The camera app is
  // still the fallback when the page may not use the camera.
  const cam = { stream: null, facing: "environment", blob: null, url: null };
  const camSupported = () => window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  function camView(v) {   // "live" | "review" | "help"
    $("cam-live").hidden = v !== "live";
    $("cam-review").hidden = v !== "review";
    $("cam-help").hidden = v !== "help";
    $("cam-video").hidden = v === "review";
    $("cam-shot").hidden = v !== "review";
  }
  function camHelp(text) { stopStream(); camView("help"); $("cam-help-text").textContent = text; $("cam-msg").textContent = ""; }
  function stopStream() {
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    $("cam-video").srcObject = null;
  }
  async function startStream() {
    stopStream();
    $("cam-msg").textContent = "Starting the camera…";
    camView("live");
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: cam.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
      if ($("cam").hidden) { stopStream(); return; }
      const v = $("cam-video");
      v.srcObject = cam.stream;
      await v.play().catch(() => {});
      $("cam-msg").textContent = "Hold the page flat and fill the screen with it";
      const n = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "videoinput").length;
      $("cam-flip").style.visibility = n > 1 ? "" : "hidden";
    } catch (e) {
      const blocked = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      camHelp(blocked
        ? "The browser is not letting this page use the camera. Tap the lock or settings icon next to the address, allow Camera, and try again. Or use the camera app instead."
        : "Could not start the camera here (" + ((e && e.name) || "error") + "). Use the camera app instead.");
    }
  }
  function openCamera() {
    if (!camSupported()) { $("camera-input").click(); return; }
    clearShot();
    $("cam").hidden = false;
    document.body.style.overflow = "hidden";
    startStream();
  }
  function closeCamera() {
    stopStream(); clearShot();
    $("cam").hidden = true;
    document.body.style.overflow = "";
  }
  function clearShot() {
    if (cam.url) URL.revokeObjectURL(cam.url);
    cam.url = null; cam.blob = null;
    $("cam-shot").removeAttribute("src");
  }
  $("cam-shutter").onclick = async () => {
    const v = $("cam-video");
    if (!cam.stream || !v.videoWidth) return;
    const MAX = 2000, k = Math.min(1, MAX / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    c.width = c.height = 0;                      // give the memory back now
    if (!blob) { toast("Could not take the photo. Try again."); return; }
    stopStream();                                // camera off while reviewing
    clearShot();
    cam.blob = blob; cam.url = URL.createObjectURL(blob);
    $("cam-shot").src = cam.url;
    $("cam-msg").textContent = "Is the text sharp and readable?";
    camView("review");
  };
  function useShot(more) {
    if (!cam.blob) return;
    const f = new File([cam.blob], photoName({}), { type: "image/jpeg" });
    cam.blob = null;                              // attachFiles owns it now
    attachFiles([f], false);
    if (more) { clearShot(); startStream(); } else closeCamera();
  }
  $("cam-use").onclick = () => useShot(false);
  $("cam-more").onclick = () => useShot(true);
  $("cam-retake").onclick = () => { clearShot(); startStream(); };
  $("cam-flip").onclick = () => { cam.facing = cam.facing === "environment" ? "user" : "environment"; startStream(); };
  $("cam-close").onclick = closeCamera;
  $("cam-gallery").onclick = () => $("gallery-input").click();
  $("cam-app").onclick = () => { closeCamera(); $("camera-input").click(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("cam").hidden) closeCamera(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopStream();            // never hold the camera in the background
    else if (!$("cam").hidden && $("cam-review").hidden && $("cam-help").hidden) startStream();
  });
  $("attach-input").onchange = (e) => { attachFiles(e.target.files, false); e.target.value = ""; };
  $("camera-input").onchange = (e) => { attachFiles(e.target.files, true); e.target.value = ""; };
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(files.map((f) => f.name && f.name !== "image.png" ? f : new File([f], photoName({}).replace(".jpg", ".png").replace("photo", "pasted"), { type: f.type })), false); }
  });
  // drag and drop anywhere: the files go to the chat
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e) || $("app").hidden) return; dragDepth++; $("drop-hint").hidden = false; });
  addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-hint").hidden = true; });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("drop-hint").hidden = true;
    if (!$("app").hidden) attachFiles(e.dataTransfer.files, false);
  });

  // uploads straight into a folder from the Topics pane
  let treeUploadDir = "Uploads";
  function pickTreeUpload(dir) { treeUploadDir = dir || "Uploads"; $("tree-upload-input").click(); }
  $("upload-tree").onclick = () => pickTreeUpload("Uploads");
  $("tree-upload-input").onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length) return;
    let last = null, n = 0;
    toast("Uploading " + files.length + " file" + (files.length > 1 ? "s" : "") + "…", 60000);
    for (const file of files) {
      try { const f = await prepare(file, false); last = (await uploadFile(f, treeUploadDir)).path; n++; }
      catch (err) { toast(err.message, 4000); }
    }
    if (n) toast("Uploaded " + n + " file" + (n > 1 ? "s" : "") + " ✓");
    S.collapsed.delete(treeUploadDir);
    await loadTree().catch(() => {});
    if (last) { await openFile(last); if (mobile()) setPane("reader"); }
  };

  // ---- about me -----------------------------------------------------------------------
  function openProfile() {
    $("profile-display").value = S.me.display || "";
    $("profile-about").value = S.me.about || "";
    countAbout();
    $("profile").hidden = false;
    setTimeout(() => $("profile-about").focus(), 30);
  }
  function countAbout() { $("profile-count").textContent = $("profile-about").value.length + " / 2000"; }
  $("profile-about").addEventListener("input", countAbout);
  $("hello").onclick = openProfile;
  $("profile-cancel").onclick = () => { $("profile").hidden = true; };
  $("profile").onclick = (e) => { if (e.target === $("profile")) $("profile").hidden = true; };
  $("profile").addEventListener("keydown", (e) => { if (e.key === "Escape") $("profile").hidden = true; });
  $("profile-card").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api("api/about", { about: $("profile-about").value.trim(), display: $("profile-display").value.trim() });
      S.me.about = d.about; S.me.display = d.display;
      $("hello").textContent = "Hi, " + d.display + " 👋";
      $("profile").hidden = true;
      toast("Saved. Your teacher will use it from your next message ✓");
    } catch (err) { toast(err.message); }
  };

  // ---- model + meter ----------------------------------------------------------------
  function drawModels() {
    const sel = $("model-pick");
    sel.replaceChildren(...(S.me.models || []).map((m) => h("option", { value: m.id, text: "🎓 " + m.label })));
    sel.value = S.me.model;
    drawKeyWarning();
  }
  $("model-pick").onchange = async () => {
    const m = $("model-pick").value;
    try { await api("api/model", { model: m }); S.me.model = m; drawKeyWarning(); toast("Teacher: " + $("model-pick").selectedOptions[0].textContent.replace("🎓 ", "")); }
    catch (e) { toast(e.message); $("model-pick").value = S.me.model; }
  };
  function drawKeyWarning() {
    let w = document.getElementById("no-key");
    const need = !S.me.key && !String(S.me.model).startsWith("ollama:");
    if (need && !w) {
      w = h("div", { id: "no-key", class: "no-key", text: "No API key is set up yet, so Claude models can't answer. Pick a local model, or ask the admin to add a key." });
      $("pane-chat").insertBefore(w, $("composer"));
    } else if (!need && w) w.remove();
  }
  function drawMeter() {
    const sp = +S.me.spent || 0, cap = +S.me.cap || 0;
    const frac = cap > 0 ? Math.min(1, sp / cap) : 0;
    const f = $("meter-fill");
    f.style.width = (frac * 100) + "%";
    f.className = frac > 0.9 ? "high" : frac > 0.6 ? "mid" : "";
    $("meter-text").textContent = "$" + sp.toFixed(2) + " of $" + cap.toFixed(2) + " this month";
  }
  async function refreshMe() {
    const me = await api("api/me");
    if (!me.user) { showLogin(); return; }
    S.me = me;
    drawMeter();
    drawKeyWarning();
  }

  // ---- walkthrough (shown on a learner's first logins) ------------------------------
  // Each step points at one part of the app and says what it is for. On a phone
  // the three panes are separate tabs, so a step can switch pane and point at the
  // bottom tab instead of the whole screen.
  const TOUR = [
    { title: "Welcome to Learning Grounds 👋",
      html: "<p>This is your own place to learn anything. An AI teacher explains things, makes lessons, quizzes and flashcards for you, and keeps them all here.</p><p>This walkthrough shows what each part of the screen is for. It takes about a minute.</p>" },
    { pane: "chat", target: "#pane-chat", mtarget: '#bottom-tabs [data-pane="chat"]', title: "💬 Chat: talk to your teacher",
      html: "<p>Everything starts here. Write what you want to learn, or what your homework or test is about, like you would to a real teacher.</p><span class=\"eg\">Explain fractions to me with examples.</span><span class=\"eg\">I have a biology test on Friday about cells. Help me get ready.</span><p style=\"margin-top:.55em\">The teacher answers here, and when a lesson is worth keeping it saves it into your Topics.</p>" },
    { pane: "chat", target: "#composer", title: "📎 Send your schoolwork",
      html: "<p>Type your message and press <b>Send</b>.</p><ul><li><b>📎</b> attaches worksheets, PDFs, Word documents or pictures.</li><li><b>📷</b> on a phone takes a photo of a page in your notebook or textbook.</li><li>On a computer you can also drag files onto the window.</li></ul><p>The teacher reads them and can explain, check your answers, or make practice from them.</p>" },
    { pane: "chat", target: ".chat-head", title: "🗂 Chats, teacher and budget",
      html: "<ul><li>The top list holds all your <b>chats</b>. Every conversation is saved, so you can come back to it.</li><li><b>+ New</b> starts a fresh chat. Use one chat per subject or task.</li><li>🎓 picks which AI <b>teacher</b> answers you.</li><li>The bar shows how much of this month's <b>budget</b> you have used. When it is full, ask whoever runs the site.</li></ul>" },
    { pane: "topics", target: "#pane-topics", mtarget: '#bottom-tabs [data-pane="topics"]', title: "📚 Topics: your library",
      html: "<p>Everything the teacher makes for you lands here, sorted into subjects (one folder per topic).</p><ul><li>Click a topic to open or close it, click a file to read it.</li><li><b>+ Topic</b> makes a new subject folder.</li><li><b>⬆</b> uploads your own files, like school documents or photos.</li><li><b>⋯</b> next to a file lets you rename, move or delete it.</li></ul>" },
    { pane: "reader", target: "#pane-reader", mtarget: '#bottom-tabs [data-pane="reader"]', title: "📖 Reader: where you learn",
      html: "<p>Files you open from Topics show up here, each in its own tab at the top.</p><p>Lessons are not just text. They can have math, diagrams, graphs you can drag, <b>quizzes</b> that check your answers, <b>flashcards</b> to flip, and small labs to try things out.</p><p><b>Edit</b> lets you change or add to a file yourself, then <b>Save</b>.</p>" },
    { target: "#hello", title: "🙂 About me",
      html: "<p>Click your name to tell the teacher about yourself: your age or class, your school, what you like, what is hard for you, and which language you want to learn in.</p><p>The more it knows, the better the lessons fit you. Do this first!</p>" },
    { target: "#tour-btn", title: "🧭 Need this again?",
      html: "" },  // text filled in from the login count
    { pane: "chat", title: "You are ready 🎉",
      html: "<p>A good way to start: fill in <b>About me</b>, then ask your teacher something in the chat. It will make your first topic for you.</p>", last: true },
  ];
  const T = { i: 0, on: false };

  function tourText(st) {
    if (st.mtarget && mobile())
      return st.html + "<p>On a phone, tap <b>" + document.querySelector(st.mtarget).textContent + "</b> at the bottom to get here.</p>";
    if (st.target !== "#tour-btn") return st.html;
    const left = Math.max(0, 5 - (+S.me.logins || 0));
    return "<p>This <b>🧭 Walkthrough</b> button stays up here for your first 5 logins" +
      (left ? " (" + left + " more after this one)" : "") + ", so you can run the tour again any time.</p>";
  }
  function tourTarget(st) {
    const sel = mobile() && st.mtarget ? st.mtarget : st.target;
    const el = sel && document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }
  function placeTour() {
    if (!T.on) return;
    const st = TOUR[T.i], spot = $("tour-spot"), card = $("tour-card");
    const r = tourTarget(st);
    const W = innerWidth, H = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, pad = 6, gap = 14;
    if (!r) {
      spot.classList.add("none");
      card.style.left = Math.max(16, (W - cw) / 2) + "px";
      card.style.top = Math.max(16, (H - ch) / 2) + "px";
      return;
    }
    spot.classList.remove("none");
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    spot.style.left = x + "px"; spot.style.top = y + "px";
    spot.style.width = Math.min(W - 8, r.right + pad) - x + "px";
    spot.style.height = Math.min(H - 8, r.bottom + pad) - y + "px";
    // Beside the target if there is room (wide panes), else below or above it,
    // else (the target fills the screen) over its middle.
    let left, top;
    if (r.right + gap + cw + 16 <= W) { left = r.right + gap; top = r.top; }
    else if (r.left - gap - cw >= 16) { left = r.left - gap - cw; top = r.top; }
    else if (r.bottom + gap + ch + 16 <= H) { top = r.bottom + gap; left = r.left + r.width / 2 - cw / 2; }
    else if (r.top - gap - ch >= 16) { top = r.top - gap - ch; left = r.left + r.width / 2 - cw / 2; }
    else { top = (H - ch) / 2; left = (W - cw) / 2; }
    card.style.left = Math.max(16, Math.min(W - cw - 16, left)) + "px";
    card.style.top = Math.max(16, Math.min(H - ch - 16, top)) + "px";
  }
  function showTourStep(i) {
    T.i = Math.max(0, Math.min(TOUR.length - 1, i));
    const st = TOUR[T.i];
    if (st.pane && mobile()) setPane(st.pane);
    $("tour-step").textContent = "Step " + (T.i + 1) + " of " + TOUR.length;
    $("tour-title").textContent = st.title;
    $("tour-text").innerHTML = tourText(st);   // our own fixed strings
    $("tour-back").hidden = T.i === 0;
    $("tour-next").textContent = st.last ? "Start learning" : T.i === 0 ? "Show me" : "Next";
    $("tour-skip").textContent = st.last ? "Close" : "Skip tour";
    requestAnimationFrame(() => { placeTour(); $("tour-next").focus(); });
  }
  function startTour() {
    if (!S.me) return;
    $("menu").hidden = true; $("modal").hidden = true; $("profile").hidden = true;
    $("tour-btn").classList.remove("pulse");
    T.on = true; $("tour").hidden = false;
    showTourStep(0);
    if (!S.me.tour_seen) { S.me.tour_seen = true; api("api/tour", {}).catch(() => {}); }
  }
  function endTour(go) {
    if (!T.on) return;
    T.on = false; $("tour").hidden = true;
    if (go) { setPane("chat"); setTimeout(() => $("input").focus(), 50); }
  }
  $("tour-btn").onclick = startTour;
  $("tour-next").onclick = () => (TOUR[T.i].last ? endTour(true) : showTourStep(T.i + 1));
  $("tour-back").onclick = () => showTourStep(T.i - 1);
  $("tour-skip").onclick = () => endTour(false);
  document.addEventListener("keydown", (e) => {
    if (!T.on) return;
    if (e.key === "Escape") endTour(false);
    else if (e.key === "ArrowRight") $("tour-next").click();
    else if (e.key === "ArrowLeft" && T.i > 0) showTourStep(T.i - 1);
  });
  addEventListener("resize", placeTour);
  function drawTour() {
    const show = !!(S.me && S.me.tour);
    $("tour-btn").hidden = !show;
    if (!show) return endTour(false);
    if (!S.me.tour_seen) setTimeout(startTour, 400);   // the very first time, open it
    else $("tour-btn").classList.add("pulse");
  }

  // ---- boot -------------------------------------------------------------------------
  async function boot() {
    applyTheme();
    let me;
    try { me = await api("api/me"); } catch (e) { $("boot").replaceChildren(LG.problem("Can't reach the server: " + e.message)); return; }
    if (!me.user) return showLogin();
    S.me = me;
    $("login").hidden = true; $("boot").hidden = true; $("app").hidden = false;
    $("hello").textContent = "Hi, " + me.display + " 👋";
    S.collapsed = new Set(store.get("collapsed", []));
    const tabs = store.get("tabs", { open: [], active: null });
    drawModels(); drawMeter();
    setPane(mobile() ? "chat" : "chat");
    await Promise.all([loadTree().catch((e) => toast(e.message)), loadChats().catch((e) => toast(e.message))]);
    S.open = (tabs.open || []).filter((p) => S.paths.has(p) && !S.paths.get(p).dir);
    S.active = S.open.includes(tabs.active) ? tabs.active : S.open[S.open.length - 1] || null;
    drawTabs(); drawTree(); renderActive();
    loadChat();
    const draft = store.get("draft", "");
    if (draft && !$("input").value) { $("input").value = draft; $("input").dispatchEvent(new Event("input")); }
    drawTour();
  }

  function start() {
    if (!window.marked || !window.DOMPurify) {
      // A CDN script failed; still run, the renderers fall back to plain text.
      console.warn("marked/DOMPurify missing");
    }
    boot();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
