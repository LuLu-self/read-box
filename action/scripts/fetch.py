"""Fetch one shared link and write what could be read, without any AI.

CLI: fetch.py (--url URL | --capture inbox/ID.json) --out DIR
  writes DIR/content.json (metadata + fetch status), DIR/text.txt (body text) and DIR/img/*.jpg.
YOUTUBE_API_KEY (env, optional) adds description, chapters, date and duration for YouTube.

Only the page LuLu shared is requested. No login, no headless browser, no bypassing login
walls: when a platform hides the content, the result says so and the card keeps the link.
Everything fetched is untrusted data.
"""
from __future__ import annotations

import argparse
import html as htmllib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import canonical_url, platform_of, youtube_id  # noqa: E402

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
MAX_BYTES = 6_000_000
MAX_IMAGES = 6
IMAGE_MAX_SIDE = 1600
TEXT_MAX = 60_000
TIMEOUT = 30


# ---------------------------------------------------------------- HTTP

class FetchError(Exception):
    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def http_get(url: str, accept: str = "text/html,application/xhtml+xml,*/*;q=0.8",
             lang: str = "zh-TW,zh;q=0.9,en;q=0.8") -> tuple[str, dict, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": lang})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise FetchError("頁面太大（超過 6 MB）")
            return r.geturl(), {k.lower(): v for k, v in r.headers.items()}, body
    except urllib.error.HTTPError as e:
        raise FetchError(f"網站回應 HTTP {e.code}", e.code) from None
    except urllib.error.URLError as e:
        raise FetchError(f"連不到網站（{e.reason}）") from None
    except TimeoutError:
        raise FetchError("網站太久沒回應") from None


def decode(body: bytes, headers: dict) -> str:
    m = re.search(r"charset=([\w-]+)", headers.get("content-type", ""), re.I)
    for enc in ([m.group(1)] if m else []) + ["utf-8", "big5", "gb18030"]:
        try:
            return body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


# ---------------------------------------------------------------- HTML helpers

class PageMeta(HTMLParser):
    """Collects <meta>, <title>, canonical link and JSON-LD blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self.canonical = ""
        self.jsonld: list[str] = []
        self._in_title = False
        self._in_ld = False
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a:
                # Keep the longest value: Meta pages repeat og tags, and the longer copy is the untruncated one.
                if len(a["content"]) > len(self.meta.get(key, "")):
                    self.meta[key] = a["content"]
        elif tag == "title":
            self._in_title, self._buf = True, []
        elif tag == "link" and a.get("rel", "").lower() == "canonical":
            self.canonical = a.get("href", "")
        elif tag == "script" and a.get("type", "").lower() == "application/ld+json":
            self._in_ld, self._buf = True, []

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self.title, self._in_title = "".join(self._buf).strip(), False
        elif tag == "script" and self._in_ld:
            self.jsonld.append("".join(self._buf))
            self._in_ld = False

    def handle_data(self, data):
        if self._in_title or self._in_ld:
            self._buf.append(data)


def page_meta(html: str) -> PageMeta:
    p = PageMeta()
    p.feed(html)
    return p


VOID = {"img", "source", "br", "meta", "link", "input", "hr", "wbr", "area", "base", "col", "embed", "track"}


class ThreadsEmbed(HTMLParser):
    """Reads the public /embed page of one Threads post (class names seen 2026-10)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[set[str]] = []
        self.text: list[str] = []
        self.topic: list[str] = []
        self.handle: list[str] = []
        self.timestamp: list[str] = []
        self.images: list[str] = []
        self.has_video = False

    def _inside(self, cls: str) -> bool:
        return any(cls in s for s in self.stack)

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        classes = set(a.get("class", "").split())
        if tag in VOID:
            if tag == "img" and self._inside("SingleInnerMediaContainer") and a.get("src"):
                self.images.append(a["src"])
            if tag == "img" and any(self._inside(c) for c in ("MediaScrollImageContainer", "CarouselMediaContainer")) and a.get("src"):
                self.images.append(a["src"])
            if tag == "source":
                self.has_video = True
            if tag == "br" and self._inside("BodyTextContainer"):
                self.text.append("\n")
            return
        if "SingleInnerMediaContainerVideo" in classes:
            self.has_video = True
        self.stack.append(classes)

    def handle_startendtag(self, tag, attrs):
        if tag in VOID:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag not in VOID and self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self._inside("BodyTextContainer"):
            self.text.append(data)
        elif self._inside("TopicTagWrapper"):
            self.topic.append(data)
        elif self._inside("AuthorIdentity"):
            self.handle.append(data)
        elif self._inside("Timestamp"):
            self.timestamp.append(data)


def parse_threads_embed(html: str) -> dict:
    p = ThreadsEmbed()
    p.feed(html)
    return {
        "text": "".join(p.text).strip(),
        "topic": "".join(p.topic).strip(),
        "handle": "".join(p.handle).strip(),
        "timestamp": " ".join("".join(p.timestamp).split()),
        "images": list(dict.fromkeys(p.images)),
        "has_video": p.has_video,
    }


MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def english_date(s: str) -> str | None:
    """'Oct 28, 2026' / 'October 26, 2026' / '2026年10月28日' -> '2026-10-28'."""
    z = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", s or "")
    if z:
        return f"{int(z.group(1)):04d}-{int(z.group(2)):02d}-{int(z.group(3)):02d}"
    m = re.search(r"\b([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})\b", s or "")
    if not m or m.group(1)[:3].lower() not in MONTHS:
        return None
    return f"{int(m.group(3)):04d}-{MONTHS[m.group(1)[:3].lower()]:02d}-{int(m.group(2)):02d}"


def iso_date(s: str | None) -> str | None:
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s.strip())
    if m:
        return m.group(0)
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(s).date().isoformat()
    except (TypeError, ValueError):
        return english_date(s)


