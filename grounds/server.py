#!/usr/bin/env python3
"""Learning Grounds: a web workspace where an AI teacher builds study material.

One process, standard library HTTP plus the official Anthropic SDK. Each learner
has a login and a folder (their workspace). The teacher model works inside that
folder only, through a handful of file tools, and the browser renders what it
writes: Markdown with math, quizzes, a math lab, plots and sandboxed mini apps.

Served behind Tailscale Funnel at /learn, so every URL the frontend uses is
relative. The admin API (accounts, keys, models) needs the token in
DATA/admin.token and is meant for the devbox panel only.

Run:  venv/bin/python server.py   (PORT and LG_DATA from the environment)
Deps: venv/bin/pip install -r requirements.txt   (pypdf is optional: without it
      PDF text comes from pdftotext, and Claude still reads PDFs directly)
"""

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

HERE = Path(__file__).resolve().parent
REPO = HERE.parent                                   # the learn repo (.pi dir)
STATIC = HERE / "static"
BLOCKS = HERE / "blocks"                             # shipped building blocks
PORT = int(os.environ.get("PORT", "8796"))
DATA = Path(os.environ.get("LG_DATA", str(Path.home() / "learning-grounds" / "data")))
WS_ROOT = DATA / "ws"
CONTRIB = DATA / "blocks-contrib"                    # blocks the teacher saved
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

MAX_ROUNDS = 30              # model calls per learner message
MAX_FILE = 400_000           # bytes the teacher may write or read in one go
SESSION_DAYS = 30

# Prices per million tokens, from the Claude API model table (cached 2026-10).
# cache_w is the 5-minute cache write rate (1.25x input).
MODELS = {
    "claude-opus-5-5":   {"label": "Claude Opus 5.5 (best)", "provider": "anthropic",
                          "in": 4.0, "out": 20.0, "cache_r": 0.20, "cache_w": 5.0},
    "claude-sonnet-5-5": {"label": "Claude Sonnet 5.5", "provider": "anthropic",
                          "in": 2.0, "out": 10.0, "cache_r": 0.20, "cache_w": 2.5},
    "claude-haiku-5-5":  {"label": "Claude Haiku 5.5 (cheapest)", "provider": "anthropic",
                          "in": 0.10, "out": 0.50, "cache_r": 0.01, "cache_w": 0.125},
    "ollama:qwen3:8b":         {"label": "Qwen3 8B (local, free)", "provider": "ollama"},
    "ollama:qwen2.5-coder:7b": {"label": "Qwen2.5 Coder 7B (local, free)", "provider": "ollama"},
    "ollama:qwen3-coder:30b":  {"label": "Qwen3 Coder 30B (local, free, slow)", "provider": "ollama"},
}
WEB_SEARCH_USD = 0.01        # per search request
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")

TOUR_LOGINS = 5              # show the Walkthrough button on this many first logins
_lock = threading.RLock()    # guards the JSON stores below
_busy = {}                   # user -> threading.Event (cancel flag) while generating


# ---- small JSON stores ---------------------------------------------------

def _load(name, default):
    p = DATA / name
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def _save(name, obj, private=False):
    p = DATA / name
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False))
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def config():
    c = _load("config.json", {})
    c.setdefault("default_model", "claude-opus-5-5")
    c.setdefault("default_cap_usd", 5.0)
    c.setdefault("web_search", True)
    return c


def secret(key):
    return _load("secrets.json", {}).get(key) or os.environ.get(key.upper(), "")


def users():
    return _load("users.json", {})


def save_users(u):
    _save("users.json", u, private=True)


def month():
    return time.strftime("%Y-%m")


def spent(u):
    """This month's spend for a user record, in USD."""
    s = u.get("spend", {})
    return float(s.get(month(), 0.0))


def add_spend(name, usd, model, tokens):
    if usd <= 0 and not tokens:
        return
    with _lock:
        us = users()
        u = us.get(name)
        if not u:
            return
        s = u.setdefault("spend", {})
        s[month()] = round(float(s.get(month(), 0.0)) + usd, 6)
        save_users(us)
        with open(DATA / "usage.jsonl", "a") as fh:
            fh.write(json.dumps({"t": int(time.time()), "user": name, "model": model,
                                 "usd": round(usd, 6), **tokens}) + "\n")


# ---- passwords and sessions ----------------------------------------------

def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 240_000).hex()
    return salt, h


def check_pw(u, pw):
    if not u or "pw" not in u:
        return False
    _, h = hash_pw(pw, u["salt"])
    return hmac.compare_digest(h, u["pw"])


_sessions = None


def sessions():
    global _sessions
    if _sessions is None:
        _sessions = _load("sessions.json", {})
    return _sessions


def new_session(name):
    tok = secrets.token_urlsafe(32)
    with _lock:
        s = sessions()
        now = time.time()
        for k in [k for k, v in s.items() if v["exp"] < now]:
            del s[k]
        s[tok] = {"user": name, "exp": now + SESSION_DAYS * 86400}
        _save("sessions.json", s, private=True)
    return tok


def drop_sessions(name=None, tok=None):
    with _lock:
        s = sessions()
        for k in [k for k, v in s.items() if k == tok or (name and v["user"] == name)]:
            del s[k]
        _save("sessions.json", s, private=True)


# ---- workspace paths -----------------------------------------------------

class PathError(Exception):
    pass


def ws_dir(name):
    d = WS_ROOT / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_path(name, rel, must_exist=False):
    """A path inside the user's workspace, or PathError. The teacher's and the
    browser's paths are both untrusted: no absolute paths, no '..', no symlink
    escapes, and the hidden .chats/.teacher folders stay off limits to writes
    from outside the server."""
    root = ws_dir(name).resolve()
    rel = str(rel or "").strip().lstrip("/").replace("\\", "/")
    if "\x00" in rel:
        raise PathError("bad path")
    p = (root / rel).resolve()
    if p != root and not p.is_relative_to(root):
        raise PathError("path escapes the workspace")
    if must_exist and not p.exists():
        raise PathError("no such file: " + rel)
    return p


def rel_of(name, p):
    return str(p.relative_to(ws_dir(name).resolve())).replace("\\", "/")


def hidden(rel):
    return any(part.startswith(".") for part in rel.split("/"))


# ---- uploads: school documents, photos, worksheets ---------------------------
#
# Uploaded files live in the workspace like everything else. The chat history
# never stores their bytes: a message or tool result holds a small
# {"type": "lg_file", "path": ...} marker and expand_files() turns it into an
# image / PDF document / text block each time the history goes to the model.
# The expansion is a pure function of the file, so the cached prompt prefix
# stays byte-identical between turns.

VISION_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp"}
DOC_EXT = {".pdf", ".docx", ".odt", ".pptx", ".odp", ".xlsx", ".ods", ".rtf", ".epub"}
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".tex", ".html", ".htm",
            ".py", ".js", ".ts", ".cpp", ".c", ".h", ".hpp", ".java", ".cs", ".go", ".rs", ".sh"}
MAX_UPLOAD = 40_000_000      # bytes per uploaded file
MAX_IMAGE_API = 5_000_000    # the API's per-image limit
MAX_PDF_API = 25_000_000     # stay well inside the 32 MB request limit
MAX_EXTRACT = 120_000        # characters of extracted text handed to a model
MAX_ATTACH = 10              # files per chat message


