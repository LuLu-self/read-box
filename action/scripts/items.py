"""List the work items for one run: every inbox/*.json, or one dispatched URL.

CLI: items.py --inbox inbox [--url URL] --run-id N  -> one JSON line (the matrix)
A capture is {"v": 1, "url": "...", "captured_at": "<ISO 8601>", "why": "", "text": "", "client": ""};
url may be empty when text holds a note LuLu typed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
URL_RE = re.compile(r"^https?://[^\s<>\"]{3,2000}$")
WHY_MAX = 200
TEXT_MAX = 60_000
# GitHub caps a matrix at 256 jobs; the rest waits for the next run.
MAX_ITEMS = 100


def check_capture(cap: object) -> str | None:
    if not isinstance(cap, dict):
        return "capture: not a JSON object"
    if cap.get("v") != 1:
        return "capture: v must be 1"
    url, text = cap.get("url") or "", cap.get("text") or ""
    if not isinstance(url, str) or not isinstance(text, str):
        return "capture: url/text must be strings"
    if url and not URL_RE.match(url):
        return "capture: url is not an http(s) link"
    if not url and not text.strip():
        return "capture: needs a url or text"
    if len(text) > TEXT_MAX:
        return "capture: text too long"
    redo = cap.get("redo_of")
    if redo is not None and not (isinstance(redo, str) and ID_RE.match(redo)):
        return "capture: redo_of is not an item id"
    why = cap.get("why") or ""
    if not isinstance(why, str) or len(why) > WHY_MAX:
        return "capture: why must be a string of at most 200 characters"
    try:
        datetime.fromisoformat(str(cap.get("captured_at")))
    except ValueError:
        return "capture: captured_at is not ISO 8601"
    return None


def _item(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except ValueError:
        return {"id": path.stem, "url": "", "error": "capture: not valid JSON"}
    err = check_capture(data)
    return {"id": path.stem, "url": "" if err else data.get("url") or "", "error": err}


def collect(inbox: Path, url: str, run_id: str) -> list[dict]:
    if url:
        return [{"id": f"dispatch-{run_id}", "url": url, "error": None if URL_RE.match(url) else "dispatch: not a link"}]
    out = [_item(p) for p in sorted(inbox.glob("*.json")) if p.is_file() and ID_RE.match(p.stem)]
    if len(out) > MAX_ITEMS:
        print(json.dumps({"deferred": len(out) - MAX_ITEMS}), file=sys.stderr)
    return out[:MAX_ITEMS]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", type=Path, required=True)
    ap.add_argument("--url", default="")
    ap.add_argument("--run-id", required=True)
    a = ap.parse_args(argv)
    print(json.dumps(collect(a.inbox, a.url.strip(), a.run_id), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
