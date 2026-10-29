"""Shared helpers: URL clean-up, platform detection, small text checks."""
from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Query keys that only track where a link was shared from; dropping them makes the same
# article collapse to one canonical URL (used for duplicate detection).
TRACKING_KEYS = {
    "fbclid", "gclid", "dclid", "msclkid", "igsh", "igshid", "si", "xmt", "slof", "mibextid",
    "srtk", "vrfl", "ref_src", "ref_url", "_hsenc", "_hsmi", "mc_cid", "mc_eid", "spm",
    "share_id", "rdid", "rdt", "t_source",
}
TRACKING_PREFIXES = ("utm_", "pk_", "ga_")

PLATFORMS = ("threads", "instagram", "facebook", "youtube", "medium", "web")

_CJK = re.compile(r"[㐀-鿿豈-﫿]")


def has_chinese(s: str) -> bool:
    return bool(_CJK.search(s or ""))


def platform_of(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if re.search(r"(^|\.)threads\.(com|net)$", host):
        return "threads"
    if re.search(r"(^|\.)instagram\.com$", host):
        return "instagram"
    if re.search(r"(^|\.)(facebook\.com|fb\.watch|fb\.com)$", host):
        return "facebook"
    if re.search(r"(^|\.)youtube\.com$|^youtu\.be$", host):
        return "youtube"
    if re.search(r"(^|\.)medium\.com$", host):
        return "medium"
    return "web"


YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_id(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = [p for p in parts.path.split("/") if p]
    cand = None
    if host == "youtu.be" and path:
        cand = path[0]
    elif host.endswith("youtube.com"):
        if path[:1] == ["watch"]:
            cand = dict(parse_qsl(parts.query)).get("v")
        elif len(path) >= 2 and path[0] in ("shorts", "live", "embed", "v"):
            cand = path[1]
    return cand if cand and YT_ID.match(cand) else None


def canonical_url(url: str) -> str:
    """Normalize a shared link: https, lower-case host, no fragment, no tracking keys."""
    url = url.strip()
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host.startswith("m.") and host.endswith(("facebook.com", "youtube.com")):
        host = "www." + host[2:]
    if host in ("threads.net", "www.threads.net", "threads.com"):
        host = "www.threads.com"
    if host == "instagram.com":
        host = "www.instagram.com"
    if host == "youtube.com":
        host = "www.youtube.com"
    vid = youtube_id(url)
    if vid:
        kind = "shorts/" if "/shorts/" in parts.path else ""
        return f"https://www.youtube.com/shorts/{vid}" if kind else f"https://www.youtube.com/watch?v={vid}"
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in TRACKING_KEYS and not k.lower().startswith(TRACKING_PREFIXES)]
    path = parts.path or "/"
    if host.endswith("instagram.com") and not path.endswith("/"):
        path += "/"
    return urlunsplit(("https", host, path, urlencode(query), ""))


def clip(s: str | None, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"