def _xml_text(xml, para_tags, text_tags, tab_tags=(), br_tags=(), tails=False, space_tags=()):
    """Plain text from an office XML part: one line per paragraph."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return ""
    local = lambda t: t.rsplit("}", 1)[-1] if isinstance(t, str) else ""
    lines, buf = [], []

    def flush():
        line = "".join(buf).strip()
        if line:
            lines.append(line)
        buf.clear()

    def walk(el):
        tag = local(el.tag)
        if tag in para_tags:
            flush()
        if tag in text_tags and el.text:
            buf.append(el.text)
        elif tag in tab_tags:
            buf.append("\t")
        elif tag in br_tags:
            buf.append("\n")
        elif tag in space_tags:
            buf.append(" ")
        for ch in el:
            walk(ch)
            if tails and ch.tail:
                buf.append(ch.tail)
        if tag in para_tags:
            flush()
    walk(root)
    flush()
    return "\n".join(lines)


def _office_text(p):
    import zipfile
    ext = p.suffix.lower()
    with zipfile.ZipFile(p) as z:
        names = z.namelist()
        if ext == ".docx":
            parts = ["word/document.xml"] + sorted(n for n in names if re.match(r"word/(footnotes|endnotes)\.xml$", n))
            return "\n\n".join(_xml_text(z.read(n), {"p"}, {"t"}, {"tab"}, {"br", "cr"})
                               for n in parts if n in names)
        if ext == ".pptx":
            slides = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                            key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
            return "\n\n".join("--- slide %d ---\n%s" % (i + 1, _xml_text(z.read(n), {"p"}, {"t"}))
                               for i, n in enumerate(slides))
        if ext == ".xlsx":
            if "xl/sharedStrings.xml" not in names:
                return ""
            return _xml_text(z.read("xl/sharedStrings.xml"), {"si"}, {"t"})
        if ext in (".odt", ".odp", ".ods"):
            return _xml_text(z.read("content.xml"), {"p", "h"}, {"p", "h", "span", "a"}, {"tab"},
                             {"line-break"}, tails=True, space_tags={"s"})
        if ext == ".epub":
            parts = sorted(n for n in names if re.search(r"\.x?html?$", n))
            return "\n\n".join(re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8", "replace")) for n in parts)
    return ""


def _pdf_text(p):
    try:
        import pypdf                       # optional, in the venv
        r = pypdf.PdfReader(str(p))
        return "\n\n".join("--- page %d ---\n%s" % (i + 1, (pg.extract_text() or "").strip())
                           for i, pg in enumerate(r.pages))
    except ImportError:
        pass
    except Exception:
        return ""
    import subprocess
    try:
        r = subprocess.run(["pdftotext", "-layout", "-q", str(p), "-"], capture_output=True, timeout=60)
        return r.stdout.decode("utf-8", "replace").replace("\f", "\n\n")
    except (OSError, subprocess.SubprocessError):
        return ""


def _rtf_text(raw):
    t = raw.decode("latin-1", "replace")
    t = re.sub(r"\\par[d]?\b", "\n", t)
    t = re.sub(r"\\'([0-9a-f]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1250", "replace"), t)
    t = re.sub(r"\\[a-z]+-?\d* ?|[{}]", "", t)
    return t


def extract_text(name, p):
    """Readable text of a document in the workspace ('' when there is none).
    Cached next to the workspace in .cache/, keyed by size and mtime."""
    ext = p.suffix.lower()
    st = p.stat()
    cache = ws_dir(name) / ".cache" / "text" / (hashlib.sha1(rel_of(name, p).encode()).hexdigest() + ".json")
    try:
        c = json.loads(cache.read_text())
        if c.get("size") == st.st_size and c.get("mtime") == st.st_mtime:
            return c["text"]
    except (OSError, ValueError, KeyError):
        pass
    text = ""
    try:
        if ext == ".pdf":
            text = _pdf_text(p)
        elif ext == ".rtf":
            text = _rtf_text(p.read_bytes()[:MAX_UPLOAD])
        elif ext in DOC_EXT:
            text = _office_text(p)
        else:
            text = p.read_bytes()[:MAX_FILE * 2].decode("utf-8", "replace")
    except Exception:
        text = ""
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"size": st.st_size, "mtime": st.st_mtime, "text": text}))
    except OSError:
        pass
    return text


def file_kind(p):
    ext = p.suffix.lower()
    if ext in VISION_TYPES:
        return "image"
    if ext in (".heic", ".heif", ".bmp", ".tif", ".tiff", ".avif", ".svg"):
        return "other-image"
    if ext == ".pdf":
        return "pdf"
    if ext in DOC_EXT:
        return "doc"
    if ext in TEXT_EXT:
        return "text"
    return "binary"


def file_blocks(name, rel, vision=True):
    """API content blocks for one workspace file (an attachment or read_file)."""
    try:
        p = safe_path(name, rel, must_exist=True)
    except PathError:
        return [{"type": "text", "text": "[%s: this file was moved or deleted since]" % rel}]
    if p.is_dir():
        return [{"type": "text", "text": "[%s is a folder]" % rel}]
    kind, size = file_kind(p), p.stat().st_size
    label = "[File: %s]" % rel
    if kind == "image":
        if vision and size <= MAX_IMAGE_API:
            return [{"type": "text", "text": label},
                    {"type": "image", "source": {"type": "base64", "media_type": VISION_TYPES[p.suffix.lower()],
                                                 "data": base64.b64encode(p.read_bytes()).decode()}}]
        why = "this teacher model cannot see pictures" if not vision else "the picture is too large to view"
        return [{"type": "text", "text": label + " (a photo or picture; %s)" % why}]
    if kind == "other-image":
        return [{"type": "text", "text": label + " (a picture in a format the teacher cannot open; ask the "
                                                 "learner to send it as JPEG or PNG)"}]
    if kind == "pdf" and vision and size <= MAX_PDF_API:
        return [{"type": "text", "text": label},
                {"type": "document", "title": rel[-200:],
                 "source": {"type": "base64", "media_type": "application/pdf",
                            "data": base64.b64encode(p.read_bytes()).decode()}}]
    if kind in ("pdf", "doc", "text"):
        text = extract_text(name, p)
        if not text:
            hint = " It may be a scan: ask the learner for photos of the pages." if kind == "pdf" else ""
            return [{"type": "text", "text": label + " (no readable text found.%s)" % hint}]
        cut = ""
        if len(text) > MAX_EXTRACT:
            text, cut = text[:MAX_EXTRACT], "\n[... cut: the document is longer than %d characters]" % MAX_EXTRACT
        return [{"type": "text", "text": "%s\n<document path=\"%s\">\n%s%s\n</document>" % (label, rel, text, cut)}]
    return [{"type": "text", "text": label + " (binary file, %d bytes; cannot be read)" % size}]


def expand_files(name, content, vision=True):
    """Replace lg_file markers (also inside tool results) with real blocks."""
    if not isinstance(content, list):
        return content
    out = []
    for b in content:
        if not isinstance(b, dict):
            out.append(b)
        elif b.get("type") == "lg_file":
            out.extend(file_blocks(name, b.get("path", ""), vision))
        elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
            out.append({**b, "content": expand_files(name, b["content"], vision)})
        else:
            out.append(b)
    return out


def upload_name(name, folder, filename):
    """A free, clean path for an uploaded file inside folder."""
    fn = (filename or "").replace("\\", "/").split("/")[-1]
    fn = re.sub(r"[\x00-\x1f<>:\"|?*]+", "", fn).strip().lstrip(".") or "file"
    stem, dot, ext = fn.rpartition(".")
    if not dot:
        stem, ext = fn, ""
    stem, ext = stem[:80].strip() or "file", ext[:10].lower()
    d = safe_path(name, folder)
    if d != ws_dir(name).resolve() and hidden(rel_of(name, d)):
        raise PathError("hidden folders are reserved")
    if d.exists() and not d.is_dir():
        raise PathError("not a folder")
    for i in range(1, 1000):
        cand = d / ((stem if i == 1 else "%s (%d)" % (stem, i)) + ("." + ext if ext else ""))
        if not cand.exists():
            return cand
    raise PathError("too many files with that name")


def tree(name, limit=2000):
    root = ws_dir(name).resolve()
    out = []

    def walk(d, depth):
        items = []
        try:
            entries = sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except OSError:
            return items
        for e in entries:
            if e.name.startswith(".") or len(out) > limit:
                continue
            out.append(1)
            node = {"name": e.name, "path": rel_of(name, e)}
            if e.is_dir():
                node["dir"] = True
                node["children"] = walk(e, depth + 1) if depth < 8 else []
            else:
                try:
                    st = e.stat()
                    node["size"], node["mtime"] = st.st_size, int(st.st_mtime)
                except OSError:
                    pass
            items.append(node)
        return items

    return walk(root, 0)


def tree_text(name, max_lines=200):
    lines = []

    def walk(nodes, ind):
        for n in nodes:
            if len(lines) >= max_lines:
                return
            lines.append("  " * ind + n["name"] + ("/" if n.get("dir") else ""))
            if n.get("dir"):
                walk(n.get("children", []), ind + 1)

    walk(tree(name), 0)
    return "\n".join(lines) if lines else "(empty: nothing created yet)"


# ---- building blocks -----------------------------------------------------

def block_files():
    files = {}
    for d in (BLOCKS, CONTRIB):
        if d.is_dir():
            for f in sorted(d.glob("*.json")):
                files[f.stem] = f
    return files


def block_list():
    out = []
    for name, f in block_files().items():
        try:
            b = json.loads(f.read_text())
        except ValueError:
            continue
        out.append({"name": name, "summary": b.get("summary", ""),
                    "file": b.get("file", ""), "contributed": f.parent == CONTRIB})
    return out


def block_get(name):
    f = block_files().get(name)
    if not f:
        return None
    return json.loads(f.read_text())


# ---- the teacher's tools ---------------------------------------------------

def _tool(name, desc, props, required):
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": required}}


S = {"type": "string"}
TOOLS = [
    _tool("list_files", "List the learner's workspace as an indented tree (folders end in /).",
          {"path": {**S, "description": "Folder to list; empty for the whole workspace."}}, []),
    _tool("read_file", "Read a file from the workspace. Text files come back as text. Photos and "
          "pictures (.jpg .png .webp .gif) and PDFs come back so you can see them, pages and all. "
          "Word, PowerPoint, OpenDocument and other documents come back as their extracted text. "
          "Use it to look at school material the learner uploaded.", {"path": S}, ["path"]),
    _tool("write_file", "Create or overwrite a file. Missing folders are created. Use the block "
          "formats (see list_blocks) so the site renders it: .md notes, .quiz.json, .lab.json, "
          ".plot.json, .html mini apps.",
          {"path": S, "content": S}, ["path", "content"]),
    _tool("edit_file", "Replace one exact, unique occurrence of old_text with new_text in a file.",
          {"path": S, "old_text": S, "new_text": S}, ["path", "old_text", "new_text"]),
    _tool("delete_path", "Delete a file or a whole folder. Only when the learner wants it gone "
          "or you are tidying up something you made.", {"path": S}, ["path"]),
    _tool("move_path", "Move or rename a file or folder.", {"src": S, "dst": S}, ["src", "dst"]),
    _tool("show_file", "Open a file in the learner's reader pane, next to the chat. Do this after "
          "you create the material you want them to read or use now.", {"path": S}, ["path"]),
    _tool("quiz", "Ask graded multiple-choice questions in the chat. The learner answers in the "
          "UI and their answers come back as their next message, so end your turn right after "
          "calling this. Options are bare claims; put all reasoning in explanation.",
          {"questions": {"type": "array", "items": {
              "type": "object",
              "properties": {"question": S,
                             "options": {"type": "array", "items": S},
                             "answer": {"type": "integer", "description": "0-based index of the correct option"},
                             "explanation": S},
              "required": ["question", "options", "answer", "explanation"]}}},
          ["questions"]),
    _tool("ask_user_question", "Ask a question with no right answer (goals, preferences, what "
          "next) as buttons. The pick comes back as their next message; end your turn after this.",
          {"question": S, "options": {"type": "array", "items": S},
           "allow_other": {"type": "boolean", "description": "Let them type their own answer too."}},
          ["question", "options"]),
    _tool("list_blocks", "List the building-block library: ready formats and templates the site "
          "renders. Cheaper and more reliable than inventing a page from scratch.", {}, []),
    _tool("get_block", "Get one building block's full spec and example, to fill it in.",
          {"name": S}, ["name"]),
    _tool("save_block", "Add a reusable building block to the shared library (for a template you "
          "made that other lessons could reuse). Keep it general, not learner specific.",
          {"name": {**S, "description": "kebab-case"}, "summary": S,
           "file": {**S, "description": "file name pattern it produces, e.g. *.html"},
           "how_to_use": S, "example": S},
          ["name", "summary", "file", "how_to_use", "example"]),
]
for _t in TOOLS:
    _t["eager_input_streaming"] = True


def summarize_input(name, inp):
    if not isinstance(inp, dict):
        return ""
    if "path" in inp:
        return str(inp["path"])[:200]
    if name == "move_path":
        return "%s -> %s" % (inp.get("src"), inp.get("dst"))
    if name == "get_block":
        return str(inp.get("name"))
    return ""


def run_tool(user, name, inp, emit):
    """Run one tool call. Returns (text result, is_error)."""
    if not isinstance(inp, dict):
        return "INVALID_JSON: tool input was not an object; send it again.", True
    try:
        if name == "list_files":
            p = safe_path(user, inp.get("path", ""), must_exist=True)
            if p == ws_dir(user).resolve():
                return tree_text(user, 400), False
            sub = [n for n in tree(user)]
            rel = rel_of(user, p)
            for part in rel.split("/"):
                sub = next((n.get("children", []) for n in sub if n["name"] == part), [])
            lines = []

            def walk(nodes, ind):
                for n in nodes:
                    lines.append("  " * ind + n["name"] + ("/" if n.get("dir") else ""))
                    if n.get("dir"):
                        walk(n.get("children", []), ind + 1)
            walk(sub, 0)
            return "\n".join(lines) or "(empty folder)", False

        if name == "read_file":
            p = safe_path(user, inp.get("path"), must_exist=True)
            if p.is_dir():
                return "that is a folder; use list_files", True
            kind = file_kind(p)
            if kind in ("image", "pdf"):
                # the picture / PDF itself; expanded when the history is sent
                return [{"type": "text", "text": "Here is %s:" % rel_of(user, p)},
                        {"type": "lg_file", "path": rel_of(user, p)}], False
            if kind in ("doc", "other-image"):
                return [{"type": "lg_file", "path": rel_of(user, p)}], False
            data = p.read_bytes()[:MAX_FILE]
            try:
                return data.decode("utf-8"), False
            except UnicodeDecodeError:
                return "(binary file, %d bytes)" % p.stat().st_size, False

        if name == "write_file":
            content = inp.get("content")
            if not isinstance(content, str) or not isinstance(inp.get("path"), str):
                return "INVALID_JSON: need string path and content", True
            if len(content.encode()) > MAX_FILE:
                return "file too large (limit %d bytes); split it" % MAX_FILE, True
            p = safe_path(user, inp["path"])
            if hidden(rel_of(user, p)) and not rel_of(user, p).startswith(".teacher/"):
                return "hidden paths are reserved", True
            if p.is_dir():
                return "a folder already has that name", True
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            emit({"t": "tree", "changed": rel_of(user, p)})
            return "wrote %s (%d chars)" % (rel_of(user, p), len(content)), False

        if name == "edit_file":
            p = safe_path(user, inp.get("path"), must_exist=True)
            old, new = inp.get("old_text"), inp.get("new_text")
            if not isinstance(old, str) or not isinstance(new, str) or not old:
                return "INVALID_JSON: need old_text and new_text", True
            text = p.read_text()
            n = text.count(old)
            if n != 1:
                return "old_text found %d times; it must match exactly once" % n, True
            p.write_text(text.replace(old, new, 1))
            emit({"t": "tree", "changed": rel_of(user, p)})
            return "edited " + rel_of(user, p), False

        if name == "delete_path":
            p = safe_path(user, inp.get("path"), must_exist=True)
            if p == ws_dir(user).resolve():
                return "refusing to delete the whole workspace", True
            trash = DATA / "trash" / user / time.strftime("%Y%m%d-%H%M%S")
            trash.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(trash / p.name))     # recoverable by the admin
            emit({"t": "tree"})
            return "deleted " + inp.get("path"), False

        if name == "move_path":
            a = safe_path(user, inp.get("src"), must_exist=True)
            b = safe_path(user, inp.get("dst"))
            if b.exists():
                return "destination exists", True
            b.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(a), str(b))
            emit({"t": "tree"})
            return "moved to " + rel_of(user, b), False

        if name == "show_file":
            p = safe_path(user, inp.get("path"), must_exist=True)
            emit({"t": "show", "path": rel_of(user, p)})
            return "shown to the learner", False

        if name == "quiz":
            qs = inp.get("questions")
            ok = isinstance(qs, list) and qs and all(
                isinstance(q, dict) and isinstance(q.get("options"), list) and len(q["options"]) >= 2
                and isinstance(q.get("answer"), int) and 0 <= q["answer"] < len(q["options"])
                for q in qs)
            if not ok:
                return "INVALID_JSON: each question needs options (2+) and a valid answer index", True
            emit({"t": "quiz", "questions": qs})
            return ("Quiz shown. End your turn now; the learner's answers arrive as their next "
                    "message."), False

        if name == "ask_user_question":
            if not isinstance(inp.get("options"), list):
                return "INVALID_JSON: options must be a list", True
            emit({"t": "choice", "question": inp.get("question", ""), "options": inp["options"],
                  "allow_other": bool(inp.get("allow_other", True))})
            return "Question shown. End your turn now; the pick arrives as their next message.", False

        if name == "list_blocks":
            return "\n".join("- %s (%s): %s" % (b["name"], b["file"], b["summary"])
                             for b in block_list()) or "(no blocks yet)", False

        if name == "get_block":
            b = block_get(str(inp.get("name", "")))
            if not b:
                return "no such block; call list_blocks", True
            return json.dumps(b, indent=1, ensure_ascii=False), False

        if name == "save_block":
            bn = str(inp.get("name", "")).strip().lower()
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,48}", bn):
                return "name must be kebab-case", True
            if (BLOCKS / (bn + ".json")).exists():
                return "a shipped block has that name; pick another", True
            CONTRIB.mkdir(parents=True, exist_ok=True)
            rec = {k: str(inp.get(k, "")) for k in ("summary", "file", "how_to_use", "example")}
            rec["by"] = user
            rec["saved"] = time.strftime("%Y-%m-%d %H:%M")
            (CONTRIB / (bn + ".json")).write_text(json.dumps(rec, indent=1, ensure_ascii=False))
            return "saved block " + bn, False

        return "unknown tool " + name, True
    except PathError as e:
        return str(e), True
    except OSError as e:
        return "file error: %s" % e, True


# ---- the system prompt -----------------------------------------------------

def teacher_prompt():
    """Stable across a user's turns so the prompt cache keeps hitting."""
    base = (HERE / "teacher.md").read_text()
    teach = ""
    f = REPO / "skills" / "teach" / "SKILL.md"
    if f.exists():
        teach = re.sub(r"^---.*?---\s*", "", f.read_text(), flags=re.S)
    return base + "\n\n# Teaching method (the learn repo's teach skill)\n\n" + teach


