#!/usr/bin/env python3
"""Build grounds/blocks/*.json (the teacher's building-block library) from the
sample files in this folder, so every example is a file the site really renders.

Run after changing a sample or a spec:  python grounds/samples/make_blocks.py
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "blocks"


def sample(rel):
    return (HERE / rel).read_text()


MINI_APP = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini app</title>
<!-- Optional libraries, only from cdn.jsdelivr.net/npm with a pinned version: -->
<script src="https://cdn.jsdelivr.net/npm/mathjs@13.0.0/lib/browser/math.js"></script>
<style>
  :root { --bg:#f6f6fb; --panel:#fff; --line:#e2e2ec; --text:#1d1d2b; --muted:#6a6a80; --accent:#5b5bd6; --good:#1f9d55; --bad:#d64545; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12121a; --panel:#1b1b26; --line:#2e2e3e; --text:#ececf4; --muted:#9b9bb2; --accent:#8b8bff; --good:#4ade80; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-top: 12px; }
  canvas { width: 100%; height: 300px; display: block; border: 1px solid var(--line); border-radius: 10px; }
  .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 12px; }
  label { display: grid; gap: 4px; font-size: 14px; font-weight: 600; }
  input, select, button { font: inherit; color: inherit; }
  input, select { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
  input[type=range] { padding: 0; accent-color: var(--accent); }
  button { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<h1>TITLE</h1>
<p class="muted">One sentence: what to try and what to notice.</p>
<div class="panel">
  <canvas id="c"></canvas>
  <div class="controls">
    <label>Speed: <span id="sv">1</span><input id="s" type="range" min="0" max="5" step="0.1" value="1"></label>
    <button id="go" type="button">Start</button>
  </div>
</div>
<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let t = 0, running = false;
  function draw() {
    const c = $("c"), r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css("--panel"); g.fillRect(0, 0, r.width, r.height);
    // ... draw the idea here, using css("--accent") etc. so it fits light and dark ...
    g.fillStyle = css("--accent");
    g.beginPath(); g.arc(r.width / 2 + Math.cos(t) * 80, r.height / 2 + Math.sin(t) * 80, 10, 0, 7); g.fill();
  }
  function tick() { if (!running) return; t += 0.02 * +$("s").value; draw(); requestAnimationFrame(tick); }
  $("s").addEventListener("input", () => { $("sv").textContent = $("s").value; });
  $("go").onclick = () => { running = !running; $("go").textContent = running ? "Pause" : "Start"; tick(); };
  addEventListener("resize", draw);
  draw();
})();
</script>
</body>
</html>
"""

NOTES_EXAMPLE = """# Derivatives: the slope at a point

A derivative tells you **how fast something changes**. For $f(x) = x^2$ the slope at $x$ is $f'(x) = 2x$.

## The idea

Take two points close together and measure the slope between them:

$$
f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}
$$

```mermaid
graph LR
  A[Two points] --> B[Slope of the line through them] --> C[Move them together] --> D[Slope at one point]
```

```plot
{"title": "y = x² and its slope 2x", "domain": [-3, 3], "functions": [{"expr": "x^2", "label": "f(x) = x²"}, {"expr": "2x", "label": "f'(x) = 2x"}]}
```

> **Remember:** a derivative is a slope, and a slope is "rise over run".

```quiz
{"questions": [{"question": "What is the slope of $f(x) = x^2$ at $x = 3$?", "options": ["3", "6", "9"], "answer": 1, "explanation": "$f'(x) = 2x$, so $f'(3) = 6$."}]}
```

Next: [practice lab](02-derivatives.lab.json)
"""

