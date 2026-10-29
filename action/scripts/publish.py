"""Write analyzed items into the library repo and rebuild index.json. Never runs AI.

CLI: publish.py --artifacts DIR --repo DIR --items items.json [--push]
Each artifact dir (rb-<id>/) holds status.json, content.json, text.txt, img/*.jpg and maybe
summary.json. Everything in it is re-checked here: this is the only step with write access.

Library layout:
  library/<id>.json   one entry (metadata + AI summary)
  library/<id>.txt    body text
  media/<id>/N.jpg    images
  index.json          light list for the board
  inbox/done|failed/  processed captures
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import places as pl  # noqa: E402
import taxonomy  # noqa: E402
import validate  # noqa: E402
from common import clip  # noqa: E402

PLATFORM_LABEL = {"threads": "Threads", "instagram": "Instagram", "facebook": "Facebook",
                  "youtube": "YouTube", "medium": "Medium", "web": "網站", "note": "我的筆記"}
STATUSES = {"full", "partial", "preview", "failed"}
BASES = {"全文", "貼文文字", "說明文字", "試閱段", "標題與簡介", "貼上的文字", "無"}
KINDS = {"social", "video", "article", "bookmark", "pdf", "note"}
CAREFUL = {"健康": "健康資訊僅供參考，數字與建議請和醫師或專業人員確認。",
           "理財": "理財資訊僅供參考，數字與建議請和專業人員確認。"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
SKIP_REASON = "讀不到內容，也沒有任何標題資訊，所以沒有收進來"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def map_url(place: dict) -> str:
    where = place.get("address") or " ".join(x for x in (place.get("district", ""), place.get("city") or place.get("area", "")) if x)
    q = " ".join(x for x in (place["name"], where, place.get("country", "")) if x)
    return "https://www.google.com/maps/search/?api=1&query=" + quote(q)


def reading_minutes(text: str) -> int:
    cjk = len(re.findall(r"[぀-ヿ㐀-鿿가-힯]", text))
    words = len(re.findall(r"[A-Za-z0-9']+", text))
    return max(1, math.ceil(cjk / 500 + words / 220)) if text.strip() else 0


def clean_content(c: dict) -> dict:
    """content.json came out of the job that also ran Claude: keep only typed, bounded fields."""
    g = lambda k, n=300: clip(c.get(k) if isinstance(c.get(k), str) else "", n)  # noqa: E731
    chapters = []
    for ch in c.get("chapters") or [] if isinstance(c.get("chapters"), list) else []:
        if isinstance(ch, dict) and isinstance(ch.get("t"), int) and isinstance(ch.get("label"), str):
            chapters.append({"t": max(0, ch["t"]), "label": clip(ch["label"], 80)})
    return {
        "url": g("url", 2000), "canonical_url": g("canonical_url", 2000),
        "platform": c.get("platform") if c.get("platform") in PLATFORM_LABEL else "web",
        "kind": c.get("kind") if c.get("kind") in KINDS else "article",
        "status": c.get("status") if c.get("status") in STATUSES else "failed",
        "basis": c.get("basis") if c.get("basis") in BASES else "無",
        "reason": g("reason", 200) or None, "via": g("via", 40),
        "title": g("title", 200), "author": g("author", 100), "handle": g("handle", 60),
        "site_name": g("site_name", 80), "topic": g("topic", 40),
        "published_at": c.get("published_at") if isinstance(c.get("published_at"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", c["published_at"]) else None,
        "description": g("description", 600),
        "duration": c.get("duration") if isinstance(c.get("duration"), int) else None,
        "chapters": chapters[:60], "has_video": bool(c.get("has_video")),
        "map_links": [u for u in (c.get("map_links") or []) if isinstance(u, str) and u.startswith("https://")][:20],
        "fetched_at": g("fetched_at", 40),
        "host": g("host", 120).lower() if re.fullmatch(r"[A-Za-z0-9.-]{1,120}", c.get("host") or "") else "",
    }


def copy_images(src: Path, dest: Path) -> list[str]:
    from PIL import Image
    out = []
    for p in sorted(src.glob("*.jpg"))[:6]:
        try:
            with Image.open(p) as im:
                im.verify()
            if p.stat().st_size > 3_000_000:
                continue
        except Exception:
            continue
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest / p.name)
        out.append(p.name)
    return out


def copy_favicon(art: Path, repo: Path, host: str) -> str | None:
    """One icon per website, shared by every item from that site."""
    from PIL import Image
    src = art / "favicon.png"
    if not host:
        return None
    dest = repo / "media" / "favicons" / f"{host}.png"
    if dest.is_file():
        return dest.relative_to(repo).as_posix()
    if not src.is_file() or src.stat().st_size > 50_000:
        return None
    try:
        with Image.open(src) as im:
            im.verify()
    except Exception:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    return dest.relative_to(repo).as_posix()


def locations_of(e: dict) -> list[list[str]]:
    """Every [country, city] an entry is about: AI locations, venue places and a 旅遊 sub-category."""
    out: list[list[str]] = []

    def add(country: str, city: str) -> None:
        key = list(pl.location_key(country, city))
        if key[0] and key not in out:
            out.append(key)
    for c, ci in (e.get("ai") or {}).get("locations") or []:
        add(c, ci)
    for p in e.get("places") or []:
        add(p.get("country", ""), p.get("city") or p.get("area", ""))
    if e.get("category") == "旅遊" and e.get("subcategory"):
        parts = [x.strip() for x in e["subcategory"].split("›")]
        add(parts[0], parts[1] if len(parts) > 1 else "")
    # A bare country is redundant once one of its cities is listed.
    return [k for k in out if k[1] or not any(o[0] == k[0] and o[1] for o in out)][:10]


def fallback_title(c: dict, text: str) -> str:
    if c["title"]:
        return clip(c["title"], 60)
    first = next((ln.strip() for ln in text.splitlines()
                  if re.search(r"[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", ln)), "")
    if first:
        return clip(first, 40)
    who = c["author"] or c["handle"]
    return f"{PLATFORM_LABEL[c['platform']]}{' · ' + who if who else ''} 的貼文"


def build_entry(item_id: str, cap: dict, c: dict, text: str, summary: dict | None, ai_error: str | None,
                images: list[str]) -> dict:
    places = []
    for p in (summary or {}).get("places", []):
        places.append({**p, "map_url": map_url(p), "map_guess": True})
    cat = (summary or {}).get("category") or taxonomy.INBOX
    entry = {
        "v": 1, "id": item_id,
        "url": c["url"] or cap.get("url") or "", "canonical_url": c["canonical_url"],
        "platform": c["platform"], "platform_label": PLATFORM_LABEL[c["platform"]], "kind": c["kind"],
        "site_name": c["site_name"], "author": c["author"], "handle": c["handle"], "topic": c["topic"],
        "published_at": c["published_at"], "captured_at": cap.get("captured_at"),
        "why": clip(cap.get("why") or "", 200),
        "captures": [{"at": cap.get("captured_at"), "why": clip(cap.get("why") or "", 200)}],
        "fetch": {k: c[k] for k in ("status", "basis", "reason", "via", "fetched_at")} | {"text_chars": len(text)},
        "description": c["description"], "duration": c["duration"], "chapters": c["chapters"],
        "has_video": c["has_video"], "images": [f"media/{item_id}/{n}" for n in images],
        "source_map_links": c["map_links"],
        "title": (summary or {}).get("title") or fallback_title(c, text),
        "category": cat, "subcategory": (summary or {}).get("subcategory", ""),
        "reading_minutes": reading_minutes(text),
        "ai": summary, "ai_error": ai_error,
        "places": places,
        "notice": CAREFUL.get(cat),
        "updated_at": now_iso(),
    }
    if not summary:
        entry["one_line_fallback"] = "無法讀取內容，請點原文連結查看" if c["status"] == "failed" else clip(c["description"] or text, 80)
    return entry


def index_row(e: dict) -> dict:
    ai = e.get("ai") or {}
    tags = ai.get("tags") or {}
    return {
        "id": e["id"], "title": e["title"], "one_line": ai.get("one_line") or e.get("one_line_fallback", ""),
        "category": e["category"], "subcategory": e.get("subcategory", ""),
        "platform": e["platform"], "platform_label": e["platform_label"], "kind": e["kind"],
        "site_name": e["site_name"], "author": e["author"], "handle": e["handle"],
        "captured_at": e["captured_at"], "published_at": e["published_at"],
        "fetch_status": e["fetch"]["status"], "basis": e["fetch"]["basis"],
        "has_video": e["has_video"], "duration": e["duration"], "reading_minutes": e["reading_minutes"],
        "thumb": e["images"][0] if e["images"] else None,
        "why": e.get("why", ""), "url": e["url"], "canonical_url": e["canonical_url"],
        "tags": {k: tags.get(k, [] if k != "budget" else "") for k in ("place_types", "seasons", "budget", "scenarios", "topics")},
        "places": [{"name": p["name"], "type": p["type"], "country": p.get("country", ""),
                    "city": p.get("city") or p.get("area", ""), "district": p.get("district", ""),
                    "map_url": p["map_url"]} for p in e.get("places", [])],
        "locations": locations_of(e), "favicon": e.get("favicon"),
        "sponsored": ai.get("sponsored", ""), "ai_ok": bool(ai),
    }


def rebuild_index(repo: Path) -> dict:
    rows = []
    for p in sorted((repo / "library").glob("*.json")):
        e = load_json(p)
        if isinstance(e, dict) and e.get("id") == p.stem:
            rows.append(index_row(e))
    rows.sort(key=lambda r: (r.get("captured_at") or ""), reverse=True)
    idx = {"v": 1, "updated_at": now_iso(), "count": len(rows), "items": rows}
    (repo / "index.json").write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return idx


def find_duplicate(repo: Path, canonical: str, own_id: str) -> Path | None:
    if not canonical:
        return None
    for p in (repo / "library").glob("*.json"):
        e = load_json(p)
        if isinstance(e, dict) and e.get("canonical_url") == canonical and p.stem != own_id:
            return p
    return None


def move_capture(repo: Path, item_id: str, bucket: str, error: str | None = None) -> None:
    src = repo / "inbox" / f"{item_id}.json"
    if not src.is_file():
        return
    dest = repo / "inbox" / bucket / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if error:
        cap = load_json(src, {}) or {}
        cap["error"] = clip(error, 300)
        cap["failed_at"] = now_iso()
        dest.write_text(json.dumps(cap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        src.unlink()
    else:
        src.replace(dest)


def publish_one(repo: Path, art: Path, item: dict, tax: dict) -> str:
    item_id = item["id"]
    cap = load_json(repo / "inbox" / f"{item_id}.json", {}) or {}
    if item_id.startswith("dispatch-"):
        cap = {"url": item.get("url"), "captured_at": now_iso(), "why": ""}
    status = load_json(art / "status.json", {}) or {}
    if item.get("error") or not (art / "content.json").is_file():
        move_capture(repo, item_id, "failed", item.get("error") or status.get("error") or "pipeline: no fetch output")
        return "failed"
    c = clean_content(load_json(art / "content.json", {}) or {})
    text = (art / "text.txt").read_text(encoding="utf-8", errors="replace") if (art / "text.txt").is_file() else ""

    # LuLu's rule (2026-10-29): nothing readable and not even a title -> do not keep a card;
    # the capture goes to inbox/failed and the board tells her.
    if c["status"] == "failed" and not c["title"]:
        move_capture(repo, item_id, "failed", f"{SKIP_REASON}（{c['reason'] or '讀不到'}）")
        return "skipped"

    # "redo_of": LuLu asked to re-run an existing entry; the result replaces it under the old id.
    redo = cap.get("redo_of") if isinstance(cap.get("redo_of"), str) and ID_RE.match(cap["redo_of"]) else None
    old = load_json(repo / "library" / f"{redo}.json") if redo else None
    dup = None if old else find_duplicate(repo, c["canonical_url"], item_id)
    if dup:
        e = load_json(dup)
        e.setdefault("captures", []).append({"at": cap.get("captured_at"), "why": clip(cap.get("why") or "", 200)})
        if cap.get("why") and not e.get("why"):
            e["why"] = clip(cap["why"], 200)
        e["updated_at"] = now_iso()
        dup.write_text(json.dumps(e, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        move_capture(repo, item_id, "done")
        return "dedup"

    summary, ai_error = None, status.get("error") if status.get("status") == "failed" else None
    raw = load_json(art / "summary.json")
    if raw is not None:
        clean, errs = validate.check(raw, text, tax)
        if errs:
            ai_error = "AI 摘要格式不符：" + "；".join(errs)[:200]
        else:
            summary = clean
    elif not ai_error and c["status"] != "failed":
        ai_error = "沒有 AI 摘要"

    target = redo if old else item_id
    if old:
        shutil.rmtree(repo / "media" / target, ignore_errors=True)
        cap = {**cap, "captured_at": old.get("captured_at"), "why": cap.get("why") or old.get("why", "")}
    images = copy_images(art / "img", repo / "media" / target) if (art / "img").is_dir() else []
    entry = build_entry(target, cap, c, text, summary, ai_error, images)
    if old:
        entry["captures"] = old.get("captures") or entry["captures"]
        entry["redone_at"] = now_iso()
    entry["favicon"] = copy_favicon(art, repo, c["host"]) if c["platform"] in ("web", "medium") else None
    entry["locations"] = locations_of(entry)
    entry["ai_run"] = ai_run_info(art)
    lib = repo / "library"
    lib.mkdir(exist_ok=True)
    (lib / f"{target}.json").write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (lib / f"{target}.txt").write_text(text, encoding="utf-8")
    move_capture(repo, item_id, "done")
    return "ok" if summary else "card"


def ai_run_info(art: Path) -> dict:
    """What happened in the Claude step, so a missing summary can be explained without the run log."""
    cl = load_json(art / "claude.json", {}) or {}
    run = (load_json(art / "run.json", {}) or {}).get("result") or {}
    info = {"ran": bool(cl.get("token_set")), "token_set": cl.get("token_set"), "exit": cl.get("exit"),
            "stderr_tail": clip(cl.get("stderr_tail") if isinstance(cl.get("stderr_tail"), str) else "", 400)}
    shape = cl.get("token_shape")
    if isinstance(shape, dict):
        info["token_shape"] = {k: shape.get(k) for k in ("len", "prefix_ok", "whitespace")}
    if run:
        info.update(is_error=run.get("is_error"), subtype=clip(str(run.get("subtype") or ""), 40),
                    num_turns=run.get("num_turns"), result_text=clip(str(run.get("result_text") or ""), 300))
    return info


def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def push(repo: Path, message: str) -> None:
    git(repo, "add", "-A", "library", "media", "inbox", "index.json")
    if git(repo, "diff", "--cached", "--quiet").returncode == 0:
        return
    git(repo, "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", message)
    for attempt in range(4):
        if git(repo, "push", "-q").returncode == 0:
            return
        time.sleep(2 ** attempt)
        r = git(repo, "pull", "--rebase", "-q")
        if r.returncode != 0:
            git(repo, "rebase", "--abort")
            raise SystemExit(f"push failed: {r.stderr[:300]}")
        rebuild_index(repo)
        git(repo, "add", "index.json")
        if git(repo, "diff", "--cached", "--quiet").returncode != 0:
            git(repo, "-c", "user.name=github-actions[bot]",
                "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", "index: rebuild")
    raise SystemExit("push failed after retries")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", type=Path, required=True)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--items", type=Path, required=True)
    ap.add_argument("--push", action="store_true")
    a = ap.parse_args(argv)
    items = load_json(a.items, []) or []
    tax = taxonomy.load(a.repo / "taxonomy.json")
    counts = {"ok": 0, "card": 0, "dedup": 0, "skipped": 0, "failed": 0}
    failed_ids = []
    for item in items:
        if not isinstance(item, dict) or not ID_RE.match(str(item.get("id", ""))):
            continue
        res = publish_one(a.repo, a.artifacts / f"rb-{item['id']}", item, tax)
        counts[res] += 1
        if res == "failed":
            failed_ids.append(item["id"])
    rebuild_index(a.repo)
    if a.push:
        push(a.repo, f"readbox: {counts['ok']} analyzed, {counts['card']} cards, {counts['dedup']} dup, "
                     f"{counts['skipped']} skipped, {counts['failed']} failed")
    print(json.dumps({**counts, "failed_ids": failed_ids}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