def learner_context(name, u):
    about = u.get("about", "").strip()
    notes = ""
    f = ws_dir(name) / ".teacher" / "learner.md"
    if f.exists():
        notes = f.read_text()[:6000]
    return ("# This learner\n\nName: %s\nAbout them (written by the learner or the admin): %s\n\n"
            "Your own notes about them (.teacher/learner.md):\n%s\n"
            % (u.get("display") or name, about or "(nothing yet)", notes or "(none yet: start them)"))


# ---- chats -----------------------------------------------------------------

def chats_dir(name):
    d = ws_dir(name) / ".chats"
    d.mkdir(exist_ok=True)
    return d


def chat_load(name, cid):
    if not re.fullmatch(r"[a-f0-9]{32}", cid or ""):
        return None
    f = chats_dir(name) / (cid + ".json")
    try:
        return json.loads(f.read_text())
    except (OSError, ValueError):
        return None


def chat_save(name, chat):
    f = chats_dir(name) / (chat["id"] + ".json")
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(chat, ensure_ascii=False))
    os.replace(tmp, f)


def chat_list(name):
    out = []
    for f in chats_dir(name).glob("*.json"):
        try:
            c = json.loads(f.read_text())
        except ValueError:
            continue
        out.append({"id": c["id"], "title": c.get("title", "Chat"), "updated": c.get("updated", 0)})
    return sorted(out, key=lambda c: -c["updated"])


