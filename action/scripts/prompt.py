"""Render the analyze prompt.

CLI: prompt.py --in DIR --out DIR [--why TEXT] [--taxonomy taxonomy.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from string import Template

sys.path.insert(0, str(Path(__file__).resolve().parent))
import taxonomy  # noqa: E402

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


def render(in_dir: Path, out_dir: Path, why: str, tax: dict) -> str:
    tpl = Template((PROMPTS / "analyze.md").read_text(encoding="utf-8"))
    return tpl.safe_substitute(
        IN=str(in_dir), OUT=str(out_dir),
        # LuLu's note is data too: keep it on one quoted line so it cannot pose as a new rule.
        WHY=repr(" ".join((why or "").split())[:200]) if why else "（沒寫）",
        TAXONOMY=taxonomy.render(tax),
        PLACE_TYPES="、".join(taxonomy.PLACE_TYPES),
        SEASONS="、".join(taxonomy.SEASONS),
    )


def render_suggest(in_dir: Path, out_dir: Path) -> str:
    tpl = Template((PROMPTS / "suggest.md").read_text(encoding="utf-8"))
    return tpl.safe_substitute(IN=str(in_dir), OUT=str(out_dir))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--why", default="")
    ap.add_argument("--taxonomy", type=Path)
    a = ap.parse_args(argv)
    kind = ""
    try:
        kind = json.loads((a.in_dir / "content.json").read_text(encoding="utf-8")).get("kind", "")
    except (OSError, ValueError):
        pass
    print(render_suggest(a.in_dir, a.out) if kind == "suggest" else render(a.in_dir, a.out, a.why, taxonomy.load(a.taxonomy)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