MAP_LINK = re.compile(r"https?://(?:maps\.app\.goo\.gl/[\w-]+|goo\.gl/maps/[\w-]+|(?:www\.)?google\.[a-z.]+/maps/[^\s\"'<>]+)")


def map_links(text: str) -> list[str]:
    return list(dict.fromkeys(MAP_LINK.findall(text or "")))[:20]


def unescape(s: str | None) -> str:
    return htmllib.unescape(s or "").strip()


# ---------------------------------------------------------------- result

def new_result(url: str) -> dict:
    return {
        "url": url, "final_url": url, "canonical_url": canonical_url(url), "platform": platform_of(url),
        "kind": "article", "status": "failed", "basis": "無", "reason": None, "via": None,
        "title": "", "author": "", "handle": "", "site_name": "", "published_at": None,
        "published_raw": "", "description": "", "topic": "", "duration": None, "chapters": [],
        "image_urls": [], "images": [], "has_video": False, "text": "", "map_links": [],
    }


# ---------------------------------------------------------------- platforms

def fetch_threads(r: dict) -> None:
    final, headers, body = http_get(r["url"])
    r["final_url"], r["canonical_url"] = final, canonical_url(final)
    page = decode(body, headers)
    meta = page_meta(page).meta
    m = re.match(r"^(?:Threads 上的\s*)?(.*?)[（(]@([\w.]+)[)）]", unescape(meta.get("og:title")))
    if m:
        r["author"], r["handle"] = m.group(1).strip(), m.group(2)
    r["site_name"] = "Threads"
    og_text = unescape(meta.get("og:description"))
    post = re.search(r"(/@[\w.]+/post/[\w-]+)", urlsplit(final).path)
    emb = {}
    if post:
        try:
            # English keeps the timestamp in one parseable format ("1:09 AM · Oct 28, 2026").
            _, eh, eb = http_get("https://www.threads.com" + post.group(1) + "/embed", lang="en-US,en;q=0.9")
            emb = parse_threads_embed(decode(eb, eh))
        except FetchError:
            emb = {}
    text = emb.get("text") or og_text
    r["text"] = text
    r["handle"] = r["handle"] or emb.get("handle", "")
    r["topic"] = emb.get("topic", "")
    r["published_raw"] = emb.get("timestamp", "")
    r["published_at"] = english_date(r["published_raw"])
    r["has_video"] = bool(emb.get("has_video"))
    imgs = emb.get("images") or []
    if not imgs and meta.get("twitter:card") == "summary_large_image" and meta.get("og:image"):
        imgs = [unescape(meta["og:image"])]
    r["image_urls"] = imgs
    r["kind"] = "social"
    r["via"] = "threads-embed" if emb else "threads-og"
    if text or imgs:
        r["status"], r["basis"] = "full", "貼文文字"
    else:
        r["reason"] = "Threads 頁面沒有可讀的文字"


