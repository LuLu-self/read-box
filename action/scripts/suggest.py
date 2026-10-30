"""AI suggestions for a (new) category: which saved items probably belong in it.

The board writes a capture {"suggest_for": "<category>"}; the process job prepares a compact list
of the library (prepare), Claude picks candidates into summary.json, and publish keeps only ids that
exist (check) in suggestions.json. Nothing moves until LuLu ticks them on the board.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from common import clip

MAX_ITEMS = 50
NAME_RE = re.compile(r"^[^\s›/\\<>\"][^›/\\<>\"]{0,19}$")


def valid_name(name: object) -> bool:
    return isinstance(name, str) and bool(NAME_RE.match(name.strip()))


def prepare(name: str, index_path: Path, tax: dict, out: Path) -> dict:
    """Write $IN/items.json and $IN/request.json; return the content record for content.json."""
    idx = json.loads(index_path.read_text(encoding="utf-8")) if index_path.is_file() else {"items": []}
    rows = [{"id": r.get("id"), "title": clip(r.get("title"), 80), "one_line": clip(r.get("one_line"), 100),
             "category": r.get("category"), "subcategory": r.get("subcategory", ""),
             "topics": (r.get("tags") or {}).get("topics", [])[:6]}
            for r in idx.get("items", []) if isinstance(r, dict) and r.get("id")]
    cat = next((c for c in tax["categories"] if c["name"] == name), {"name": name, "subs": []})
    out.mkdir(parents=True, exist_ok=True)
    (out / "items.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "request.json").write_text(json.dumps({"category": cat["name"], "subs": cat["subs"]}, ensure_ascii=False), encoding="utf-8")
    (out / "text.txt").write_text("", encoding="utf-8")
    return {"kind": "suggest", "status": "full", "platform": "note", "suggest_for": name, "count": len(rows)}


def check(raw: object, known_ids: set[str], name: str) -> tuple[list[dict], list[str]]:
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        return [], ['summary.json must be {"items": [{"id": "...", "reason": "..."}]}']
    out, errs = [], []
    for it in raw["items"][:MAX_ITEMS]:
        if not isinstance(it, dict) or it.get("id") not in known_ids:
            errs.append(f"unknown id: {str(it.get('id') if isinstance(it, dict) else it)[:40]}")
            continue
        reason = it.get("reason") if isinstance(it.get("reason"), str) else ""
        out.append({"id": it["id"], "reason": clip(reason, 60)})
    # Unknown ids are dropped, not fatal: a short list of real items is still useful.
    return out, [] if out or not raw["items"] else errs