def chat_for_ui(chat):
    """The stored API history, flattened to what the browser draws."""
    out = []
    for m in chat.get("messages", []):
        content = m["content"]
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for b in content:
            t = b.get("type")
            if m["role"] == "user" and t == "text":
                if b.get("ui_hidden"):
                    continue
                out.append({"role": "user", "text": b.get("display", b["text"]),
                            **({"attachments": b["attachments"]} if b.get("attachments") else {})})
            elif m["role"] == "assistant" and t == "text" and b.get("text", "").strip():
                out.append({"role": "assistant", "text": b["text"]})
            elif m["role"] == "assistant" and t == "tool_use":
                inp = b.get("input") or {}
                if b["name"] == "quiz":
                    out.append({"role": "quiz", "questions": inp.get("questions", []),
                                "id": b.get("id")})
                elif b["name"] == "ask_user_question":
                    out.append({"role": "choice", "question": inp.get("question", ""),
                                "options": inp.get("options", []), "id": b.get("id")})
                else:
                    out.append({"role": "tool", "name": b["name"],
                                "detail": summarize_input(b["name"], inp)})
            elif t == "server_tool_use":
                out.append({"role": "tool", "name": "web_search",
                            "detail": str((b.get("input") or {}).get("query", ""))})
    return out


def scrub_for_api(name, messages, vision=True):
    """Drop UI-only keys and turn file markers into real blocks before sending
    history back to the model."""
    out = []
    for m in messages:
        c = m["content"]
        if isinstance(c, list):
            c = [{k: v for k, v in b.items() if k not in ("ui_hidden", "display", "attachments")} for b in c]
            c = expand_files(name, c, vision)
        out.append({"role": m["role"], "content": c})
    return out


# ---- model loops -------------------------------------------------------------

class Stop(Exception):
    pass