def fetch_instagram(r: dict) -> None:
    final, headers, body = http_get(r["url"])
    r["final_url"], r["canonical_url"] = final, canonical_url(final)
    meta = page_meta(decode(body, headers)).meta
    r["site_name"], r["kind"], r["via"] = "Instagram", "social", "instagram-og"
    title = unescape(meta.get("og:title"))
    desc = unescape(meta.get("og:description"))
    if not title and not desc:
        r["reason"] = "Instagram 要求登入才能看（不繞過登入）"
        return
    path = urlsplit(unescape(meta.get("og:url")) or final).path.strip("/").split("/")
    if len(path) >= 2 and path[1] in ("p", "reel", "tv"):
        r["handle"] = path[0]
    m = re.match(r'^(.*?)(?:在 Instagram| on Instagram)\s*[:：]\s*["“](.*)["”]\s*$', title, re.S)
    caption = ""
    if m:
        r["author"], caption = m.group(1).strip(), m.group(2).strip()
    m2 = re.search(r'(?:於|on)\s+([A-Z][a-z]+ \d{1,2}, \d{4})\s*[:：]\s*["“](.*)["”]\s*\.?\s*$', desc, re.S)
    if m2:
        r["published_at"], r["published_raw"] = english_date(m2.group(1)), m2.group(1)
        if len(m2.group(2)) > len(caption):
            caption = m2.group(2).strip()
    r["text"] = caption or desc
    r["is_reel"] = "/reel/" in final
    r["has_video"] = r["is_reel"] or meta.get("og:type", "").startswith("video")
    if meta.get("og:image"):
        r["image_urls"] = [unescape(meta["og:image"])]
    r["status"] = "full" if r["text"] else "preview"
    r["basis"] = "說明文字" if r["has_video"] else "貼文文字"


def fetch_facebook(r: dict) -> None:
    final, headers, body = http_get(r["url"])
    r["final_url"] = final
    meta = page_meta(decode(body, headers)).meta
    r["site_name"], r["kind"], r["via"] = "Facebook", "social", "facebook-og"
    og_url = unescape(meta.get("og:url"))
    r["canonical_url"] = canonical_url(og_url or final)
    title = unescape(meta.get("og:title"))
    text = max((unescape(meta.get(k)) for k in ("og:description", "twitter:description", "description")), key=len)
    if not title and not text:
        r["reason"] = "Facebook 要求登入才能看（不繞過登入）"
        return
    author = title
    if text and " - " in title and title.split(" - ", 1)[1][:20] in text:
        author = title.split(" - ", 1)[0]
    r["author"] = author.strip()
    r["text"] = text.replace("�", " ")
    r["has_video"] = meta.get("og:type", "").startswith("video") or "/reel" in final or "/videos/" in final
    if meta.get("og:image"):
        r["image_urls"] = [unescape(meta["og:image"])]
    r["status"] = "full" if r["text"] else "preview"
    r["basis"] = "說明文字" if r["has_video"] else "貼文文字"


CHAPTER = re.compile(r"^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—|:：]?\s*(.+?)\s*$")


def chapters(desc: str) -> list[dict]:
    out = []
    for line in (desc or "").splitlines():
        m = CHAPTER.match(line)
        if m:
            sec = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
            out.append({"t": sec, "label": m.group(4)[:80]})
    # YouTube only treats a list as chapters when it starts at 0:00 and has at least three entries.
    return out if len(out) >= 3 and out[0]["t"] == 0 else []


