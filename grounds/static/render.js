/* Learning Grounds renderers: Markdown (+math, mermaid, embeds), quizzes,
 * flashcards, plots and the math lab. Everything the model wrote is untrusted:
 * HTML goes through DOMPurify, plain strings go in with textContent.
 * Exposes window.LG = { renderFile, renderMarkdown, renderQuiz, Plot, ... }.
 * app.js sets LG.ctx = { send(text, display), open(path), toast(msg) }. */
(function () {
  "use strict";
  const LG = (window.LG = window.LG || {});
  LG.ctx = LG.ctx || { send() {}, open() {}, toast() {} };

  // ---- tiny DOM helpers ------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
    return e;
  }
  LG.h = h;
  const PALETTE = ["#5b5bd6", "#e5484d", "#12a594", "#f76b15", "#8e4ec6", "#0090ff", "#d6409f", "#978365"];
  LG.PALETTE = PALETTE;

  function loadScript(src) {
    loadScript.cache = loadScript.cache || {};
    if (!loadScript.cache[src]) {
      loadScript.cache[src] = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src));
        document.head.append(s);
      });
    }
    return loadScript.cache[src];
  }
  const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  LG.isDark = isDark;
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function problem(msg, raw) {
    const box = h("div", { class: "problem" }, h("b", { text: "This part could not be shown. " }), h("span", { text: msg }));
    if (raw) box.append(h("details", {}, h("summary", { text: "Show the raw text" }), h("pre", { text: raw })));
    return box;
  }
  LG.problem = problem;

  // ---- paths -------------------------------------------------------------------
  function dirOf(p) { const i = (p || "").lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  function resolvePath(base, rel) {
    let r = rel.split("#")[0].split("?")[0];
    try { r = decodeURIComponent(r); } catch (e) { /* keep as is */ }
    const out = r.startsWith("/") ? [] : (base ? base.split("/") : []);
    for (const seg of r.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop(); else out.push(seg);
    }
    return out.join("/");
  }
  LG.dirOf = dirOf; LG.resolvePath = resolvePath;
  const fileUrl = (p) => "api/file?path=" + encodeURIComponent(p);
  LG.fileUrl = fileUrl;

  // ---- math --------------------------------------------------------------------
  function katexHTML(tex, display) {
    if (!window.katex) return h("code", { text: tex }).outerHTML;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
    } catch (e) {
      return h("code", { text: tex }).outerHTML;
    }
  }
  LG.katexHTML = katexHTML;

  // Pull math out before Markdown sees it (so _ and * inside TeX survive),
  // leaving code spans and fences untouched.
  function protectMath(src, store) {
    const ph = (t, display) => { store.push({ t, display }); return "MATHPH" + (store.length - 1) + "X"; };
    const parts = src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/);
    return parts.map((p, i) => (i % 2 ? p : p
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => ph(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => ph(t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => ph(t, false))
      .replace(/(^|[^\\$\w])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/g, (m, pre, t) => pre + ph(t, false))
    )).join("");
  }

  // ---- markdown ----------------------------------------------------------------
  let markedInst = null;
  let embedSink = null;
  const EMBEDS = ["mermaid", "plot", "quiz", "flash", "flashcards", "lab"];
  function md() {
    if (markedInst) return markedInst;
    markedInst = new marked.Marked({ gfm: true, breaks: false });
    markedInst.use({
      renderer: {
        code(a, b) {
          const text = typeof a === "object" && a ? a.text : a;
          const lang = String((typeof a === "object" && a ? a.lang : b) || "").trim().split(/\s+/)[0].toLowerCase();
          if (embedSink && EMBEDS.includes(lang)) {
            const i = embedSink.push({ lang, text }) - 1;
            return '<div class="embed" data-embed="' + i + '"></div>\n';
          }
          return false;
        },
      },
    });
    return markedInst;
  }

  let purifyHooked = false;
  function sanitize(html) {
    if (!purifyHooked) {
      DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A") {
          const href = node.getAttribute("href") || "";
          if (/^(https?:|mailto:)/i.test(href)) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
        }
      });
      purifyHooked = true;
    }
    return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"], FORBID_ATTR: ["style"], ADD_ATTR: ["target"] });
  }

  /** Render Markdown into el. opts: {base: folder for relative links, inline, chat} */
  function renderMarkdown(src, el, opts) {
    opts = opts || {};
    el.classList.add("md");
    if (!window.marked || !window.DOMPurify) { el.textContent = src; return; }
    const math = [];
    const embeds = [];
    embedSink = embeds;
    let html;
    try {
      const prepared = protectMath(String(src || ""), math);
      html = opts.inline ? md().parseInline(prepared) : md().parse(prepared);
    } finally {
      embedSink = null;
    }
    html = sanitize(html).replace(/MATHPH(\d+)X/g, (m, i) => (math[+i] ? katexHTML(math[+i].t, math[+i].display) : m));
    el.innerHTML = html;

    const base = opts.base || "";
    el.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (/^([a-z]+:|#|\/\/)/i.test(href)) return;
      a.addEventListener("click", (ev) => { ev.preventDefault(); LG.ctx.open(resolvePath(base, href)); });
    });
    el.querySelectorAll("img[src]").forEach((img) => {
      const s = img.getAttribute("src");
      if (!/^([a-z]+:|\/\/)/i.test(s)) img.src = fileUrl(resolvePath(base, s));
      img.loading = "lazy";
    });
    el.querySelectorAll("pre code").forEach((c) => {
      if (window.hljs) { try { hljs.highlightElement(c); } catch (e) { /* plain */ } }
    });
    el.querySelectorAll("[data-embed]").forEach((d) => hydrateEmbed(d, embeds[+d.dataset.embed], opts));
  }
  LG.renderMarkdown = renderMarkdown;

  function hydrateEmbed(div, emb, opts) {
    if (!emb) return;
    if (emb.lang === "mermaid") return renderMermaid(emb.text, div);
    let spec;
    try { spec = JSON.parse(emb.text); } catch (e) { div.append(problem("The " + emb.lang + " block is not valid JSON (" + e.message + ").", emb.text)); return; }
    try {
      if (emb.lang === "plot") renderPlotSpec(spec, div);
      else if (emb.lang === "quiz") renderQuizFile(Array.isArray(spec) ? { questions: spec } : spec, div);
      else if (emb.lang === "lab") renderLab(spec, div, opts);
      else renderFlash(Array.isArray(spec) ? { cards: spec } : spec, div);
    } catch (e) {
      div.append(problem(e.message, emb.text));
    }
  }

  let mermaidN = 0;
  async function renderMermaid(src, div) {
    div.classList.add("mermaid-box");
    div.append(h("div", { class: "mini-spin" }));
    try {
      await loadScript(MERMAID);
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default", fontFamily: "inherit" });
      const { svg } = await mermaid.render("lgm" + ++mermaidN, src);
      div.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ["foreignObject"] });
    } catch (e) {
      div.innerHTML = "";
      div.append(problem("The diagram has a mistake: " + String(e && e.message || e).split("\n")[0], src));
      document.querySelectorAll("body > [id^='dlgm']").forEach((n) => n.remove());
    }
  }

  // ---- math.js helpers ---------------------------------------------------------
  let mathReady = false;
  function M() {
    if (!window.math) throw new Error("The math library did not load. Check the internet connection and reload.");
    if (!mathReady) {
      const al = { ln: (x) => math.log(x), arcsin: (x) => math.asin(x), arccos: (x) => math.acos(x), arctan: (x) => math.atan(x), tg: (x) => math.tan(x), cotg: (x) => math.cot(x) };
      try { math.import(al, { override: false, silent: true }); } catch (e) { /* already there */ }
      mathReady = true;
    }
    return math;
  }
  function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v && typeof v.re === "number") return Math.abs(v.im) < 1e-12 ? v.re : NaN;
    if (v && typeof v.toNumber === "function") { try { return v.toNumber(); } catch (e) { return NaN; } }
    return NaN;
  }
  function normalizeExpr(s) {
    return String(s || "")
      .replace(/[−–]/g, "-").replace(/[×·⋅]/g, "*").replace(/÷/g, "/")
      .replace(/²/g, "^2").replace(/³/g, "^3").replace(/π/g, "pi").replace(/√/g, "sqrt")
      .replace(/\*\*/g, "^").trim();
  }
  const KNOWN = new Set(["pi", "e", "i", "tau", "phi", "Infinity", "E", "PI"]);
  /** Compile an expression in one variable. extra = names allowed besides v (params). */
  function compileFn(src, v, extraScope, opts) {
    v = v || "x";
    opts = opts || {};
    let s = normalizeExpr(src);
    if (opts.stripLhs) s = s.replace(/^\s*[A-Za-z]\w*\s*(\(\s*[A-Za-z]\w*\s*\))?\s*=(?!=)/, "");
    if (!s) throw new Error("empty");
    let node;
    try { node = M().parse(s); } catch (e) { throw new Error(friendlyParse(e)); }
    const scopeNames = new Set(Object.keys(extraScope || {}));
    node.traverse((n, path, parent) => {
      if (!n.isSymbolNode) return;
      if (parent && parent.isFunctionNode && path === "fn") {
        if (typeof M()[n.name] !== "function" && !scopeNames.has(n.name)) throw new Error("I don't know the function \"" + n.name + "\".");
        return;
      }
      if (n.name === v || KNOWN.has(n.name) || scopeNames.has(n.name)) return;
      if (opts.allowC && (n.name === "C" || n.name === "c")) return;
      throw new Error("\"" + n.name + "\" is not a known letter here. Use " + v + (opts.allowC ? " (and + C if you like)" : "") + ".");
    });
    const code = node.compile();
    const base = Object.assign({}, extraScope || {}, { C: 0, c: 0 });
    const f = (x) => {
      base[v] = x;
      try { return toNum(code.evaluate(base)); } catch (e) { return NaN; }
    };
    f.node = node;
    f.src = s;
    return f;
  }
  function friendlyParse(e) {
    const m = String(e && e.message || e);
    if (/Parenthesis \) expected/.test(m)) return "A closing bracket ) is missing.";
    if (/Unexpected end/.test(m)) return "The expression stops too early.";
    if (/Unexpected operator/.test(m)) return "There is an operator in an odd place: " + m.replace(/^.*operator\s*/, "");
    if (/Value expected/.test(m)) return "Something is missing: " + m;
    return m;
  }
  function texOf(src, opts) {
    let s = normalizeExpr(src);
    if (opts && opts.stripLhs) s = s.replace(/^\s*[A-Za-z]\w*\s*(\(\s*[A-Za-z]\w*\s*\))?\s*=(?!=)/, "");
    return M().parse(s).toTex({ parenthesis: "auto", implicit: "hide" });
  }
  function evalNum(s, scope) {
    return toNum(M().evaluate(normalizeExpr(String(s)), Object.assign({}, scope || {})));
  }
  LG.compileFn = compileFn; LG.texOf = texOf;

  // ---- Plot: a small canvas grapher with pan, zoom and pinch ------------------
  function niceStep(span, target) {
    const raw = span / (target || 8);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  function fmt(v) {
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    return String(+v.toFixed(4));
  }
  LG.fmt = fmt;

  class Plot {
    constructor(host, opts) {
      opts = opts || {};
      this.opts = opts;
      this.curves = []; this.fills = []; this.points = [];
      this.box = h("div", { class: "plot-box" });
      this.canvas = h("canvas", { class: "plot-canvas", role: "img", "aria-label": opts.label || "Graph" });
      if (opts.height) this.canvas.style.height = opts.height + "px";
      const tools = h("div", { class: "plot-tools" },
        h("button", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => this.zoom(0.7) }, "+"),
        h("button", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => this.zoom(1 / 0.7) }, "−"),
        h("button", { title: "Reset view", "aria-label": "Reset view", onclick: () => this.reset() }, "⟲"));
      this.readout = h("div", { class: "plot-readout", text: "Drag to move. Pinch, the buttons, or click then scroll to zoom." });
      this.box.append(this.canvas, tools);
      host.append(this.box, this.readout);
      const d = opts.domain || [-5, 5];
      this.home = { x0: +d[0], x1: +d[1], y0: null, y1: null };
      if (opts.range) { this.home.y0 = +opts.range[0]; this.home.y1 = +opts.range[1]; }
      this.view = null;
      this.active = false;
      this._wire();
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(this.canvas);
      LG._plots.add(this);
    }
    set(data) {
      Object.assign(this, data);
      if (!this.view) this.reset(); else this.draw();
    }
    autoY() {
      const { x0, x1 } = this.home;
      const ys = [];
      for (const c of this.curves) {
        for (let k = 0; k <= 200; k++) {
          const y = c.f(x0 + (x1 - x0) * k / 200);
          if (isFinite(y)) ys.push(y);
        }
      }
      for (const p of this.points) if (isFinite(p.y)) ys.push(p.y);
      if (!ys.length) return [-5, 5];
      ys.sort((a, b) => a - b);
      let lo = ys[Math.floor(ys.length * 0.03)], hi = ys[Math.ceil(ys.length * 0.97) - 1];
      for (const p of this.points) if (isFinite(p.y)) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
      if (lo > 0 && lo < (hi - lo) * 0.5) lo = 0;
      if (hi < 0 && -hi < (hi - lo) * 0.5) hi = 0;
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12;
      return [lo - pad, hi + pad];
    }
    reset() {
      let { x0, x1, y0, y1 } = this.home;
      if (y0 == null || y1 == null) [y0, y1] = this.autoY();
      this.view = { x0, x1, y0, y1 };
      this.draw();
    }
    zoom(f, cx, cy) {
      const v = this.view;
      cx = cx == null ? (v.x0 + v.x1) / 2 : cx;
      cy = cy == null ? (v.y0 + v.y1) / 2 : cy;
      this.view = { x0: cx + (v.x0 - cx) * f, x1: cx + (v.x1 - cx) * f, y0: cy + (v.y0 - cy) * f, y1: cy + (v.y1 - cy) * f };
      this.draw();
    }
    toWorld(px, py) {
      const r = this.canvas.getBoundingClientRect(), v = this.view;
      return [v.x0 + (px / r.width) * (v.x1 - v.x0), v.y1 - (py / r.height) * (v.y1 - v.y0)];
    }
    _wire() {
      const c = this.canvas, ptrs = new Map();
      let last = null;
      c.addEventListener("pointerdown", (e) => {
        c.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
        this.active = true;
        last = null;
      });
      const up = (e) => { ptrs.delete(e.pointerId); last = null; };
      c.addEventListener("pointerup", up);
      c.addEventListener("pointercancel", up);
      c.addEventListener("pointermove", (e) => {
        if (!this.view) return;
        const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
        if (!ptrs.size) { this.readout.textContent = "x = " + fmt(wx) + "   y = " + fmt(wy); return; }
        ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
        const r = c.getBoundingClientRect(), v = this.view;
        const pts = [...ptrs.values()];
        if (pts.length === 1) {
          if (last && last.n === 1) {
            const dx = (pts[0][0] - last.p[0]) / r.width * (v.x1 - v.x0);
            const dy = (pts[0][1] - last.p[1]) / r.height * (v.y1 - v.y0);
            this.view = { x0: v.x0 - dx, x1: v.x1 - dx, y0: v.y0 + dy, y1: v.y1 + dy };
            this.draw();
          }
          last = { n: 1, p: pts[0] };
        } else if (pts.length >= 2) {
          const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
          const dist = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
          if (last && last.n === 2) {
            const [cx, cy] = this.toWorld(mid[0], mid[1]);
            this.zoom(last.dist / dist, cx, cy);
          }
          last = { n: 2, dist };
        }
      });
      c.addEventListener("pointerleave", () => { if (!ptrs.size) this.readout.textContent = ""; });
      c.addEventListener("wheel", (e) => {
        if (!this.active && !e.ctrlKey) { this.readout.textContent = "Click the graph first, then scroll to zoom."; return; }
        e.preventDefault();
        const [cx, cy] = this.toWorld(e.offsetX, e.offsetY);
        this.zoom(Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) / 300), cx, cy);
      }, { passive: false });
      document.addEventListener("pointerdown", (e) => { if (e.target !== c) this.active = false; });
    }
    draw() {
      if (!this.view) return;
      const c = this.canvas;
      if (!c.isConnected) { this._ro.disconnect(); LG._plots.delete(this); return; }
      const r = c.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = r.height, v = this.view;
      const X = (x) => (x - v.x0) / (v.x1 - v.x0) * W;
      const Y = (y) => (v.y1 - y) / (v.y1 - v.y0) * H;
      g.fillStyle = cssVar("--plot-bg") || "#fff"; g.fillRect(0, 0, W, H);

      // grid + labels
      const sx = niceStep(v.x1 - v.x0, Math.max(4, W / 80)), sy = niceStep(v.y1 - v.y0, Math.max(4, H / 60));
      g.lineWidth = 1; g.strokeStyle = cssVar("--plot-grid");
      g.beginPath();
      for (let x = Math.ceil(v.x0 / sx) * sx; x <= v.x1; x += sx) { g.moveTo(Math.round(X(x)) + .5, 0); g.lineTo(Math.round(X(x)) + .5, H); }
      for (let y = Math.ceil(v.y0 / sy) * sy; y <= v.y1; y += sy) { g.moveTo(0, Math.round(Y(y)) + .5); g.lineTo(W, Math.round(Y(y)) + .5); }
      g.stroke();
      const ax = cssVar("--plot-axis");
      g.strokeStyle = ax; g.lineWidth = 1.5; g.beginPath();
      const y0px = Math.min(H, Math.max(0, Y(0))), x0px = Math.min(W, Math.max(0, X(0)));
      if (v.y0 <= 0 && v.y1 >= 0) { g.moveTo(0, y0px); g.lineTo(W, y0px); }
      if (v.x0 <= 0 && v.x1 >= 0) { g.moveTo(x0px, 0); g.lineTo(x0px, H); }
      g.stroke();
      g.fillStyle = ax; g.font = "11px ui-sans-serif, system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "top";
      const ly = Math.min(H - 14, Math.max(2, y0px + 3));
      for (let x = Math.ceil(v.x0 / sx) * sx; x <= v.x1; x += sx) { if (Math.abs(x) > sx / 2) g.fillText(fmt(+x.toPrecision(12)), X(x), ly); }
      g.textAlign = "left"; g.textBaseline = "middle";
      const lx = Math.min(W - 30, Math.max(3, x0px + 4));
      for (let y = Math.ceil(v.y0 / sy) * sy; y <= v.y1; y += sy) { if (Math.abs(y) > sy / 2) g.fillText(fmt(+y.toPrecision(12)), lx, Y(y)); }

      const N = Math.max(200, Math.round(W * 1.5));
      const span = v.y1 - v.y0;
      // fills
      for (const f of this.fills) {
        const a = Math.max(v.x0, f.from == null ? v.x0 : f.from), b = Math.min(v.x1, f.to == null ? v.x1 : f.to);
        if (!(b > a)) continue;
        g.fillStyle = f.color; g.globalAlpha = f.alpha == null ? 0.25 : f.alpha;
        const steps = Math.max(60, Math.round((X(b) - X(a)) * 1.2));
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            g.beginPath();
            run.forEach(([x, t], k) => (k ? g.lineTo(X(x), Y(t)) : g.moveTo(X(x), Y(t))));
            for (let k = run.length - 1; k >= 0; k--) g.lineTo(X(run[k][0]), Y(run[k][2]));
            g.closePath(); g.fill();
          }
          run = [];
        };
        for (let k = 0; k <= steps; k++) {
          const x = a + (b - a) * k / steps;
          const t = f.top(x), bo = f.bottom ? f.bottom(x) : 0;
          const ok = isFinite(t) && isFinite(bo) && (!f.where || f.where(x, t, bo));
          if (ok) run.push([x, clamp(t, v, span), clamp(bo, v, span)]); else flush();
        }
        flush();
        g.globalAlpha = 1;
      }
      // curves
      for (const cv of this.curves) {
        g.strokeStyle = cv.color; g.lineWidth = cv.width || 2.5; g.setLineDash(cv.dash ? [7, 6] : []);
        g.globalAlpha = cv.alpha == null ? 1 : cv.alpha;
        g.lineJoin = "round"; g.lineCap = "round";
        g.beginPath();
        let pen = false, py = null;
        for (let k = 0; k <= N; k++) {
          const x = v.x0 + (v.x1 - v.x0) * k / N, y = cv.f(x);
          if (!isFinite(y) || Math.abs(y - (v.y0 + v.y1) / 2) > span * 50) { pen = false; py = null; continue; }
          if (pen && py != null && Math.abs(y - py) > span * 2) pen = false;   // asymptote jump
          const px = X(x), pyy = Y(clamp(y, v, span));
          if (pen) g.lineTo(px, pyy); else g.moveTo(px, pyy);
          pen = true; py = y;
        }
        g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
      }
      // points
      for (const p of this.points) {
        if (!isFinite(p.x) || !isFinite(p.y)) continue;
        const px = X(p.x), py = Y(p.y);
        g.strokeStyle = p.color || cssVar("--text"); g.fillStyle = p.color || cssVar("--text"); g.lineWidth = 2.5;
        if (p.style === "x") {
          g.beginPath(); g.moveTo(px - 6, py - 6); g.lineTo(px + 6, py + 6); g.moveTo(px + 6, py - 6); g.lineTo(px - 6, py + 6); g.stroke();
        } else if (p.style === "ring") {
          g.beginPath(); g.arc(px, py, 8, 0, Math.PI * 2); g.stroke();
        } else {
          g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill();
        }
        if (p.label) {
          g.font = "600 12px ui-sans-serif, system-ui, sans-serif";
          g.textAlign = px > W - 120 ? "right" : "left"; g.textBaseline = "bottom";
          const tx = px + (g.textAlign === "right" ? -10 : 10), ty = Math.max(14, py - 8);
          g.lineWidth = 4; g.strokeStyle = cssVar("--plot-bg"); g.strokeText(p.label, tx, ty);
          g.fillText(p.label, tx, ty);
        }
      }
    }
  }
  function clamp(y, v, span) { return Math.max(v.y0 - span * 3, Math.min(v.y1 + span * 3, y)); }
  LG._plots = new Set();
  LG.redrawPlots = () => LG._plots.forEach((p) => p.draw());
  LG.Plot = Plot;

  function legend(items) {
    return h("div", { class: "legend" }, items.map((it) => h("span", {},
      h("i", { class: (it.dash ? "dashed" : "") + (it.area ? " area-sw" : ""), style: it.dash ? "border-color:" + it.color : "background:" + it.color }),
      it.label)));
  }
  LG.legend = legend;

  function simpson(f, a, b, n) {
    n = n || 400;
    const hh = (b - a) / n;
    let s = f(a) + f(b);
    for (let k = 1; k < n; k++) s += f(a + k * hh) * (k % 2 ? 4 : 2);
    return s * hh / 3;
  }

  // ---- .plot.json --------------------------------------------------------------
  function renderPlotSpec(spec, host) {
    if (!spec || !Array.isArray(spec.functions) || !spec.functions.length) throw new Error("A plot needs a \"functions\" list.");
    const card = h("div", { class: "card plot-card" });
    host.append(card);
    if (spec.title) card.append(h("div", { class: "card-title", text: spec.title }));
    if (spec.description) { const d = h("div"); renderMarkdown(spec.description, d); card.append(d); }
    const params = {};
    for (const [k, p] of Object.entries(spec.params || {})) params[k] = +(p.value != null ? p.value : p.min != null ? p.min : 1);
    const plot = new Plot(card, { domain: spec.domain || [-5, 5], range: spec.range, label: spec.title });
    const legendBox = h("div");
    card.append(legendBox);

    const fns = spec.functions.map((fd, i) => {
      const expr = typeof fd === "string" ? fd : fd.expr;
      let f;
      try { f = compileFn(expr, spec.var || "x", params, { stripLhs: true }); }
      catch (e) { throw new Error("Function \"" + expr + "\": " + e.message); }
      return { f, label: (fd && fd.label) || "y = " + expr, color: (fd && fd.color) || PALETTE[i % PALETTE.length], dash: fd && fd.dash };
    });
    let area = null;
    if (spec.area) {
      const a = spec.area;
      area = { top: compileFn(a.expr || (typeof spec.functions[0] === "string" ? spec.functions[0] : spec.functions[0].expr), spec.var || "x", params, { stripLhs: true }),
               bottom: a.expr2 ? compileFn(a.expr2, spec.var || "x", params, { stripLhs: true }) : null,
               color: a.color || fns[0].color };
    }
    const update = () => {
      const curves = fns.map((d) => ({ f: d.f, color: d.color, dash: d.dash }));
      const fills = [];
      const items = fns.map((d) => ({ label: d.label, color: d.color, dash: d.dash }));
      if (area) {
        const from = evalNum(spec.area.from, params), to = evalNum(spec.area.to, params);
        fills.push({ top: area.top, bottom: area.bottom, from: Math.min(from, to), to: Math.max(from, to), color: area.color, alpha: 0.28 });
        const val = simpson((x) => { const t = area.top(x), b = area.bottom ? area.bottom(x) : 0; return isFinite(t) && isFinite(b) ? t - b : 0; }, from, to);
        items.push({ label: (spec.area.label || "Shaded area") + " ≈ " + fmt(+val.toFixed(4)) + "  (from " + fmt(from) + " to " + fmt(to) + ")", color: area.color, area: true });
      }
      const points = (spec.points || []).map((p) => {
        const P = Array.isArray(p) ? { x: p[0], y: p[1] } : p;
        return { x: evalNum(P.x, params), y: evalNum(P.y, params), label: P.label, color: P.color };
      });
      plot.set({ curves, fills, points });
      legendBox.replaceChildren(legend(items));
    };
    const pnames = Object.keys(spec.params || {});
    if (pnames.length) {
      const box = h("div", { class: "sliders" });
      for (const k of pnames) {
        const p = spec.params[k];
        const out = h("output", { text: fmt(params[k]) });
        const inp = h("input", { type: "range", min: p.min != null ? p.min : -5, max: p.max != null ? p.max : 5, step: p.step || 0.1, value: params[k], "aria-label": k });
        inp.addEventListener("input", () => { params[k] = +inp.value; out.textContent = fmt(params[k]); update(); });
        box.append(h("label", { class: "slider" }, h("b", { text: p.label || k }), inp, out));
      }
      card.append(box);
    }
    update();
  }
  LG.renderPlotSpec = renderPlotSpec;

  // ---- quizzes ------------------------------------------------------------------
  let quizN = 0;
  /**
   * opts: {mode: "chat"|"file", readOnly, onDone(resultText, score, total)}
   */
  function renderQuiz(questions, host, opts) {
    opts = opts || {};
    const id = "qz" + ++quizN;
    if (!Array.isArray(questions) || !questions.length) throw new Error("The quiz has no questions.");
    const picks = new Array(questions.length).fill(null);
    const wrap = h("div", { class: "quiz" });
    const qEls = questions.map((q, qi) => {
      const opts_ = Array.isArray(q.options) ? q.options : [];
      const qt = h("div", { class: "q-text" });
      const qtBody = h("span");
      renderMarkdown(String(q.question || ""), qtBody, { inline: true });
      qt.append(h("span", { class: "q-num", text: (qi + 1) + "." }), qtBody);
      const optEls = opts_.map((o, oi) => {
        const inp = h("input", { type: "radio", name: id + "-" + qi, value: oi, disabled: opts.readOnly });
        const lab = h("span", { class: "grow" });
        renderMarkdown(String(o), lab, { inline: true });
        const row = h("label", { class: "opt" + (opts.readOnly ? " locked" : "") }, inp, lab);
        inp.addEventListener("change", () => {
          picks[qi] = oi;
          optEls.forEach((r) => r.classList.remove("picked"));
          row.classList.add("picked");
        });
        return row;
      });
      const expl = h("div", { class: "expl", hidden: true });
      const el = h("div", { class: "q" }, qt, h("div", { class: "opts" }, optEls), expl);
      wrap.append(el);
      return { el, optEls, expl, q };
    });
    const msg = h("div", { class: "err" });
    const scoreEl = h("div", { class: "score", hidden: true });
    const actions = h("div", { class: "actions" });
    wrap.append(scoreEl, msg, actions);
    host.append(wrap);

    const reveal = (showPicks) => {
      qEls.forEach(({ optEls, expl, q }, qi) => {
        optEls.forEach((r, oi) => {
          r.classList.add("locked");
          r.querySelector("input").disabled = true;
          if (oi === q.answer) r.classList.add("right");
          else if (showPicks && picks[qi] === oi) r.classList.add("wrong");
        });
        const ok = picks[qi] === q.answer;
        expl.hidden = false;
        expl.replaceChildren();
        if (showPicks) expl.append(h("span", { class: "verdict " + (ok ? "ok" : "no"), text: ok ? "✓ Right!" : "✗ Not quite." }), " ");
        const body = h("span");
        renderMarkdown(String(q.explanation || ""), body, { inline: true });
        expl.append(body);
      });
    };

    if (opts.readOnly) {
      qEls.forEach(({ expl }) => { expl.hidden = true; });
      const btn = h("button", { class: "btn small ghost", type: "button", text: "Show answers" });
      btn.onclick = () => { reveal(false); btn.remove(); };
      actions.append(btn);
      return wrap;
    }

    const submit = h("button", { class: "btn primary", type: "button", text: "Check my answers" });
    actions.append(submit);
    submit.onclick = () => {
      const missing = picks.map((p, i) => (p == null ? i + 1 : null)).filter(Boolean);
      if (missing.length) { msg.textContent = "Answer every question first (missing: " + missing.join(", ") + ")."; return; }
      msg.textContent = "";
      reveal(true);
      const score = picks.filter((p, i) => p === questions[i].answer).length;
      const total = questions.length;
      scoreEl.hidden = false;
      scoreEl.textContent = (score === total ? "🎉 " : score >= total / 2 ? "👍 " : "💪 ") + "You got " + score + " of " + total + " right.";
      const lines = questions.map((q, i) => {
        const ok = picks[i] === q.answer;
        return (i + 1) + ". " + q.question + "\n   My answer: " + q.options[picks[i]] + (ok ? "  ✓ correct" : "  ✗ wrong (correct: " + q.options[q.answer] + ")");
      });
      const text = "Quiz results" + (opts.title ? " for \"" + opts.title + "\"" : "") + ": " + score + "/" + total + "\n\n" + lines.join("\n");
      submit.remove();
      if (opts.mode === "chat") {
        LG.ctx.send(text, "Quiz: " + score + "/" + total);
      } else {
        const send = h("button", { class: "btn primary", type: "button", text: "Send results to teacher" });
        send.onclick = () => { LG.ctx.send(text, "Quiz" + (opts.title ? " \"" + opts.title + "\"" : "") + ": " + score + "/" + total); send.disabled = true; send.textContent = "Sent ✓"; };
        const again = h("button", { class: "btn ghost", type: "button", text: "Try again" });
        again.onclick = () => { const p = wrap.parentNode; const nw = h("div"); wrap.replaceWith(nw); renderQuiz(questions, nw, opts); };
        actions.append(send, again);
      }
      if (opts.onDone) opts.onDone(text, score, total);
    };
    return wrap;
  }
  LG.renderQuiz = renderQuiz;

  function renderQuizFile(spec, host) {
    const qs = spec && (spec.questions || spec);
    const card = h("div", { class: "card" });
    host.append(card);
    if (spec.title) card.append(h("div", { class: "card-title", text: spec.title }));
    if (spec.intro) { const d = h("div"); renderMarkdown(spec.intro, d); card.append(d); }
    renderQuiz(qs, card, { mode: "file", title: spec.title });
  }

  // ---- flashcards ---------------------------------------------------------------
  function renderFlash(spec, host) {
    const cards = (spec && spec.cards) || [];
    if (!cards.length) throw new Error("No cards in this deck.");
    const wrap = h("div", { class: "flash-wrap" });
    host.append(wrap);
    let queue, known, flipped;
    const restart = (shuffle) => {
      queue = cards.map((_, i) => i);
      if (shuffle) for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
      known = 0; flipped = false; draw();
    };
    const face = (text, cls, hint) => {
      const f = h("div", { class: "flash-face " + cls });
      const body = h("div");
      renderMarkdown(String(text || ""), body);
      f.append(body, h("div", { class: "hint", text: hint }));
      return f;
    };
    const draw = () => {
      wrap.replaceChildren();
      if (spec.title) wrap.append(h("div", { class: "card-title", text: spec.title }));
      const bar = h("div", { class: "progress" }, h("div", { style: "width:" + (known / cards.length * 100) + "%" }));
      wrap.append(bar);
      if (!queue.length) {
        wrap.append(h("div", { class: "flash-done" }, h("div", { class: "big-emoji", text: "🎉" }),
          h("h3", { text: "You know all " + cards.length + " cards!" }),
          h("div", { class: "actions", style: "justify-content:center" },
            h("button", { class: "btn primary", onclick: () => restart(true) }, "Go again (shuffled)"),
            h("button", { class: "btn ghost", onclick: () => LG.ctx.send("I finished the flashcards \"" + (spec.title || "deck") + "\" (" + cards.length + " cards).", "Flashcards done: " + (spec.title || "deck") + " ✓") }, "Tell my teacher"))));
        return;
      }
      const c = cards[queue[0]];
      wrap.append(h("div", { class: "flash-meta" }, h("span", { text: queue.length + " to go" }), h("span", { text: known + " known" })));
      const fc = h("div", { class: "flash-card" + (flipped ? " flipped" : ""), tabindex: "0", role: "button", "aria-label": "Flip card" },
        h("div", { class: "flash-inner" }, face(c.front, "front", "Tap to flip"), face(c.back, "back", "Tap to flip back")));
      const flip = () => { flipped = !flipped; fc.classList.toggle("flipped", flipped); };
      fc.addEventListener("click", (e) => { if (!e.target.closest("a")) flip(); });
      fc.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
      const again = () => { const i = queue.shift(); queue.splice(Math.min(3, queue.length), 0, i); flipped = false; draw(); };
      const know = () => { queue.shift(); known++; flipped = false; draw(); };
      wrap.append(fc, h("div", { class: "flash-btns" },
        h("button", { class: "btn", onclick: again }, "🔁 Again"),
        h("button", { class: "btn good", onclick: know }, "✓ I knew it")),
        h("div", { class: "actions", style: "justify-content:center" }, h("button", { class: "btn small ghost", onclick: () => restart(true) }, "Shuffle and restart")));
    };
    restart(false);
  }
  LG.renderFlash = renderFlash;

  // ---- math lab -----------------------------------------------------------------
  const KIND_LABEL = { expression: "Write the expression", antiderivative: "Find an antiderivative", derivative: "Find the derivative", equation: "Solve the equation" };

  function samplePoints(a, b, n) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(a + (b - a) * ((k + 0.5 + 0.35 * Math.sin(k * 12.9898)) / n));
    return out;
  }
  function numDeriv(F, x) {
    const hh = 1e-4 * (1 + Math.abs(x));
    return (F(x + hh) - F(x - hh)) / (2 * hh);
  }
  function worstPoints(rows, a, b, k) {
    const sorted = rows.filter((r) => r.bad).sort((p, q) => q.err - p.err);
    const picked = [];
    for (const r of sorted) {
      if (picked.length >= k) break;
      if (picked.every((p) => Math.abs(p.x - r.x) > (b - a) / 8)) picked.push(r);
    }
    return picked;
  }

  /** Compare two functions on [a,b]. Returns {ok, rows, checked, matched}. */
  function compareFns(mine, correct, a, b, tolRel) {
    const rows = [];
    for (const x of samplePoints(a, b, 50)) {
      const t = correct(x);
      if (!isFinite(t)) continue;
      const u = mine(x);
      const err = isFinite(u) ? Math.abs(u - t) : Infinity;
      rows.push({ x, u, t, err, bad: !(err <= tolRel * (1 + Math.abs(t))) });
    }
    const matched = rows.filter((r) => !r.bad).length;
    return { ok: rows.length >= 8 && matched === rows.length, rows, checked: rows.length, matched };
  }

  function findRoots(hf, a, b) {
    const N = 2000, roots = [];
    const xs = [], ys = [];
    for (let k = 0; k <= N; k++) { const x = a + (b - a) * k / N; xs.push(x); ys.push(hf(x)); }
    const scale = Math.max(1e-9, ...ys.filter(isFinite).map(Math.abs).slice(0, 4000)) || 1;
    const add = (r) => { if (isFinite(r) && !roots.some((q) => Math.abs(q - r) < 1e-4 * (1 + Math.abs(r)))) roots.push(r); };
    for (let k = 0; k < N; k++) {
      const y0 = ys[k], y1 = ys[k + 1];
      if (!isFinite(y0) || !isFinite(y1)) continue;
      if (y0 === 0) { add(xs[k]); continue; }
      if (y0 * y1 < 0) {
        let lo = xs[k], hi = xs[k + 1], flo = y0;
        for (let it = 0; it < 80; it++) {
          const m = (lo + hi) / 2, fm = hf(m);
          if (!isFinite(fm)) break;
          if (flo * fm <= 0) hi = m; else { lo = m; flo = fm; }
        }
        const r = (lo + hi) / 2;
        if (Math.abs(hf(r)) < 1e-6 * (1 + scale)) add(r);         // skip sign flips at asymptotes
      } else if (k > 0 && isFinite(ys[k - 1]) && Math.abs(y0) <= Math.abs(ys[k - 1]) && Math.abs(y0) <= Math.abs(y1) && Math.abs(y0) < 1e-2 * (1 + scale)) {
        // touching root (like (x-1)^2 = 0): refine the minimum of |h|
        let lo = xs[k - 1], hi = xs[k + 1];
        for (let it = 0; it < 100; it++) {
          const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
          if (Math.abs(hf(m1)) < Math.abs(hf(m2))) hi = m2; else lo = m1;
        }
        const r = (lo + hi) / 2;
        if (Math.abs(hf(r)) < 1e-9 * (1 + scale)) add(r);
      }
    }
    return roots.sort((p, q) => p - q);
  }

  function renderLab(spec, host, opts) {
    opts = opts || {};
    if (!spec || !Array.isArray(spec.tasks)) throw new Error("A lab needs a \"tasks\" list.");
    M();
    const wrap = h("div", { class: "lab" });
    host.append(wrap);
    if (spec.title) wrap.append(h("h1", { class: "card-title", text: spec.title, style: "font-size:1.6em" }));
    if (spec.intro) { const d = h("div"); renderMarkdown(spec.intro, d, opts); wrap.append(d); }
    spec.tasks.forEach((task, ti) => wrap.append(labTask(spec, task, ti, opts)));
    wrap.append(scratchArea(spec));
  }
  LG.renderLab = renderLab;

  function labTask(spec, task, ti, opts) {
    const kind = task.kind || "expression";
    const v = task.var || "x";
    const dom = Array.isArray(task.domain) ? task.domain.map(Number) : kind === "equation" ? [-10, 10] : [-4, 4];
    const el = h("div", { class: "task" });
    el.append(h("div", { class: "task-head" }, h("span", { class: "task-num", text: ti + 1 }), h("span", { class: "task-kind", text: KIND_LABEL[kind] || kind })));
    const pr = h("div");
    renderMarkdown(String(task.prompt || ""), pr, opts);
    el.append(pr);

    const pre = kind === "antiderivative" ? "F(" + v + ") =" : kind === "derivative" ? "f′(" + v + ") =" : kind === "equation" ? v + " =" : "";
    const input = h("input", { type: "text", placeholder: kind === "equation" ? "e.g. 2, -3  (or: none)" : "type your answer here", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": "Your answer" });
    const preview = h("div", { class: "preview" });
    const result = h("div");
    const extra = h("div");
    let lastCheck = null, revealed = false;
    el.append(h("div", { class: "answer-row" }, pre ? h("span", { class: "pre", text: pre }) : null, input), preview);

    const updatePreview = () => {
      const s = input.value.trim();
      if (!s) { preview.replaceChildren(); preview.className = "preview"; return; }
      try {
        let tex;
        if (kind === "equation") tex = s.split(/[,;]|\bor\b|\band\b/).filter((x) => x.trim()).map((x) => texOf(x.replace(/^\s*\w+\s*=/, ""))).join(",\\quad ");
        else tex = texOf(s, { stripLhs: true });
        preview.className = "preview";
        preview.innerHTML = katexHTML((pre ? pre.replace("′", "'").replace(/=$/, "") + "= " : "") + tex, false);
      } catch (e) {
        preview.className = "preview bad";
        preview.textContent = "…keep typing";
      }
    };
    input.addEventListener("input", updatePreview);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); check(); } });

    const check = () => {
      const s = input.value.trim();
      result.replaceChildren();
      if (!s) { result.append(h("div", { class: "result info", text: "Type an answer first." })); return; }
      try {
        lastCheck = kind === "equation" ? checkEquation(task, s, v, dom, result) : checkFunction(task, kind, s, v, dom, result);
      } catch (e) {
        lastCheck = { ok: false, summary: "could not read the answer: " + e.message };
        result.append(h("div", { class: "result no" }, h("b", { text: "Hmm, I can't read that. " }), e.message));
      }
      el.classList.toggle("solved", !!(lastCheck && lastCheck.ok));
      sendBtn.hidden = false;
    };

    const checkBtn = h("button", { class: "btn primary", type: "button", onclick: check }, "Check");
    const sendBtn = h("button", { class: "btn ghost", type: "button", hidden: true }, "Send to teacher");
    sendBtn.onclick = () => {
      const t = "Lab" + (spec.title ? " \"" + spec.title + "\"" : "") + ", task " + (ti + 1) + " (" + kind + "): " + task.prompt +
        "\nMy answer: " + input.value.trim() + "\nChecker says: " + (lastCheck ? lastCheck.summary : "not checked") + (revealed ? "\n(I looked at the solution.)" : "");
      LG.ctx.send(t, "Lab task " + (ti + 1) + ": " + (lastCheck && lastCheck.ok ? "✓" : "✗") + " " + input.value.trim());
      sendBtn.textContent = "Sent ✓";
    };
    const actions = h("div", { class: "actions" }, checkBtn);
    if (task.hint) actions.append(h("button", { class: "btn ghost", type: "button", onclick: (e) => { e.target.remove(); const r = h("div", { class: "reveal" }); renderMarkdown("**Hint:** " + task.hint, r); extra.append(r); } }, "💡 Hint"));
    if (task.solution) actions.append(h("button", { class: "btn ghost", type: "button", onclick: (e) => {
      e.target.remove(); revealed = true;
      const r = h("div", { class: "reveal" });
      const sol = String(task.solution);
      renderMarkdown("**Solution:** " + (/[$\\]/.test(sol) || /\s{1}[a-z]{3,}\s/i.test(sol) ? sol : "$" + safeTex(sol, kind) + "$"), r);
      extra.append(r);
    } }, "Show solution"));
    actions.append(sendBtn);
    el.append(actions, extra, result);
    return el;
  }
  function safeTex(s, kind) {
    try { return kind === "equation" ? s.split(",").map((x) => texOf(x)).join(",\\ ") : texOf(s, { stripLhs: true }); } catch (e) { return s.replace(/[$]/g, ""); }
  }

  function checkFunction(task, kind, s, v, dom, out) {
    const [a, b] = dom;
    const target = compileFn(task.target, v);
    const mine = compileFn(s, v, {}, { stripLhs: true, allowC: kind === "antiderivative" });
    let correct, mineCmp, labels, tol = 1e-5;
    const c1 = cssVar("--good") || PALETTE[2], c2 = PALETTE[0];
    if (kind === "antiderivative") {
      correct = target;                                    // f
      mineCmp = (x) => numDeriv(mine, x);                  // F'
      tol = 2e-3;
      labels = { mine: "slope of your F(" + v + ")", correct: "f(" + v + ") = " + task.target };
    } else if (kind === "derivative") {
      let d;
      try { d = M().derivative(target.node, v).compile(); } catch (e) { d = null; }
      correct = d ? (x) => { try { return toNum(d.evaluate({ [v]: x })); } catch (e) { return NaN; } } : (x) => numDeriv(target, x);
      if (!d) tol = 2e-3;
      mineCmp = mine;
      labels = { mine: "your answer", correct: "correct derivative" };
    } else {
      correct = target; mineCmp = mine;
      labels = { mine: "your answer", correct: "correct" };
    }
    const cmp = compareFns(mineCmp, correct, a, b, tol);
    if (cmp.checked < 8) throw new Error("this task's target can't be evaluated on its domain; tell your teacher.");
    const worst = worstPoints(cmp.rows, a, b, 3);
    let summary;
    const box = h("div", { class: "result " + (cmp.ok ? "ok" : "no") });
    if (cmp.ok) {
      const msg = kind === "antiderivative" ? "✓ Correct! The slope of your F matches f everywhere we checked (any + C is fine)."
        : "✓ Correct! It matches at all " + cmp.checked + " test points.";
      box.append(h("b", { text: msg }));
      summary = "correct (" + cmp.checked + "/" + cmp.checked + " points match)";
    } else {
      const w = worst[0];
      const what = kind === "antiderivative" ? "the slope of your F is " : "your answer gives ";
      box.append(h("b", { text: "✗ Not yet. " }),
        "At " + v + " = " + fmt(w.x) + ", " + what + (isFinite(w.u) ? fmt(w.u) : "undefined") + " but it should be " + fmt(w.t) + ". " +
        "It matches at " + cmp.matched + " of " + cmp.checked + " test points. The red areas on the graph show where it differs.");
      summary = "wrong: matches at " + cmp.matched + "/" + cmp.checked + " points; at " + v + "=" + fmt(w.x) + " got " + fmt(w.u) + ", expected " + fmt(w.t);
    }
    out.append(box);
    const pbox = h("div", { style: "margin-top:10px" });
    out.append(pbox);
    const plot = new Plot(pbox, { domain: dom, height: 280 });
    const curves = [{ f: correct, color: c1, width: 3 }, { f: mineCmp, color: c2, width: 2.5, dash: true }];
    if (kind === "antiderivative") curves.push({ f: mine, color: PALETTE[4], width: 1.5, alpha: 0.6 });
    const bad = cssVar("--bad") || "#d64545";
    const fills = cmp.ok ? [] : [{ top: mineCmp, bottom: correct, color: bad, alpha: 0.22, where: (x, t, bo) => Math.abs(t - bo) > tol * (1 + Math.abs(bo)) }];
    const points = worst.map((w) => ({ x: w.x, y: isFinite(w.u) ? w.u : w.t, style: "ring", color: bad, label: isFinite(w.u) ? fmt(w.u) + " vs " + fmt(w.t) : "undefined" }));
    plot.set({ curves, fills, points });
    const items = [{ label: labels.correct, color: c1 }, { label: labels.mine, color: c2, dash: true }];
    if (kind === "antiderivative") items.push({ label: "your F(" + v + ") itself", color: PALETTE[4] });
    if (!cmp.ok) items.push({ label: "where they differ", color: bad, area: true });
    pbox.append(legend(items));
    return { ok: cmp.ok, summary };
  }

  function checkEquation(task, s, v, dom, out) {
    const parts = String(task.target).split(/(?<![<>=!])=(?!=)/);
    if (parts.length !== 2) throw new Error("this equation target needs exactly one '='; tell your teacher.");
    const L = compileFn(parts[0], v), R = compileFn(parts[1], v);
    const hf = (x) => L(x) - R(x);
    const truth = findRoots(hf, dom[0], dom[1]);
    const none = /^(none|no solutions?|no solution|∅|\{\})$/i.test(s.trim());
    const given = none ? [] : s.split(/[,;]|\bor\b|\band\b/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const val = x.replace(new RegExp("^\\s*" + v + "\\s*=\\s*"), "");
      const n = evalNum(val);
      if (!isFinite(n)) throw new Error("\"" + x + "\" is not a number I can use.");
      return { raw: x, x: n };
    });
    const uniq = [];
    for (const g of given) if (!uniq.some((u) => Math.abs(u.x - g.x) < 1e-9)) uniq.push(g);
    const near = (x) => truth.find((r) => Math.abs(r - x) <= 2e-3 * (1 + Math.abs(r)));
    const good = [], bad = [];
    for (const g of uniq) {
      const resid = hf(g.x);
      if (near(g.x) != null || Math.abs(resid) < 1e-9 * (1 + Math.abs(L(g.x)) + Math.abs(R(g.x)))) good.push(g); else bad.push(g);
    }
    const missing = truth.filter((r) => !uniq.some((g) => Math.abs(g.x - r) <= 2e-3 * (1 + Math.abs(r))));
    const ok = bad.length === 0 && missing.length === 0;
    const box = h("div", { class: "result " + (ok ? "ok" : "no") });
    const lines = [];
    if (ok) {
      box.append(h("b", { text: truth.length ? "✓ Correct! " + (truth.length === 1 ? "That is the solution." : "You found all " + truth.length + " solutions.") : "✓ Correct! There is no solution in this range." }));
    } else {
      box.append(h("b", { text: "✗ Not yet. " }));
      if (good.length) lines.push("✓ " + good.map((g) => v + " = " + g.raw).join(", ") + (good.length === 1 ? " works." : " work."));
      for (const g of bad) lines.push("✗ " + v + " = " + g.raw + " does not work: the left side is " + fmt(L(g.x)) + " but the right side is " + fmt(R(g.x)) + ".");
      if (missing.length) lines.push("You are missing " + missing.length + " solution" + (missing.length > 1 ? "s" : "") + " (look at the rings on the graph where the curves cross).");
      if (!truth.length && none === false && !bad.length) lines.push("There is no solution in this range.");
      box.append(lines.join(" "));
    }
    out.append(box);
    const pbox = h("div", { style: "margin-top:10px" });
    out.append(pbox);
    const plot = new Plot(pbox, { domain: dom, height: 280 });
    const goodC = cssVar("--good") || "#1f9d55", badC = cssVar("--bad") || "#d64545";
    const points = [];
    for (const g of good) points.push({ x: g.x, y: L(g.x), color: goodC, label: v + " = " + fmt(g.x) + " ✓" });
    for (const g of bad) points.push({ x: g.x, y: L(g.x), style: "x", color: badC, label: v + " = " + fmt(g.x) + " ✗" });
    for (const r of missing) points.push({ x: r, y: L(r), style: "ring", color: PALETTE[3], label: "?" });
    plot.set({ curves: [{ f: L, color: PALETTE[0] }, { f: R, color: PALETTE[3] }], fills: [], points });
    pbox.append(legend([{ label: "left side: " + parts[0].trim(), color: PALETTE[0] }, { label: "right side: " + parts[1].trim(), color: PALETTE[3] }]),
      h("div", { class: "muted small", text: "Solutions are where the two curves cross." }));
    const summary = ok ? "correct (" + truth.length + " solution(s))" : "wrong: works " + good.length + ", wrong " + bad.map((g) => g.raw).join(" ") + ", missing " + missing.length;
    return { ok, summary };
  }

  function scratchArea(spec) {
    const box = h("div", { class: "card scratch" });
    box.append(h("h3", { text: "🧮 Scratch graph" }), h("div", { class: "muted small", text: "Plot anything to explore. Separate several with ;  e.g.  sin(x); x^2 - 1" }));
    const input = h("input", { type: "text", placeholder: "sin(x); x^2 - 1", style: "width:100%;margin:8px 0;font-family:var(--mono)", autocapitalize: "none", spellcheck: "false", "aria-label": "Expressions to plot" });
    const msg = h("div", { class: "err small" });
    const pl = h("div");
    const legendBox = h("div");
    box.append(input, msg, pl, legendBox);
    const plot = new Plot(pl, { domain: spec.scratch_domain || [-6, 6], height: 260 });
    let tm = null;
    const upd = () => {
      const curves = [], items = [];
      msg.textContent = "";
      input.value.split(";").map((x) => x.trim()).filter(Boolean).forEach((e, i) => {
        try {
          const f = compileFn(e, "x", {}, { stripLhs: true });
          curves.push({ f, color: PALETTE[i % PALETTE.length] });
          items.push({ label: e, color: PALETTE[i % PALETTE.length] });
        } catch (err) { msg.textContent = e + ": " + err.message; }
      });
      plot.view = null;
      plot.set({ curves, fills: [], points: [] });
      legendBox.replaceChildren(legend(items));
    };
    input.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(upd, 300); });
    plot.set({ curves: [], fills: [], points: [] });
    return box;
  }

  // ---- file dispatch -------------------------------------------------------------
  const CODE_LANG = { py: "python", js: "javascript", ts: "typescript", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp", c: "c", java: "java", rs: "rust", go: "go", sh: "bash", rb: "ruby", cs: "csharp", css: "css", json: "json", yml: "yaml", yaml: "yaml", sql: "sql", tex: "latex", kt: "kotlin", swift: "swift", php: "php", lua: "lua", r: "r", m: "matlab", toml: "ini", ini: "ini", xml: "xml", svg: "xml" };
  const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const DOCS = /\.(docx?|odt|rtf|pptx?|odp|xlsx?|ods|epub)$/i;
  const BINARY = /\.(heic|heif|tiff?|zip|rar|7z|mp3|m4a|wav|ogg|mp4|mov|webm|exe|bin)$/i;
  function kindOf(path) {
    const p = path.toLowerCase();
    if (p.endsWith(".quiz.json")) return "quiz";
    if (p.endsWith(".flash.json") || p.endsWith(".flashcards.json")) return "flash";
    if (p.endsWith(".plot.json")) return "plot";
    if (p.endsWith(".lab.json")) return "lab";
    if (/\.(md|markdown)$/.test(p)) return "md";
    if (/\.html?$/.test(p)) return "html";
    if (IMAGE.test(p)) return "image";
    if (p.endsWith(".pdf")) return "pdf";
    if (DOCS.test(p)) return "doc";
    const ext = p.split(".").pop();
    if (BINARY.test(p)) return "binary";
    if (CODE_LANG[ext]) return "code";
    return "text";
  }
  LG.kindOf = kindOf;
  LG.ICON = { quiz: "❓", flash: "🃏", plot: "📈", lab: "🧪", md: "📝", html: "🧩", image: "🖼️", code: "💻", text: "📄", pdf: "📕", doc: "📘", binary: "📦" };
  LG.editable = (k) => !["image", "pdf", "doc", "binary"].includes(k);
  LG.isBinaryKind = (k) => ["image", "pdf", "doc", "binary"].includes(k);

  function humanSize(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n > 1e3 ? Math.round(n / 1e3) + " KB" : n + " B"; }
  LG.humanSize = humanSize;

  /** PDFs, Word/PowerPoint documents and other binary files: open/download,
   * an embedded viewer for PDFs, and the text the teacher reads. */
  function renderBinaryFile(path, kind, host) {
    const name = path.split("/").pop();
    const meta = h("span", { class: "muted small", text: "" });
    const card = h("div", { class: "file-card" },
      h("div", { class: "head" }, h("span", { class: "big-ico", text: LG.ICON[kind] || "📦" }),
        h("div", { class: "meta" }, h("b", { text: name }), meta),
        h("a", { class: "btn small", href: fileUrl(path), target: "_blank", rel: "noopener", text: kind === "pdf" ? "Open" : "Download" }),
        h("button", { class: "btn small primary", onclick: () => LG.ctx.send && LG.ctx.send("Please look at " + path + " and help me with it.", null, [path]) }, "Ask teacher about it")));
    host.append(h("div", { class: "doc" }, card));
    if (kind === "pdf") card.append(h("iframe", { class: "pdf-frame", src: fileUrl(path), title: name }));
    if (kind === "binary") { meta.textContent = "The teacher can't open this kind of file."; return; }
    const wrap = h("details", { class: "extract-wrap", open: kind === "doc" ? "" : null }, h("summary", { text: "Text the teacher reads from it" }));
    const pre = h("pre", { class: "extract", text: "Loading…" });
    wrap.append(pre);
    card.append(wrap);
    if (kind === "pdf") wrap.lastChild.before(h("p", { class: "muted small", text: "The teacher also sees the pages themselves, so pictures and scans work too." }));
    fetch("api/extract?path=" + encodeURIComponent(path), { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
      meta.textContent = d.size != null ? humanSize(d.size) : "";
      pre.textContent = d.text || (kind === "pdf" ? "(No text inside: probably a scan. The teacher still sees the pages.)" : "(No readable text found.)");
    }).catch(() => { pre.textContent = "(Could not read it.)"; });
  }

  /** Render a file. Returns {full: true} when the host should drop padding. */
  function renderFile(path, text, host) {
    const kind = kindOf(path);
    const base = dirOf(path);
    if (kind === "html") {
      const fr = h("iframe", { class: "html-frame", sandbox: "allow-scripts", title: path, referrerpolicy: "no-referrer" });
      fr.srcdoc = text;
      host.append(fr);
      return { full: true };
    }
    if (kind === "image") {
      host.append(h("div", { class: "doc" }, h("img", { class: "img-view", src: fileUrl(path), alt: path.split("/").pop() })));
      return {};
    }
    if (kind === "pdf" || kind === "doc" || kind === "binary") { renderBinaryFile(path, kind, host); return {}; }
    const doc = h("div", { class: "doc" });
    host.append(doc);
    if (kind === "md") { renderMarkdown(text, doc, { base }); return {}; }
    if (kind === "code" || kind === "text") {
      const ext = path.toLowerCase().split(".").pop();
      const code = h("code", { class: CODE_LANG[ext] ? "language-" + CODE_LANG[ext] : "nohighlight", text });
      const pre = h("pre", {}, code);
      doc.classList.add("md");
      doc.append(pre);
      if (CODE_LANG[ext] && window.hljs) { try { hljs.highlightElement(code); } catch (e) { /* plain */ } }
      return {};
    }
    let spec;
    try { spec = JSON.parse(text); } catch (e) {
      doc.append(problem("This file is not valid JSON (" + e.message + "). Ask your teacher to fix it.", text));
      return {};
    }
    try {
      if (kind === "quiz") renderQuizFile(spec, doc);
      else if (kind === "flash") renderFlash(spec, doc);
      else if (kind === "plot") renderPlotSpec(spec, doc);
      else if (kind === "lab") renderLab(spec, doc, { base });
    } catch (e) {
      doc.append(problem(e.message, text));
    }
    return {};
  }
  LG.renderFile = renderFile;
})();