def cost_of(model, usage):
    p = MODELS.get(model, {})
    if p.get("provider") != "anthropic" or usage is None:
        return 0.0, {}
    g = lambda k: int(getattr(usage, k, 0) or 0)
    tok = {"in": g("input_tokens"), "out": g("output_tokens"),
           "cache_w": g("cache_creation_input_tokens"), "cache_r": g("cache_read_input_tokens")}
    searches = 0
    stu = getattr(usage, "server_tool_use", None)
    if stu is not None:
        searches = int(getattr(stu, "web_search_requests", 0) or 0)
    tok["searches"] = searches
    usd = (tok["in"] * p["in"] + tok["out"] * p["out"] + tok["cache_w"] * p["cache_w"]
           + tok["cache_r"] * p["cache_r"]) / 1e6 + searches * WEB_SEARCH_USD
    return usd, tok


def check_budget(name):
    u = users().get(name) or {}
    cap = float(u.get("cap_usd", config()["default_cap_usd"]))
    if spent(u) >= cap:
        raise Stop("This month's spending limit ($%.2f) is used up. Ask the admin to raise it "
                   "in the devbox panel, or switch to a free local model." % cap)


def anthropic_turn(name, chat, model, emit, cancel):
    key = secret("anthropic_api_key")
    if not key:
        raise Stop("No Anthropic API key yet. The admin pastes it in the devbox panel's "
                   "Learning tab. Or switch to a local model.")
    client = anthropic.Anthropic(api_key=key, max_retries=2)
    u = users().get(name, {})
    system = [{"type": "text", "text": teacher_prompt(), "cache_control": {"type": "ephemeral"}},
              {"type": "text", "text": learner_context(name, u)}]
    tools = list(TOOLS)
    if config().get("web_search", True):
        tools.append({"type": "web_search_20260209", "name": "web_search", "max_uses": 4})
    extra = {}
    betas = []
    if model in FALLBACK_MODELS:
        betas.append("server-side-fallback-2026-07-01")
        extra["fallbacks"] = "default"

    for _ in range(MAX_ROUNDS):
        if cancel.is_set():
            return
        check_budget(name)
        msgs = scrub_for_api(name, chat["messages"])
        json_retries = 0
        while True:
            try:
                kw = dict(model=model, max_tokens=32000, system=system, tools=tools,
                          messages=msgs, cache_control={"type": "ephemeral"},
                          output_config={"effort": "medium"})
                if betas:
                    stream_ctx = client.beta.messages.stream(betas=betas, extra_body=extra, **kw)
                else:
                    stream_ctx = client.messages.stream(**kw)
                with stream_ctx as stream:
                    for ev in stream:
                        if cancel.is_set():
                            break
                        et = getattr(ev, "type", "")
                        if et == "text":
                            emit({"t": "text", "d": ev.text})
                        elif et == "content_block_start":
                            cb = ev.content_block
                            if cb.type == "tool_use":
                                emit({"t": "tool_start", "name": cb.name})
                            elif cb.type == "server_tool_use":
                                emit({"t": "tool_start", "name": "web_search"})
                            elif cb.type == "thinking":
                                emit({"t": "thinking"})
                    if cancel.is_set():
                        return
                    resp = stream.get_final_message()
                break
            except ValueError:
                json_retries += 1          # tool JSON the SDK could not parse at all
                if json_retries > 2:
                    raise Stop("The model sent broken tool input three times; try again.")

        usd, tok = cost_of(model, resp.usage)
        add_spend(name, usd, model, tok)
        emit({"t": "usage", "usd": round(usd, 4)})

        blocks = [b.model_dump(exclude_none=True) for b in resp.content]
        chat["messages"].append({"role": "assistant", "content": blocks})
        chat_save(name, chat)

        if resp.stop_reason == "pause_turn":
            continue
        if resp.stop_reason == "refusal":
            emit({"t": "error", "msg": "The model declined this one. Try rephrasing."})
            return
        uses = [b for b in resp.content if b.type == "tool_use"]
        if not uses:
            return
        if resp.stop_reason == "max_tokens":
            results = [{"type": "tool_result", "tool_use_id": b.id, "is_error": True,
                        "content": "output was cut off at max_tokens; write smaller pieces"}
                       for b in uses]
        else:
            results = []
            for b in uses:
                emit({"t": "tool", "name": b.name, "detail": summarize_input(b.name, b.input)})
                text, err = run_tool(name, b.name, b.input, emit)
                results.append({"type": "tool_result", "tool_use_id": b.id,
                                "content": text, **({"is_error": True} if err else {})})
        chat["messages"].append({"role": "user", "content": results})
        chat_save(name, chat)
        if any(b.name in ("quiz", "ask_user_question") for b in uses):
            return                       # wait for the learner
    emit({"t": "error", "msg": "Stopped after %d steps. Say 'continue' to go on." % MAX_ROUNDS})


def to_openai(system, messages):
    """Anthropic-shaped history -> OpenAI chat messages, for Ollama."""
    out = [{"role": "system", "content": system}]
    for m in messages:
        c = m["content"]
        if isinstance(c, str):
            out.append({"role": m["role"], "content": c})
            continue
        if m["role"] == "assistant":
            text = "".join(b.get("text", "") for b in c if b.get("type") == "text")
            calls = [{"id": b["id"], "type": "function",
                      "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})}}
                     for b in c if b.get("type") == "tool_use"]
            msg = {"role": "assistant", "content": text}
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
        else:
            for b in c:
                if b.get("type") == "tool_result":
                    tc = b.get("content")
                    if isinstance(tc, list):
                        tc = "\n".join(x.get("text", "") for x in tc if isinstance(x, dict))
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"],
                                "content": tc if isinstance(tc, str) else json.dumps(tc)})
            texts = [b["text"] for b in c if b.get("type") == "text"]
            if texts:
                out.append({"role": "user", "content": "\n\n".join(texts)})
    return out


def trim_for_local(messages, budget_chars=60_000):
    """Keep the newest messages that fit a 32k-token local context. Starts on a
    plain user message so no tool_result loses its tool call."""
    total, keep = 0, []
    for m in reversed(messages):
        total += len(json.dumps(m["content"]))
        keep.append(m)
        if total > budget_chars:
            break
    keep.reverse()
    while keep and not (keep[0]["role"] == "user" and any(
            b.get("type") == "text" for b in (keep[0]["content"] if isinstance(keep[0]["content"], list)
                                              else [{"type": "text"}]))):
        keep.pop(0)
    return keep or messages[-1:]


TOOL_NAMES = {t["name"] for t in TOOLS}


def loose_tool_calls(text):
    """Small local models often print a tool call as JSON text instead of
    calling it. Pick those out so the lesson still works."""
    calls = []
    for m in re.finditer(r"\{[^{}]*\"name\"\s*:\s*\"(\w+)\".*?\}\s*\}", text, re.S):
        if m.group(1) not in TOOL_NAMES:
            continue
        try:
            obj = json.loads(m.group(0))
        except ValueError:
            continue
        args = obj.get("arguments", obj.get("parameters", {}))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                continue
        calls.append((m.group(0), obj["name"], args))
    return calls


def ensure_ollama(emit):
    """The devbox panel keeps Ollama stopped to free the GPU; wake it up."""
    emit({"t": "tool", "name": "starting the local model", "detail": "Ollama"})
    os.system("sudo -n systemctl start ollama >/dev/null 2>&1")
    for _ in range(20):
        if ollama_tags() is not None:
            return
        time.sleep(1)


