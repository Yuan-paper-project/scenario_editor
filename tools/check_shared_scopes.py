"""Fail if a frontend file uses an undeclared name other than its own folder's shared scope.

The split modules share names through one internal global per folder (`MapCore`, `SimCore`, …,
see CLAUDE.md "Frontend conventions"). Biome's noUndeclaredVariables is off in biome.jsonc
because it does not know those globals; run here instead, it catches a name a file uses but
never destructured — which otherwise only fails when the page loads — and an internal global
used outside its folder.
"""

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Folder under frontend/js → the undeclared names its files may use. Top-level files may use none.
ALLOWED = {
    "map": {"MapCore"},
    "sim": {"SimCore"},
    "events": {"EventPanelCore"},
    "objects": {"ObjectsCore"},
    "properties": {"PropertiesCore"},
    "templates": {"TemplatesCore"},
    "generator": {"GeneratorCore"},
    "props": {"PropData", "PropShapes"},
}


def main() -> int:
    out = subprocess.run(
        [
            str(REPO / ".tools" / "biome"),
            "lint",
            "--colors=off",
            "--max-diagnostics=none",
            "--only=correctness/noUndeclaredVariables",
            "--reporter=json",
            "frontend/js",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    try:
        diagnostics = json.loads(out.stdout)["diagnostics"]
    except (json.JSONDecodeError, KeyError):
        print(f"could not read Biome's report:\n{out.stdout}\n{out.stderr}")
        return 1

    bad = defaultdict(list)
    for d in diagnostics:
        path = d["location"]["path"]
        name = d["message"].split()[1]
        parts = Path(path).parts  # frontend, js, <folder>, file  |  frontend, js, file
        folder = parts[2] if len(parts) > 3 else None
        if name not in ALLOWED.get(folder, set()):
            bad[path].append(f"{name} (line {d['location']['start']['line']})")

    for path, names in sorted(bad.items()):
        print(f"{path}: undeclared {', '.join(names)}")
    if bad:
        print("A shared name must be destructured from the folder's own …Core.shared, or be a global in biome.jsonc.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
