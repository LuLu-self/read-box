"""Check and clean the AI's summary.json before anything is published.

Hard errors (wrong shape, missing required text, unknown category) send the file back to
Claude for one fix round. Optional items that break a rule (a quote that is not in the text,
an unknown place type) are dropped, not fatal.

CLI: validate.py SUMMARY TEXT [--taxonomy taxonomy.json]  -> prints errors, exit 1 if any
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import places as pl  # noqa: E402
import taxonomy  # noqa: E402
from common import has_chinese  # noqa: E402

CONFIDENCE = {"高", "中", "低"}
NATURE = {"事實為主", "觀點為主", "混合", "無法判斷"}
SPONSORED = {"可能業配", "未見業配"}
LANGS = {"zh-TW", "zh-CN", "ja", "en", "ko", "other"}
EXTRA_KEYS = {"季節", "預算", "交通", "行程天數", "價位", "必點", "營業時間", "適用任務", "方法或框架",
              "適用對象", "主題", "可練習的方法", "適合重讀的時機", "實用清單", "情境", "訓練項目", "強度",
              "注意事項", "重要數字", "建議", "程度", "學習方法", "重點補充"}
TOP_KEYS = {"title", "one_line", "key_points", "quotes", "category", "confidence", "subcategory", "locations", "tags",
            "places", "actions", "nature", "sponsored", "lang", "image_text", "extra"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _str(v, lo: int, hi: int) -> bool:
    return isinstance(v, str) and lo <= len(v.strip()) <= hi


def _str_list(v, n_lo: int, n_hi: int, lo: int, hi: int) -> list[str] | None:
    if not isinstance(v, list):
        return None
    out = [x.strip() for x in v if _str(x, lo, hi)]
    return out[:n_hi] if len(out) >= n_lo else None


def check(raw: object, text: str, tax: dict) -> tuple[dict, list[str]]:
    errs: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["summary.json is not a JSON object"]
    unknown = set(raw) - TOP_KEYS
    if unknown:
        errs.append(f"unknown keys: {sorted(unknown)}")
    s: dict = {}

    for key, lo, hi in (("title", 2, 60), ("one_line", 6, 80)):
        v = raw.get(key)
        if not _str(v, lo, hi) or not has_chinese(v):
            errs.append(f"{key}: must be {lo}-{hi} characters and contain Chinese")
        else:
            s[key] = v.strip()

    kp = _str_list(raw.get("key_points"), 1, 5, 4, 150)
    if kp is None:
        errs.append("key_points: 1-5 items of 4-150 characters")
    else:
        s["key_points"] = kp

    body = _norm(text)
    s["quotes"] = [q for q in (_str_list(raw.get("quotes"), 0, 3, 4, 200) or []) if _norm(q) and _norm(q) in body]

    cat = raw.get("category")
    if cat not in taxonomy.names(tax):
        errs.append(f"category: must be one of {taxonomy.names(tax)}")
    else:
        s["category"] = cat
    s["confidence"] = raw.get("confidence") if raw.get("confidence") in CONFIDENCE else "低"
    sub = raw.get("subcategory") if isinstance(raw.get("subcategory"), str) else ""
    sub = sub.strip().replace(">", "›")
    if cat in taxonomy.FREE_SUBS:
        parts = [x.strip() for x in sub.split("›")] if re.fullmatch(r"[^›]{1,20}(›[^›]{1,20})?", sub) else []
        sub = " › ".join(x for x in (pl.country(parts[0]), pl.city(parts[1]) if len(parts) > 1 else "") if x) if parts else ""
    elif sub not in taxonomy.subs(tax, cat or ""):
        sub = ""
    s["subcategory"] = sub

    t = raw.get("tags") if isinstance(raw.get("tags"), dict) else {}
    s["tags"] = {
        "place_types": [x for x in (t.get("place_types") or []) if x in taxonomy.PLACE_TYPES][:6] if isinstance(t.get("place_types"), list) else [],
        "seasons": [x for x in (t.get("seasons") or []) if x in taxonomy.SEASONS][:3] if isinstance(t.get("seasons"), list) else [],
        "budget": t.get("budget") if t.get("budget") in taxonomy.BUDGETS else "",
        "scenarios": _str_list(t.get("scenarios"), 0, 5, 2, 20) or [],
        "topics": _str_list(t.get("topics"), 0, 6, 2, 20) or [],
    }

    st = lambda d, k, n: d.get(k).strip()[:n] if isinstance(d.get(k), str) else ""  # noqa: E731
    places = []
    for p in raw.get("places") or [] if isinstance(raw.get("places"), list) else []:
        if not isinstance(p, dict) or not _str(p.get("name"), 1, 60):
            continue
        places.append({
            "name": p["name"].strip(),
            "type": p.get("type") if p.get("type") in taxonomy.PLACE_TYPES else "景點",
            "country": pl.country(st(p, "country", 20)),
            # Older prompts wrote the city as "area".
            "city": pl.city(st(p, "city", 30) or st(p, "area", 30)),
            "district": st(p, "district", 30),
            "address": st(p, "address", 120),
        })
    s["places"] = places[:30]
    locs = []
    for loc in raw.get("locations") or [] if isinstance(raw.get("locations"), list) else []:
        if isinstance(loc, dict):
            key = pl.location_key(st(loc, "country", 20), st(loc, "city", 30))
            if key[0] and list(key) not in locs:
                locs.append(list(key))
    s["locations"] = locs[:5]
    s["actions"] = _str_list(raw.get("actions"), 0, 5, 4, 120) or []
    s["nature"] = raw.get("nature") if raw.get("nature") in NATURE else "無法判斷"
    s["sponsored"] = raw.get("sponsored") if raw.get("sponsored") in SPONSORED else "未見業配"
    s["lang"] = raw.get("lang") if raw.get("lang") in LANGS else "other"
    s["image_text"] = raw.get("image_text").strip()[:1500] if isinstance(raw.get("image_text"), str) else ""
    ex = raw.get("extra") if isinstance(raw.get("extra"), dict) else {}
    s["extra"] = {k: v.strip()[:200] for k, v in ex.items() if k in EXTRA_KEYS and _str(v, 1, 400)}
    return s, errs


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("summary", type=Path)
    ap.add_argument("text", type=Path)
    ap.add_argument("--taxonomy", type=Path)
    a = ap.parse_args(argv)
    try:
        raw = json.loads(a.summary.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"summary.json unreadable: {e}")
        return 1
    text = a.text.read_text(encoding="utf-8") if a.text.is_file() else ""
    _, errs = check(raw, text, taxonomy.load(a.taxonomy))
    for e in errs:
        print(e)
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