BLOCKS = {
    "notes": {
        "summary": "Lesson notes in Markdown with LaTeX math, mermaid diagrams, inline graphs and inline quizzes.",
        "file": "*.md",
        "how_to_use": """Plain GitHub Markdown, rendered in the reader (and the same renderer is used for chat bubbles).
- Math: $...$ inline, $$...$$ display (KaTeX). Escape a literal dollar as \\$. Inside JSON blocks (plot/quiz) backslashes must be doubled: "$\\\\frac{1}{2}$".
- Diagrams: a ```mermaid fence (flowchart, sequence, etc.). Keep labels short; quote labels with special characters: A["f(x) = x²"].
- Inline interactive graph: a ```plot fence whose body is exactly the JSON of a .plot.json file (see the plot block).
- Inline quiz: a ```quiz fence with {"questions": [...]} as in the quiz block.
- Inline flashcards: a ```flash fence with {"cards": [...]} (flashcards block). Inline lab: ```lab fence with a .lab.json body.
- Code: normal fences with a language (```cpp, ```python) get syntax highlighting.
- Links: relative paths open workspace files in the reader, e.g. [practice](02-practice.quiz.json) or [map](../README.md). Images: ![alt](diagram.svg) from the workspace. External https links open in a new tab.
- Raw HTML is sanitized (no scripts, styles, forms). For interactive things use a .plot.json, .lab.json or an .html mini app instead.
Structure: one # title, short sections with ## headings, a concrete example before the formula, a "Remember" blockquote for the key idea, a quick check at the end, and a link to the next material.""",
        "example": NOTES_EXAMPLE,
    },
    "quiz": {
        "summary": "A graded multiple-choice practice set; the learner checks answers in the reader and can send the score to you.",
        "file": "*.quiz.json",
        "how_to_use": """JSON object:
{"title": string, "intro"?: markdown string, "questions": [{"question": markdown, "options": [markdown, ...2-6], "answer": 0-based index of the correct option, "explanation": markdown}]}
- Strings may contain $LaTeX$; in JSON every backslash is doubled ("$\\\\int_0^1 x\\\\,dx$").
- Options are bare claims of similar length; put all reasoning in explanation (shown after checking, for every question).
- 3-8 questions per file. The learner gets ✓/✗ per question, a score, and a "Send results to teacher" button that sends you the full per-question results.
- For a quick check inside the chat use the quiz tool instead; for a check inside notes use a ```quiz fence with this same JSON.""",
        "example": sample("Math/Integrals/02-practice.quiz.json"),
    },
    "flashcards": {
        "summary": "A flip-card deck for memorising facts, formulas or vocabulary, with shuffle and know/again repetition.",
        "file": "*.flash.json",
        "how_to_use": """JSON object:
{"title": string, "cards": [{"front": markdown, "back": markdown}]}
- Fronts are short prompts (a term, a formula to complete, a word to translate). Backs are the answer plus at most one line of why.
- Markdown and $LaTeX$ work on both sides (double the backslashes in JSON).
- The learner taps to flip, then presses "Again" (card comes back soon) or "I knew it". When the deck is done they can tell you.
- 6-25 cards per deck; split bigger sets by subtopic.""",
        "example": sample("Math/Integrals/03-cards.flash.json"),
    },
    "plot": {
        "summary": "Interactive function graph: several curves, sliders for parameters, labelled points, shaded area with its value; pan and zoom.",
        "file": "*.plot.json",
        "how_to_use": """JSON object:
{"title"?: string, "description"?: markdown,
 "domain": [xmin, xmax], "range"?: [ymin, ymax] (omit to fit automatically),
 "var"?: "x",
 "functions": [{"expr": math.js expression in x and params, "label"?: string, "color"?: "#hex", "dash"?: true}],
 "params"?: {"name": {"min": n, "max": n, "step": n, "value": n, "label"?: string}},
 "points"?: [{"x": number or expression, "y": number or expression, "label"?: string, "color"?: "#hex"}],
 "area"?: {"expr": expression (top curve), "expr2"?: expression (bottom curve; default the x-axis), "from": number or expression, "to": number or expression, "label"?: string, "color"?: "#hex"}}
- Expressions use math.js syntax: x^2, 2x, sin(x), sqrt(x), exp(x), log(x) (natural), ln(x), abs(x), pi, e. Params are plain names used in expressions, and also in points and area bounds, so sliders move them.
- The legend shows the shaded area's numeric value (signed integral), which updates with sliders.
- Use it to show a shape, compare curves, or let the learner discover what a parameter does. Also usable inline in notes as a ```plot fence.""",
        "example": sample("Math/Integrals/04-area.plot.json"),
    },
    "function-transformations": {
        "summary": "Ready plot: a parent function and its transformed version a·f(x−h)+k with sliders for a, h, k and the vertex marked.",
        "file": "*.plot.json",
        "how_to_use": """A filled-in plot block (same format as "plot"). Swap x^2 for any parent function (sqrt(x), abs(x), sin(x), 2^x) in both expressions, keep the dashed original for comparison, and adjust domain/range so the interesting part is visible. Rename params or drop one to focus on a single transformation (for example only k for vertical shifts).""",
        "example": sample("Math/Functions/transformations.plot.json"),
    },
    "lab": {
        "summary": "Math practice lab: the learner types expressions or solutions, gets them checked, and sees their answer plotted against the correct one with differences shaded.",
        "file": "*.lab.json",
        "how_to_use": """JSON object:
{"title": string, "intro"?: markdown,
 "tasks": [{"prompt": markdown, "kind": "expression" | "antiderivative" | "derivative" | "equation",
            "target": string, "var"?: "x", "domain"?: [a, b], "hint"?: markdown, "solution"?: string}]}
How each kind is checked (numerically, at ~50 points of domain; default domain [-4, 4], equations [-10, 10]):
- expression: target is the correct expression; the learner's must be equal everywhere (simplify, expand, factor, rewrite).
- antiderivative: target is f(x), the integrand. The learner types F(x); it is correct when the numeric derivative of F equals f (any + C is fine).
- derivative: target is the function to differentiate g(x). The learner types g'(x); it is compared with the exact derivative.
- equation: target is "lhs = rhs" in var. The learner types the solutions separated by commas ("2, 3", "x = -1", "sqrt(2), -sqrt(2)") or "none". Each is substituted; wrong ones and missing ones (found numerically on domain) are reported.
Targets use math.js syntax (x^2, 3x, sin(x), exp(x), log(x) natural, sqrt). Pick a domain where target is defined (for log(x) or sqrt(x) use e.g. [0.1, 5]).
solution is shown on request: a plain expression (rendered as math) or markdown. hint is markdown.
The learner always sees a graph of their answer against the correct one, with red shading where they differ and the worst points marked, plus a scratch graph, and can send an attempt to you.""",
        "example": sample("Math/Integrals/05-integration.lab.json"),
    },
    "topic-readme": {
        "summary": "A topic's README.md: what it covers, what the learner already knows, a mermaid map of what comes next, and a table linking every material.",
        "file": "<Topic>/README.md",
        "how_to_use": """Every top-level folder (a topic) gets README.md. Keep it current whenever you add, rename or finish material.
Sections, in this order:
1. # Topic name and one sentence on what it is for this learner.
2. ## What you already have: known skills, including links to other topics ("functions, which you know from C++").
3. ## Where we are going: a ```mermaid graph LR of concepts and their dependencies; mark done ones with ✅ in their labels if useful.
4. ## Materials: a table | Step | Material | Kind | with relative links in teaching order.
5. ## Next up: the very next thing to do.
Subtopics live in subfolders (Math/Integrals/...), files are numbered 01-, 02- in teaching order.""",
        "example": sample("Math/README.md"),
    },
    "html-mini-app": {
        "summary": "Skeleton for a self-contained interactive .html page (simulation, explorer, game) that runs sandboxed in the reader.",
        "file": "*.html",
        "how_to_use": """One complete HTML file, opened in the reader inside <iframe sandbox="allow-scripts">:
- Scripts run, but the page has no access to the site, cookies, localStorage, popups, forms or top navigation. Keep all state in JS variables.
- Libraries only from https://cdn.jsdelivr.net/npm/<pkg>@<exact version>/... (e.g. mathjs@13.0.0/lib/browser/math.js). Everything else inline.
- Use the CSS variables in the skeleton and prefers-color-scheme so it looks right in light and dark; size the canvas from getBoundingClientRect and redraw on resize (phones are ~360px wide).
- Big touch-friendly controls, a one-line instruction at the top, and live numbers next to the picture.
- Prefer a plot or lab block when it can do the job; use a mini app for things they cannot (animations, simulations, step-by-step explorers).
- When the app is general (not tied to one learner), save_block it so it can be reused.""",
        "example": MINI_APP,
    },
    "riemann-sum-explorer": {
        "summary": "Ready mini app: rectangles approximating the area under any function, with left/middle/right rule, n slider and error readout.",
        "file": "*.html",
        "how_to_use": """A finished html-mini-app. Copy it as is into the learner's integration folder (for example Math/Integrals/riemann-explorer.html) and show_file it. Change the default function, a and b in the input values to match the lesson (value="x^2", a=0, b=2). The learner can type any math.js function.""",
        "example": sample("Math/Integrals/riemann-explorer.html"),
    },
}


def main():
    OUT.mkdir(exist_ok=True)
    for name, b in BLOCKS.items():
        if b["file"].endswith(".json"):
            json.loads(b["example"])            # every JSON example must parse
        (OUT / (name + ".json")).write_text(json.dumps(b, indent=1, ensure_ascii=False) + "\n")
    print("wrote %d blocks to %s" % (len(BLOCKS), OUT))


if __name__ == "__main__":
    main()
