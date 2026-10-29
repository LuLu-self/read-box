"""Write status.json for one item's process leg: {"status": "ok"|"failed", "stage", "error"}.

CLI: status.py OUT --status ok|failed [--stage fetch|ai|pipeline] [--error TEXT]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--status", required=True, choices=["ok", "failed"])
    ap.add_argument("--stage", default="")
    ap.add_argument("--error", default="")
    a = ap.parse_args(argv)
    a.out.write_text(json.dumps({"status": a.status, "stage": a.stage or None, "error": a.error[:300] or None},
                                ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