def iso_duration(s: str | None) -> int | None:
    m = re.match(r"^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", s or "")
    if not m:
        return None
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def fetch_youtube(r: dict) -> None:
    vid = youtube_id(r["url"])
    if not vid:
        r["reason"] = "看不出是哪一支 YouTube 影片"
        return
    r["canonical_url"] = canonical_url(r["url"])
    r["kind"], r["site_name"], r["has_video"] = "video", "YouTube", True
    r["is_short"] = "/shorts/" in r["canonical_url"]
    key = os.environ.get("YOUTUBE_API_KEY", "")
    if key:
        try:
            _, h, b = http_get("https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id="
                               + vid + "&key=" + quote(key), accept="application/json")
            items = json.loads(b).get("items") or []
        except (FetchError, ValueError) as e:
            items = []
            r["reason"] = "YouTube API：" + str(getattr(e, "reason", e)).replace(key, "***")
        if items:
            sn, cd = items[0].get("snippet") or {}, items[0].get("contentDetails") or {}
            r.update(title=sn.get("title", ""), author=sn.get("channelTitle", ""), via="youtube-api",
                     published_at=iso_date(sn.get("publishedAt")), published_raw=sn.get("publishedAt", ""),
                     description=sn.get("description", ""), duration=iso_duration(cd.get("duration")))
            r["text"] = r["description"]
            r["chapters"] = chapters(r["description"])
            thumbs = sn.get("thumbnails") or {}
            best = next((thumbs[k]["url"] for k in ("maxres", "standard", "high", "medium") if k in thumbs), None)
            r["image_urls"] = [best] if best else []
            r["status"] = "full" if r["text"] else "preview"
            r["basis"] = "說明文字" if r["text"] else "標題與簡介"
            r["reason"] = None
            return
    _, h, b = http_get("https://www.youtube.com/oembed?format=json&url="
                       + quote("https://www.youtube.com/watch?v=" + vid, safe=""), accept="application/json")
    o = json.loads(b)
    r.update(title=o.get("title", ""), author=o.get("author_name", ""), via="youtube-oembed",
             status="preview", basis="標題與簡介")
    if o.get("thumbnail_url"):
        r["image_urls"] = [o["thumbnail_url"]]
    r["reason"] = r["reason"] or "只有標題（沒有 YouTube API 金鑰）"


def _ld_paywalled(blocks: list[str]) -> bool:
    for raw in blocks:
        if re.search(r'"isAccessibleForFree"\s*:\s*(false|"false"|"False")', raw):
            return True
    return False


def fetch_medium_rss(r: dict) -> bool:
    """Medium blocks Actions on article pages; its official author/publication feed may carry the post."""
    parts = urlsplit(r["url"])
    seg = [p for p in parts.path.split("/") if p]
    pid = re.search(r"-([0-9a-f]{8,12})$", seg[-1]) if seg else None
    host = (parts.hostname or "").lower()
    if not seg or not pid:
        return False
    feed = (f"https://medium.com/feed/{seg[0]}" if host in ("medium.com", "www.medium.com")
            else f"https://{host}/feed")
    try:
        _, h, b = http_get(feed, accept="application/rss+xml,application/xml")
        items = ET.fromstring(b).findall("./channel/item")
    except (FetchError, ET.ParseError):
        return False
    for it in items:
        if pid.group(1) in (it.findtext("link") or "") + (it.findtext("guid") or ""):
            body = it.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or ""
            import trafilatura
            text = trafilatura.extract("<html><body>" + body + "</body></html>") or ""
            img = re.search(r'<img[^>]+src="([^"]+)"', body)
            r.update(title=unescape(it.findtext("title")), author=it.findtext("{http://purl.org/dc/elements/1.1/}creator") or "",
                     published_at=iso_date(it.findtext("pubDate")), published_raw=it.findtext("pubDate") or "",
                     text=text, site_name="Medium", via="medium-rss", status="full" if text else "preview",
                     basis="全文" if text else "標題與簡介", reason=None)
            if img:
                r["image_urls"] = [img.group(1)]
            return True
    return False


def fetch_pdf(r: dict, body: bytes) -> None:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(body))
    text = "\n".join((pg.extract_text() or "") for pg in reader.pages[:80])
    info = reader.metadata or {}
    r.update(kind="pdf", via="pdf", text=text, title=str(info.get("/Title") or "") or Path(urlsplit(r["final_url"]).path).name,
             author=str(info.get("/Author") or ""))
    r["status"], r["basis"] = ("full", "全文") if text.strip() else ("preview", "標題與簡介")
    if not text.strip():
        r["reason"] = "PDF 沒有可擷取的文字（可能是掃描圖片）"


