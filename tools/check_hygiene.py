"""Fail on the code conventions no other linter checks: frontend file size, change-log comments, a dated CLAUDE.md.

A line carrying ``hygiene: allow`` is exempt from the comment check.
"""

import io
import re
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Python's 400 is pylint's max-module-lines; this is the same rule for the frontend.
MAX_LINES = 400
# Kept over the target on purpose (docs/cleanup-plan.md); each gets a ceiling so it cannot grow unchecked.
CEILINGS = {
    "frontend/js/core/appState.js": 560,
    "frontend/js/bgTraffic.js": 570,
    "frontend/js/props/propSideShapes.js": 570,
    "frontend/css/map.css": 450,
}
EXEMPT = {"frontend/js/props/propData.js"}  # data table

CHANGELOG = re.compile(
    r"\bused to\b|\bpreviously\b|\bformerly\b|\bwas changed\b|\bfixed on\b|\b20\d\d-\d\d-\d\d\b",
    re.IGNORECASE,
)
ISO_DATE = re.compile(r"\b20\d\d-\d\d-\d\d\b")
CLAUDE_MD_WORD_WARN = 37000
ALLOW = "hygiene: allow"


def _py_comments(text):
    """Yield (line, text) for every comment and string literal that opens a line (docstrings)."""
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type == tokenize.COMMENT:
            yield tok.start[0], tok.string
        elif tok.type == tokenize.STRING and tok.line.lstrip().startswith(tok.string[:3]):
            for i, line in enumerate(tok.string.splitlines()):
                yield tok.start[0] + i, line


def _js_comments(text):
    """Yield (line, text) for // and /* */ comments; good enough for this codebase's JS and CSS."""
    for m in re.finditer(r"/\*[\s\S]*?\*/|(?<![:\\'\"])//[^\n]*", text):
        first = text.count("\n", 0, m.start()) + 1
        for i, line in enumerate(m.group().splitlines()):
            yield first + i, line


def check_sizes():
    errors = []
    for path in sorted([*ROOT.glob("frontend/js/**/*.js"), *ROOT.glob("frontend/css/*.css")]):
        rel = path.relative_to(ROOT).as_posix()
        if rel in EXEMPT:
            continue
        limit = CEILINGS.get(rel, MAX_LINES)
        n = len(path.read_text(encoding="utf-8").splitlines())
        if n > limit:
            errors.append(f"{rel}: {n} lines (limit {limit}) — split it along a real seam, see CLAUDE.md")
    return errors


def check_comments():
    errors = []
    files = [*ROOT.glob("backend/**/*.py"), *ROOT.glob("tools/*.py"), *ROOT.glob("tools/probes/*.py")]
    files += [*ROOT.glob("frontend/js/**/*.js"), *ROOT.glob("frontend/css/*.css")]
    for path in sorted(files):
        text = path.read_text(encoding="utf-8")
        source_lines = text.splitlines()
        comments = _py_comments(text) if path.suffix == ".py" else _js_comments(text)
        for lineno, comment in comments:
            if CHANGELOG.search(comment) and ALLOW not in source_lines[lineno - 1]:
                rel = path.relative_to(ROOT).as_posix()
                errors.append(f"{rel}:{lineno}: change-log comment — history belongs in git: {comment.strip()}")
    return errors


def check_claude_md():
    text = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    errors = [
        f"CLAUDE.md:{i}: dated entry — state the rule and its reason, not when it happened"
        for i, line in enumerate(text.splitlines(), 1)
        if ISO_DATE.search(line)
    ]
    words = len(text.split())
    if words > CLAUDE_MD_WORD_WARN:
        print(f"warning: CLAUDE.md is {words} words (> {CLAUDE_MD_WORD_WARN}) — trim before adding more")
    return errors


def main():
    errors = check_sizes() + check_comments() + check_claude_md()
    for e in errors:
        print(e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