def ollama_turn(name, chat, model, emit, cancel):
    tag = model.split(":", 1)[1]
    u = users().get(name, {})
    system = teacher_prompt() + "\n\n" + learner_context(name, u)
    tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                               "parameters": t["input_schema"]}} for t in TOOLS]
    for _ in range(MAX_ROUNDS):
        if cancel.is_set():
            return
        body = {"model": tag, "stream": True, "tools": tools,
                "messages": to_openai(system, scrub_for_api(name, trim_for_local(chat["messages"]), vision=False))}
        req = urllib.request.Request(OLLAMA + "/v1/chat/completions", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        if ollama_tags() is None:
            ensure_ollama(emit)
        text, calls, in_think = "", {}, False
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                for raw in r:
                    if cancel.is_set():
                        return
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:") or line == "data: [DONE]":
                        continue
                    ch = json.loads(line[5:])
                    for choice in ch.get("choices", []):
                        d = choice.get("delta", {})
                        if d.get("reasoning") and not in_think:
                            in_think = True
                            emit({"t": "thinking"})
                        piece = d.get("content") or ""
                        if piece:
                            text += piece
                            # qwen3 may inline its reasoning in <think> tags
                            vis = re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.S)
                            prev = re.sub(r"<think>.*?(</think>|$)", "", text[:-len(piece)], flags=re.S)
                            if len(vis) > len(prev) and vis.startswith(prev):
                                emit({"t": "text", "d": vis[len(prev):]})
                        for tc in d.get("tool_calls") or []:
                            i = tc.get("index", len(calls))
                            c = calls.setdefault(i, {"id": tc.get("id") or "call_" + uuid.uuid4().hex[:12],
                                                     "name": "", "args": ""})
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                c["name"] = fn["name"]
                                emit({"t": "tool_start", "name": fn["name"]})
                            c["args"] += fn.get("arguments") or ""
        except OSError as e:
            raise Stop("Local model is not reachable (%s). Is Ollama running? The devbox "
                       "panel's Models tab starts it." % e)

        text = re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.S).strip()
        uses = []
        for c in calls.values():
            try:
                args = json.loads(c["args"] or "{}")
            except ValueError:
                args = None
            uses.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": args})
        if not uses:
            for raw, tname, args in loose_tool_calls(text):
                text = text.replace(raw, "").strip()
                uses.append({"type": "tool_use", "id": "call_" + uuid.uuid4().hex[:12],
                             "name": tname, "input": args})
        blocks = ([{"type": "text", "text": text}] if text else []) + uses
        if not blocks:
            blocks = [{"type": "text", "text": "(no answer)"}]
        chat["messages"].append({"role": "assistant", "content": blocks})
        chat_save(name, chat)
        add_spend(name, 0.0, model, {"local": 1})
        if not uses:
            return
        results = []
        for b in uses:
            emit({"t": "tool", "name": b["name"], "detail": summarize_input(b["name"], b["input"])})
            t, err = run_tool(name, b["name"], b["input"], emit)
            results.append({"type": "tool_result", "tool_use_id": b["id"], "content": t,
                            **({"is_error": True} if err else {})})
        chat["messages"].append({"role": "user", "content": results})
        chat_save(name, chat)
        if any(b["name"] in ("quiz", "ask_user_question") for b in uses):
            return
    emit({"t": "error", "msg": "Stopped after %d steps. Say 'continue' to go on." % MAX_ROUNDS})


def allowed_models(u):
    allow = u.get("models") or "all"
    return [m for m in MODELS if allow == "all" or m in allow]


def user_model(u):
    m = u.get("model") or config()["default_model"]
    al = allowed_models(u)
    return m if m in al else (al[0] if al else config()["default_model"])