def fetch_web(r: dict) -> None:
    try:
        final, headers, body = http_get(r["url"])
    except FetchError as e:
        if r["platform"] == "medium" and fetch_medium_rss(r):
            return
        raise e
    r["final_url"] = final
    if "pdf" in headers.get("content-type", "") or body[:5] == b"%PDF-":
        r["canonical_url"] = canonical_url(final)
        fetch_pdf(r, body)
        return
    page = decode(body, headers)
    pm = page_meta(page)
    r["canonical_url"] = canonical_url(pm.canonical or final) if pm.canonical.startswith("http") else canonical_url(final)
    import trafilatura
    doc = trafilatura.bare_extraction(page, url=final, with_metadata=True, favor_recall=True)
    d = doc.as_dict() if hasattr(doc, "as_dict") else (doc or {})
    text = (d.get("text") or "").strip()
    meta = pm.meta
    r.update(via="trafilatura",
             title=d.get("title") or unescape(meta.get("og:title")) or pm.title,
             author=d.get("author") or "", site_name=d.get("sitename") or unescape(meta.get("og:site_name")) or (urlsplit(final).hostname or ""),
             published_at=iso_date(d.get("date")), published_raw=d.get("date") or "",
             description=d.get("description") or unescape(meta.get("og:description") or meta.get("description")))
    img = d.get("image") or unescape(meta.get("og:image"))
    if img and img.startswith("http"):
        r["image_urls"] = [img]
    paywall = _ld_paywalled(pm.jsonld) or len(re.findall(r"paywall", page, re.I)) >= 3
    r["text"] = text
    if len(text) < 300 and not r["published_at"] and not paywall:
        r["kind"], r["status"], r["basis"] = "bookmark", "preview", "標題與簡介"
        if text:
            r["text"] = text
    elif paywall:
        r["status"], r["basis"], r["reason"] = "partial", "試閱段", "付費或會員內容，只抓到試閱段"
    else:
        r["status"], r["basis"] = ("full", "全文") if text else ("preview", "標題與簡介")


# ---------------------------------------------------------------- images

def download_images(urls: list[str], dest: Path) -> list[str]:
    from PIL import Image
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for u in urls[:MAX_IMAGES]:
        if not u.startswith("https://"):
            continue
        try:
            _, _, b = http_get(u, accept="image/avif,image/webp,image/jpeg,image/png,*/*")
            im = Image.open(io.BytesIO(b))
            im.load()
            im = im.convert("RGB")
            im.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
            name = f"{len(saved) + 1}.jpg"
            im.save(dest / name, "JPEG", quality=80, optimize=True)
            saved.append(name)
        except Exception:  # one broken image must not lose the whole item
            continue
    return saved


# ---------------------------------------------------------------- main

FETCHERS = {"threads": fetch_threads, "instagram": fetch_instagram, "facebook": fetch_facebook,
            "youtube": fetch_youtube, "medium": fetch_web, "web": fetch_web}


def fetch(url: str, out: Path, pasted: str = "") -> dict:
    r = new_result(url)
    if not url and pasted.strip():
        r.update(platform="note", kind="note", canonical_url="", site_name="我的筆記")
    elif not re.match(r"^https?://", url or ""):
        r["reason"] = "不是網址"
    else:
        try:
            FETCHERS[r["platform"]](r)
        except FetchError as e:
            r["status"], r["reason"] = "failed", e.reason
        except Exception as e:  # parsers meet arbitrary pages; record and keep the card
            r["status"], r["reason"] = "failed", f"讀取時出錯（{type(e).__name__}）"
    # Text LuLu pasted (paywalled article, a note) wins when it is longer than what was fetched.
    if pasted.strip() and len(pasted.strip()) > len((r.get("text") or "").strip()):
        r.update(text=pasted.strip(), status="full", basis="貼上的文字", reason=None)
    r["text"] = (r.get("text") or "")[:TEXT_MAX]
    r["map_links"] = map_links(r["text"] + "\n" + r.get("description", ""))
    out.mkdir(parents=True, exist_ok=True)
    r["images"] = download_images(r["image_urls"], out / "img") if r["image_urls"] else []
    (out / "text.txt").write_text(r["text"], encoding="utf-8")
    r["text_chars"] = len(r.pop("text"))
    r["fetched_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    (out / "content.json").write_text(json.dumps(r, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return r


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="")
    ap.add_argument("--capture", type=Path, help="inbox capture JSON; supplies url and pasted text")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    url, pasted = a.url, ""
    if a.capture:
        cap = json.loads(a.capture.read_text(encoding="utf-8"))
        url, pasted = url or cap.get("url") or "", cap.get("text") or ""
    r = fetch(url, a.out, pasted)
    print(json.dumps({k: r[k] for k in ("platform", "kind", "status", "basis", "reason", "via", "text_chars")},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
