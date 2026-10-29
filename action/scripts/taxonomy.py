"""Categories and fixed tag lists. The library's taxonomy.json (edited from the board) wins
over the defaults below; 收件匣 always exists."""
from __future__ import annotations

import json
from pathlib import Path

INBOX = "收件匣"

DEFAULT = {
    "v": 1,
    "categories": [
        {"name": "旅遊", "subs": []},
        {"name": "美食", "subs": ["餐廳店家", "小吃", "咖啡甜點", "食譜"]},
        {"name": "運動", "subs": ["跑步", "健身", "其他運動"]},
        {"name": "健康", "subs": ["飲食營養", "睡眠", "醫療保健"]},
        {"name": "語言", "subs": ["英文", "日文", "韓文", "其他語言"]},
        {"name": "生活", "subs": ["居家", "好物購物", "生活技巧"]},
        {"name": "工作", "subs": []},
        {"name": "學習成長", "subs": []},
        {"name": "心理", "subs": []},
        {"name": "人際關係", "subs": []},
        {"name": "理財", "subs": []},
        {"name": "科技與 AI", "subs": []},
        {"name": INBOX, "subs": []},
    ],
}

PLACE_TYPES = ["餐廳", "小吃", "咖啡甜點", "酒吧", "景點", "住宿", "交通", "購物", "運動", "活動體驗"]
SEASONS = ["春", "夏", "秋", "冬", "櫻花", "紅葉", "雪"]
BUDGETS = ["", "$", "$$", "$$$"]
# 旅遊 sub-categories are free-form "國家" or "國家 › 地區", filled in by the AI.
FREE_SUBS = {"旅遊"}


def load(path: Path | None) -> dict:
    data = DEFAULT
    if path and path.is_file():
        try:
            cand = json.loads(path.read_text(encoding="utf-8"))
            cats = cand.get("categories")
            if isinstance(cats, list) and all(isinstance(c, dict) and isinstance(c.get("name"), str) for c in cats):
                data = {"v": 1, "categories": [{"name": c["name"].strip()[:20],
                                               "subs": [s.strip()[:20] for s in c.get("subs") or [] if isinstance(s, str) and s.strip()]}
                                              for c in cats if c["name"].strip()]}
        except ValueError:
            data = DEFAULT
    if not any(c["name"] == INBOX for c in data["categories"]):
        data = {"v": 1, "categories": data["categories"] + [{"name": INBOX, "subs": []}]}
    return data


def names(tax: dict) -> list[str]:
    return [c["name"] for c in tax["categories"]]


def subs(tax: dict, name: str) -> list[str]:
    return next((c["subs"] for c in tax["categories"] if c["name"] == name), [])


def render(tax: dict) -> str:
    lines = []
    for c in tax["categories"]:
        if c["name"] in FREE_SUBS:
            lines.append(f"- {c['name']}: 國家 › 地區（自由填寫）")
        else:
            lines.append(f"- {c['name']}: {'、'.join(c['subs']) if c['subs'] else '（無）'}")
    return "\n".join(lines)