# ---- HTTP --------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "LearningGrounds/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # path relative to the app: funnel strips /learn, direct hits may not
    def rpath(self):
        p = urllib.parse.urlparse(self.path)
        path = p.path
        if path == "/learn":
            path = "/"
        elif path.startswith("/learn/"):
            path = path[len("/learn"):]
        return path, urllib.parse.parse_qs(p.query)

    def client_ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def send(self, code, body, ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("body too large")
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def user(self):
        c = self.headers.get("Cookie") or ""
        m = re.search(r"(?:^|;\s*)lgsess=([A-Za-z0-9_-]+)", c)
        if not m:
            return None, None
        s = sessions().get(m.group(1))
        if not s or s["exp"] < time.time():
            return None, None
        u = users().get(s["user"])
        if not u or u.get("disabled"):
            return None, None
        return s["user"], u

    def admin_ok(self):
        tok = (DATA / "admin.token").read_text().strip()
        return hmac.compare_digest(self.headers.get("X-Admin-Token", ""), tok)

    # ---- GET
    def do_GET(self):
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send(500, {"error": "server error"})
            except OSError:
                pass

    def _get(self):
        path, q = self.rpath()
        if path in ("/", "/index.html"):
            return self.static("index.html")
        if path.startswith("/static/"):
            return self.static(path[len("/static/"):])
        if path.startswith("/admin/"):
            if not self.admin_ok():
                return self.send(403, {"error": "forbidden"})
            if path == "/admin/state":
                return self.send(200, admin_state())
            return self.send(404, {"error": "no such admin route"})

        name, u = self.user()
        if path == "/api/me":
            if not name:
                return self.send(200, {"user": None})
            cap = float(u.get("cap_usd", config()["default_cap_usd"]))
            return self.send(200, {"user": name, "display": u.get("display") or name,
                                   "model": user_model(u),
                                   "models": [{"id": m, "label": MODELS[m]["label"]} for m in allowed_models(u)],
                                   "spent": round(spent(u), 4), "cap": cap,
                                   "about": u.get("about", ""),
                                   "logins": int(u.get("logins", 0)),
                                   "tour": int(u.get("logins", 0)) <= TOUR_LOGINS,
                                   "tour_seen": bool(u.get("tour_seen")),
                                   "key": bool(secret("anthropic_api_key"))})
        if not name:
            return self.send(401, {"error": "login"})
        if path == "/api/tree":
            return self.send(200, {"tree": tree(name)})
        if path == "/api/file":
            try:
                p = safe_path(name, (q.get("path") or [""])[0], must_exist=True)
            except PathError as e:
                return self.send(404, {"error": str(e)})
            if p.is_dir() or hidden(rel_of(name, p)):
                return self.send(404, {"error": "not a file"})
            ctype = mimetypes.guess_type(p.name)[0] or "text/plain"
            data = p.read_bytes()
            if ctype.startswith("text/") or p.suffix in (".json", ".md", ".cpp", ".h", ".py", ".js"):
                ctype = "text/plain; charset=utf-8"       # never served as live HTML
            elif ctype == "application/pdf":
                # the browser's own PDF viewer; it refuses to run under a sandbox CSP
                return self.send(200, data, ctype, {"Content-Disposition": "inline"})
            elif not ctype.startswith("image/") or p.suffix.lower() == ".svg":
                ctype = "application/octet-stream"
                dl = urllib.parse.quote(p.name)
                return self.send(200, data, ctype, {"Content-Disposition": "attachment; filename*=UTF-8''" + dl,
                                                    "Content-Security-Policy": "sandbox"})
            return self.send(200, data, ctype, {"Content-Disposition": "inline",
                                                "Content-Security-Policy": "sandbox"})
        if path == "/api/extract":
            try:
                p = safe_path(name, (q.get("path") or [""])[0], must_exist=True)
            except PathError as e:
                return self.send(404, {"error": str(e)})
            if p.is_dir() or hidden(rel_of(name, p)):
                return self.send(404, {"error": "not a file"})
            return self.send(200, {"text": extract_text(name, p)[:MAX_EXTRACT], "size": p.stat().st_size})
        if path == "/api/chats":
            return self.send(200, {"chats": chat_list(name)})
        if path == "/api/chat":
            c = chat_load(name, (q.get("id") or [""])[0])
            if not c:
                return self.send(404, {"error": "no such chat"})
            return self.send(200, {"id": c["id"], "title": c.get("title"), "items": chat_for_ui(c),
                                   "busy": name in _busy})
        if path == "/api/blocks":
            return self.send(200, {"blocks": block_list()})
        return self.send(404, {"error": "not found"})

    def static(self, rel):
        p = (STATIC / rel).resolve()
        if not p.is_relative_to(STATIC.resolve()) or not p.is_file():
            return self.send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        return self.send(200, p.read_bytes(), ctype)

    # ---- POST
    def do_POST(self):
        try:
            self._post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send(500, {"error": "server error"})
            except OSError:
                pass

    def _post(self):
        path, q = self.rpath()
        if path == "/api/upload":
            return self.upload(q)
        b = self.body()
        if path.startswith("/admin/"):
            if not self.admin_ok():
                return self.send(403, {"error": "forbidden"})
            return self.send(200, admin_action(path[len("/admin/"):], b))

        if path == "/api/login":
            return self.login(b)
        name, u = self.user()
        if path == "/api/logout":
            m = re.search(r"lgsess=([A-Za-z0-9_-]+)", self.headers.get("Cookie") or "")
            if m:
                drop_sessions(tok=m.group(1))
            return self.send(200, {"ok": True}, headers={"Set-Cookie": "lgsess=; Path=/; Max-Age=0"})
        if not name:
            return self.send(401, {"error": "login"})

        if path == "/api/model":
            m = b.get("model")
            if m not in allowed_models(u):
                return self.send(400, {"error": "model not allowed"})
            with _lock:
                us = users()
                us[name]["model"] = m
                save_users(us)
            return self.send(200, {"ok": True})
        if path == "/api/about":                 # the learner's own profile
            with _lock:
                us = users()
                if "about" in b:
                    us[name]["about"] = str(b["about"])[:2000]
                if str(b.get("display", "")).strip():
                    us[name]["display"] = str(b["display"]).strip()[:60]
                save_users(us)
                return self.send(200, {"ok": True, "about": us[name].get("about", ""),
                                       "display": us[name].get("display") or name})
        if path == "/api/tour":                  # the walkthrough was opened once
            with _lock:
                us = users()
                us[name]["tour_seen"] = True
                save_users(us)
            return self.send(200, {"ok": True})
        if path == "/api/file":                  # the learner editing in the reader
            try:
                p = safe_path(name, b.get("path"))
            except PathError as e:
                return self.send(400, {"error": str(e)})
            if hidden(rel_of(name, p)) or not isinstance(b.get("content"), str):
                return self.send(400, {"error": "bad file"})
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(b["content"])
            return self.send(200, {"ok": True})
        if path in ("/api/mkdir", "/api/delete", "/api/move"):
            return self.files(name, path, b)
        if path == "/api/chat/new":
            c = {"id": uuid.uuid4().hex, "title": "New chat", "created": int(time.time()),
                 "updated": int(time.time()), "messages": []}
            chat_save(name, c)
            return self.send(200, {"id": c["id"]})
        if path == "/api/chat/delete":
            c = chat_load(name, b.get("id"))
            if c:
                (chats_dir(name) / (c["id"] + ".json")).unlink(missing_ok=True)
            return self.send(200, {"ok": True})
        if path == "/api/stop":
            ev = _busy.get(name)
            if ev:
                ev.set()
            return self.send(200, {"ok": True})
        if path == "/api/send":
            return self.chat_send(name, u, b)
        return self.send(404, {"error": "not found"})

    _fails = {}

    def upload(self, q):
        """POST api/upload?folder=Uploads&name=photo.jpg with the raw file as
        the body. Answers with the path it was saved to."""
        name, u = self.user()
        n = int(self.headers.get("Content-Length") or 0)
        if not name:
            self.close_connection = True
            return self.send(401, {"error": "login"})
        if n <= 0:
            return self.send(400, {"error": "empty file"})
        if n > MAX_UPLOAD:
            self.close_connection = True
            return self.send(413, {"error": "That file is too big (limit %d MB)." % (MAX_UPLOAD // 1_000_000)})
        folder = (q.get("folder") or ["Uploads"])[0].strip().strip("/")
        try:
            dst = upload_name(name, folder, (q.get("name") or ["file"])[0])
        except PathError as e:
            self.rfile.read(n)
            return self.send(400, {"error": str(e)})
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(".up-" + uuid.uuid4().hex)
        left = n
        try:
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise OSError("upload cut off")
                    f.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, dst)
        except OSError:
            tmp.unlink(missing_ok=True)
            self.close_connection = True
            return self.send(400, {"error": "The upload was cut off. Try again."})
        return self.send(200, {"ok": True, "path": rel_of(name, dst), "size": n,
                               "kind": file_kind(dst)})

    def login(self, b):
        name = str(b.get("user", "")).strip().lower()
        key = name + "|" + self.client_ip()
        rec = self._fails.get(key, [0, 0.0])
        if rec[1] > time.time():
            return self.send(429, {"error": "Too many tries. Wait a minute."})
        u = users().get(name)
        if u and not u.get("disabled") and check_pw(u, str(b.get("pass", ""))):
            self._fails.pop(key, None)
            with _lock:                          # first logins get the walkthrough
                us = users()
                us[name]["logins"] = int(us[name].get("logins", 0)) + 1
                save_users(us)
            tok = new_session(name)
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" or \
                self.headers.get("Tailscale-Funnel-Request") else ""
            return self.send(200, {"ok": True}, headers={
                "Set-Cookie": "lgsess=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d%s"
                              % (tok, SESSION_DAYS * 86400, secure)})
        rec[0] += 1
        if rec[0] >= 5:
            rec = [0, time.time() + 60]
        self._fails[key] = rec
        return self.send(401, {"error": "Wrong name or password."})

    def files(self, name, path, b):
        try:
            if path == "/api/mkdir":
                p = safe_path(name, b.get("path"))
                if hidden(rel_of(name, p)):
                    raise PathError("hidden names are reserved")
                p.mkdir(parents=True, exist_ok=True)
            elif path == "/api/delete":
                p = safe_path(name, b.get("path"), must_exist=True)
                if p == ws_dir(name).resolve():
                    raise PathError("refusing")
                trash = DATA / "trash" / name / time.strftime("%Y%m%d-%H%M%S")
                trash.mkdir(parents=True, exist_ok=True)
                shutil.move(str(p), str(trash / p.name))
            else:
                a = safe_path(name, b.get("src"), must_exist=True)
                d = safe_path(name, b.get("dst"))
                if d.exists() or hidden(rel_of(name, d)):
                    raise PathError("destination exists")
                d.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(a), str(d))
        except PathError as e:
            return self.send(400, {"error": str(e)})
        return self.send(200, {"ok": True})

    def chat_send(self, name, u, b):
        chat = chat_load(name, b.get("chat"))
        if not chat:
            return self.send(404, {"error": "no such chat"})
        text = str(b.get("text", "")).strip()
        atts = []
        for rel in (b.get("attachments") or [])[:MAX_ATTACH]:
            try:
                p = safe_path(name, rel, must_exist=True)
            except PathError:
                continue
            if p.is_file() and not hidden(rel_of(name, p)):
                atts.append(rel_of(name, p))
        if not text and not atts:
            return self.send(400, {"error": "empty"})
        model = b.get("model") or user_model(u)
        if model not in allowed_models(u):
            return self.send(400, {"error": "model not allowed"})
        with _lock:
            if name in _busy:
                return self.send(409, {"error": "Still answering the last message."})
            cancel = threading.Event()
            _busy[name] = cancel

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(ev):
            try:
                self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
            except OSError:
                cancel.set()             # the browser went away: stop spending

        try:
            first = not chat["messages"]
            if atts:
                names = ", ".join(atts)
                text = ("(The learner attached: %s)\n\n%s" % (names, text or
                        "Here you go. Have a look and help me with it.")).strip()
            block = {"type": "text", "text": text}
            if b.get("display"):
                block["display"] = str(b["display"])[:4000]
            elif atts:
                block["display"] = str(b.get("text", "")).strip()
            if atts:
                block["attachments"] = atts
            if first:
                # The workspace map rides on the first message only, so the
                # cached prefix of later turns never changes.
                block["text"] = ("<workspace>\n%s\n</workspace>\n\n%s" % (tree_text(name), text))
                if "display" not in block:
                    block["display"] = text
                chat["title"] = (b.get("display") or b.get("text") or
                                 ("📎 " + atts[0].split("/")[-1] if atts else text))[:60]
            # files first, then the words (what the API docs recommend)
            files = [{"type": "lg_file", "path": a} for a in atts]
            chat["messages"].append({"role": "user", "content": files + [block]})
            chat["updated"] = int(time.time())
            chat_save(name, chat)
            if MODELS[model]["provider"] == "anthropic":
                anthropic_turn(name, chat, model, emit, cancel)
            else:
                ollama_turn(name, chat, model, emit, cancel)
        except Stop as e:
            emit({"t": "error", "msg": str(e)})
        except anthropic.AuthenticationError:
            emit({"t": "error", "msg": "The API key was rejected. The admin can paste a new one in the panel."})
        except anthropic.RateLimitError:
            emit({"t": "error", "msg": "The API is rate limiting us; wait a moment and try again."})
        except anthropic.APIStatusError as e:
            emit({"t": "error", "msg": "API error %s: %s" % (e.status_code, str(e.message)[:300])})
        except anthropic.APIConnectionError:
            emit({"t": "error", "msg": "Could not reach the Anthropic API."})
        except Exception as e:
            traceback.print_exc()
            emit({"t": "error", "msg": "Something broke: %s" % str(e)[:200]})
        finally:
            fix_dangling(chat)
            chat["updated"] = int(time.time())
            chat_save(name, chat)
            with _lock:
                _busy.pop(name, None)
            emit({"t": "done"})


def fix_dangling(chat):
    """If a turn was cut off after an assistant tool call, answer every open
    call so the history stays valid for the next request."""
    msgs = chat.get("messages", [])
    if not msgs or msgs[-1]["role"] != "assistant":
        return
    c = msgs[-1]["content"]
    ids = [b["id"] for b in c if isinstance(b, dict) and b.get("type") == "tool_use"] if isinstance(c, list) else []
    if ids:
        msgs.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": i, "content": "stopped before this ran",
             "is_error": True} for i in ids]})


