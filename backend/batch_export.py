"""Zip a generator batch: .xosc, save file and route XML per scenario, plus the manifest."""

import uuid

from backend.scenario_io import _ensure_llmgen_on_path, validate_scenario_params

# ── Batch export (scenario generator, phase 2) ────────────────────────────────


def _flatten(prefix: str, value, out: dict) -> None:
    """{"a": {"b": 1}} -> {"a.b": 1}, for one CSV column per leaf."""
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(f"{prefix}.{k}" if prefix else str(k), v, out)
    else:
        out[prefix] = value


def export_batch_zip(entries: list) -> tuple:
    """
    Build one zip from many generated scenarios.

    Each entry is {"name", "params", "scenario", "meta"}: `params` is the
    ordinary /api/export payload, `scenario` the editor's own save file
    (AppState.toJSON — reopens with Laden), `meta` the generator's record
    (seed, type, criticality, parameters) for the manifest.

    Per scenario the zip holds <name>.xosc, <name>.json and <name>_route.xml
    (the ego's route as a goal for an AV stack under test). Each is exported
    independently: one that fails validation is listed in the manifest with its
    error rather than sinking the batch.

    Returns (zip_path, n_ok, n_failed). Raises ValueError when nothing exported.
    """
    import copy
    import csv as _csv
    import io
    import json as _json
    import os as _os
    import re
    import zipfile

    _ensure_llmgen_on_path()
    from generator.route_builder import build_route  # type: ignore
    from generator.xml_builder import build_xosc  # type: ignore

    if not isinstance(entries, list) or not entries:
        raise ValueError("scenarios must be a non-empty list")

    uid = str(uuid.uuid4())[:8]
    zip_path = f"/tmp/scenarios_{uid}.zip"
    manifest, used = [], set()
    n_ok = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, entry in enumerate(entries):
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(entry.get("name") or f"scenario_{i + 1:04d}"))
            while name in used:
                name += "_"
            used.add(name)
            row = {"name": name, "status": "ok", "error": ""}
            _flatten("", entry.get("meta") or {}, row)
            try:
                params = validate_scenario_params(copy.deepcopy(entry.get("params")))
                for builder, suffix in ((build_xosc, ".xosc"), (build_route, "_route.xml")):
                    tmp = f"/tmp/{name}_{uid}{suffix}"
                    try:
                        builder(copy.deepcopy(params), tmp)
                        zf.write(tmp, f"{name}{suffix}")
                    finally:
                        if _os.path.exists(tmp):
                            _os.remove(tmp)
                zf.writestr(f"{name}.json", _json.dumps(entry.get("scenario") or {}, indent=2))
                n_ok += 1
            except Exception as e:  # noqa: BLE001 — recorded per scenario, see docstring
                row["status"] = "failed"
                row["error"] = str(e)[:300]
            manifest.append(row)

        zf.writestr("manifest.json", _json.dumps(manifest, indent=2))
        columns = []
        for row in manifest:
            for k in row:
                if k not in columns:
                    columns.append(k)
        buf = io.StringIO()
        writer = _csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in manifest:
            writer.writerow({k: _json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()})
        zf.writestr("manifest.csv", buf.getvalue())

    if n_ok == 0:
        _os.remove(zip_path)
        raise ValueError("no scenario in the batch could be exported: " + "; ".join(r["error"] for r in manifest[:3]))
    return zip_path, n_ok, len(manifest) - n_ok