# ---- admin -----------------------------------------------------------------------

def ollama_tags():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=2) as r:
            return [m["name"] for m in json.load(r).get("models", [])]
    except (OSError, ValueError):
        return None


def admin_state():
    us = users()
    key = secret("anthropic_api_key")
    rows = []
    for n, u in sorted(us.items()):
        rows.append({"name": n, "display": u.get("display", ""), "about": u.get("about", ""),
                     "model": user_model(u), "models": u.get("models") or "all",
                     "cap": float(u.get("cap_usd", config()["default_cap_usd"])),
                     "spent": round(spent(u), 4), "disabled": bool(u.get("disabled")),
                     "created": u.get("created", 0), "chats": len(list(chats_dir(n).glob("*.json"))),
                     "logins": int(u.get("logins", 0))})
    return {"users": rows, "config": config(),
            "key": (key[:10] + "…" + key[-4:]) if key else "",
            "models": [{"id": m, **{k: v for k, v in p.items()}} for m, p in MODELS.items()],
            "ollama": ollama_tags(), "busy": list(_busy),
            "blocks": block_list()}


def admin_action(action, b):
    with _lock:
        us = users()
        if action == "user/create":
            n = str(b.get("name", "")).strip().lower()
            if not NAME_RE.match(n):
                return {"ok": False, "msg": "name: 2-32 chars, a-z 0-9 _ -"}
            if n in us:
                return {"ok": False, "msg": "that name exists"}
            pw = str(b.get("password", ""))
            if len(pw) < 6:
                return {"ok": False, "msg": "password: at least 6 characters"}
            salt, h = hash_pw(pw)
            us[n] = {"salt": salt, "pw": h, "display": str(b.get("display", ""))[:60] or n,
                     "about": str(b.get("about", ""))[:2000], "created": int(time.time()),
                     "cap_usd": float(b.get("cap", config()["default_cap_usd"])),
                     "model": b.get("model") if b.get("model") in MODELS else None}
            save_users(us)
            ws_dir(n)
            return {"ok": True, "msg": "created " + n}
        n = str(b.get("name", ""))
        if action.startswith("user/") and n not in us:
            return {"ok": False, "msg": "no such user"}
        if action == "user/update":
            u = us[n]
            for k in ("display", "about"):
                if k in b:
                    u[k] = str(b[k])[:2000]
            if "cap" in b:
                u["cap_usd"] = max(0.0, float(b["cap"]))
            if "model" in b and b["model"] in MODELS:
                u["model"] = b["model"]
            if "models" in b:
                m = b["models"]
                u["models"] = "all" if m == "all" else [x for x in m if x in MODELS]
            if "disabled" in b:
                u["disabled"] = bool(b["disabled"])
                if u["disabled"]:
                    drop_sessions(name=n)
            save_users(us)
            return {"ok": True, "msg": "saved " + n}
        if action == "user/password":
            pw = str(b.get("password", ""))
            if len(pw) < 6:
                return {"ok": False, "msg": "password: at least 6 characters"}
            us[n]["salt"], us[n]["pw"] = hash_pw(pw)
            save_users(us)
            drop_sessions(name=n)
            return {"ok": True, "msg": "password changed; they need to log in again"}
        if action == "user/delete":
            del us[n]
            save_users(us)
            drop_sessions(name=n)
            src = WS_ROOT / n
            if src.exists():
                dst = DATA / "trash" / ("deleted-%s-%s" % (n, time.strftime("%Y%m%d-%H%M%S")))
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
            return {"ok": True, "msg": "deleted %s (files kept in the trash folder)" % n}
        if action == "config":
            c = config()
            if b.get("default_model") in MODELS:
                c["default_model"] = b["default_model"]
            if "default_cap" in b:
                c["default_cap_usd"] = max(0.0, float(b["default_cap"]))
            if "web_search" in b:
                c["web_search"] = bool(b["web_search"])
            _save("config.json", c)
            if "api_key" in b:
                s = _load("secrets.json", {})
                k = str(b["api_key"]).strip()
                if k:
                    s["anthropic_api_key"] = k
                else:
                    s.pop("anthropic_api_key", None)
                _save("secrets.json", s, private=True)
            return {"ok": True, "msg": "saved"}
        if action == "test_key":
            key = secret("anthropic_api_key")
            if not key:
                return {"ok": False, "msg": "no key saved"}
            try:
                client = anthropic.Anthropic(api_key=key, max_retries=0)
                ms = client.models.list(limit=5)
                return {"ok": True, "msg": "key works (%d models visible)" % len(ms.data)}
            except anthropic.AuthenticationError:
                return {"ok": False, "msg": "key rejected"}
            except anthropic.APIError as e:
                return {"ok": False, "msg": "API error: %s" % str(e)[:200]}
    return {"ok": False, "msg": "unknown action"}


def main():
    for d in (DATA, WS_ROOT, CONTRIB):
        d.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA, 0o700)
    tokf = DATA / "admin.token"
    if not tokf.exists():
        tokf.write_text(secrets.token_urlsafe(32))
        os.chmod(tokf, 0o600)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print("learning grounds on 127.0.0.1:%d, data in %s" % (PORT, DATA), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
