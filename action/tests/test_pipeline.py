"""Unit tests for the Read Box pipeline. Fixtures are synthetic (no real posts are stored)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import common  # noqa: E402
import fetch  # noqa: E402
import items  # noqa: E402
import places  # noqa: E402
import publish  # noqa: E402
import taxonomy  # noqa: E402
import validate  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


class CommonTest(unittest.TestCase):
    def test_canonical_strips_tracking(self):
        self.assertEqual(common.canonical_url("https://Example.com/a?utm_source=x&id=3&fbclid=y#top"),
                         "https://example.com/a?id=3")

    def test_canonical_threads_and_instagram(self):
        self.assertEqual(common.canonical_url("https://www.threads.net/@a.b/post/XYZ?xmt=1&slof=1"),
                         "https://www.threads.com/@a.b/post/XYZ")
        self.assertEqual(common.canonical_url("https://instagram.com/reel/AbC?igsh=1"),
                         "https://www.instagram.com/reel/AbC/")

    def test_youtube_forms(self):
        for u in ("https://youtu.be/ki5PpBnbE1w?si=x", "https://m.youtube.com/watch?v=ki5PpBnbE1w&t=3",
                  "https://youtube.com/watch?v=ki5PpBnbE1w"):
            self.assertEqual(common.canonical_url(u), "https://www.youtube.com/watch?v=ki5PpBnbE1w")
        self.assertEqual(common.canonical_url("https://www.youtube.com/shorts/ki5PpBnbE1w"),
                         "https://www.youtube.com/shorts/ki5PpBnbE1w")
        self.assertIsNone(common.youtube_id("https://www.youtube.com/@channel"))

    def test_platform(self):
        self.assertEqual(common.platform_of("https://www.threads.com/x"), "threads")
        self.assertEqual(common.platform_of("https://l.facebook.com/x"), "facebook")
        self.assertEqual(common.platform_of("https://uxdesign.medium.com/x"), "medium")
        self.assertEqual(common.platform_of("https://vocus.cc/a"), "web")


class FetchParseTest(unittest.TestCase):
    def test_threads_embed(self):
        r = fetch.parse_threads_embed((FIX / "threads_embed.html").read_text(encoding="utf-8"))
        self.assertEqual(r["text"], "第一行\n第二行 & 符號")
        self.assertEqual(r["topic"], "旅行")
        self.assertEqual(r["handle"], "tester")
        self.assertEqual(fetch.english_date(r["timestamp"]), "2026-10-28")
        self.assertEqual(r["images"], ["https://img.example/1.jpg", "https://img.example/2.jpg"])
        self.assertFalse(r["has_video"])

    def test_dates(self):
        self.assertEqual(fetch.english_date("October 26, 2026"), "2026-10-26")
        self.assertEqual(fetch.english_date("2026年1月5日"), "2026-01-05")
        self.assertEqual(fetch.iso_date("Wed, 15 Oct 2026 12:00:06 GMT"), "2026-10-15")
        self.assertIsNone(fetch.english_date("no date"))

    def test_chapters_and_duration(self):
        desc = "intro\n00:00 開場\n3:25 精緻窮\n1:02:03 結論\n"
        self.assertEqual(fetch.chapters(desc), [{"t": 0, "label": "開場"}, {"t": 205, "label": "精緻窮"},
                                                {"t": 3723, "label": "結論"}])
        self.assertEqual(fetch.chapters("3:25 only one"), [])
        self.assertEqual(fetch.iso_duration("PT1H27M47S"), 5267)

    def test_instagram_og(self):
        page = (FIX / "instagram_reel.html").read_text(encoding="utf-8")
        r = fetch.new_result("https://www.instagram.com/reel/AbC/")
        with mock.patch.object(fetch, "http_get", return_value=("https://www.instagram.com/reel/AbC/", {}, page.encode())):
            fetch.fetch_instagram(r)
        self.assertEqual((r["handle"], r["author"], r["published_at"]), ("tester", "測試者", "2026-10-26"))
        self.assertEqual(r["text"], "大阪必吃章魚燒\n#大阪")
        self.assertEqual((r["status"], r["basis"]), ("full", "說明文字"))

    def test_instagram_login_wall(self):
        r = fetch.new_result("https://www.instagram.com/p/AbC/")
        with mock.patch.object(fetch, "http_get", return_value=("https://www.instagram.com/p/AbC/", {}, b"<title>Instagram</title>")):
            fetch.fetch_instagram(r)
        self.assertEqual(r["status"], "failed")
        self.assertIn("登入", r["reason"])

    def test_web_paywall(self):
        page = (FIX / "paywall.html").read_text(encoding="utf-8")
        r = fetch.new_result("https://news.example/a")
        with mock.patch.object(fetch, "http_get", return_value=("https://news.example/a", {"content-type": "text/html"}, page.encode())):
            fetch.fetch_web(r)
        self.assertEqual((r["status"], r["basis"]), ("partial", "試閱段"))
        self.assertEqual(r["title"], "付費文章標題")

    def test_icon_candidates(self):
        pm = fetch.page_meta('<link rel="icon" href="/f.ico"><link rel="apple-touch-icon" href="/apple.png">')
        self.assertEqual(fetch.icon_candidates(pm, "https://news.example/a/b"),
                         ["https://news.example/apple.png", "https://news.example/f.ico", "https://news.example/favicon.ico"])

    def test_pasted_text_wins(self):
        with tempfile.TemporaryDirectory() as d:
            r = fetch.fetch("", Path(d), pasted="我自己寫的筆記，記下今天學到的事。")
            self.assertEqual((r["platform"], r["status"], r["basis"]), ("note", "full", "貼上的文字"))
            self.assertIn("筆記", (Path(d) / "text.txt").read_text(encoding="utf-8"))


GOOD = {
    "title": "大阪章魚燒推薦", "one_line": "在地人推薦的五家章魚燒", "key_points": ["第三家只開到下午三點"],
    "quotes": ["只開到下午三點", "不存在的句子"], "category": "旅遊", "confidence": "高", "subcategory": "日本 › 大阪",
    "tags": {"place_types": ["小吃", "不明"], "seasons": [], "budget": "$", "scenarios": [], "topics": ["章魚燒"]},
    "places": [{"name": "わなか", "type": "小吃", "country": "Japan", "city": "大阪市", "district": "難波", "address": ""}],
    "locations": [{"country": "日本", "city": "大阪"}, {"country": "日本", "city": "Kyoto"}],
    "actions": [], "nature": "觀點為主", "sponsored": "未見業配", "lang": "zh-TW", "image_text": "", "extra": {"預算": "500 日圓", "亂寫": "x"},
}


class ValidateTest(unittest.TestCase):
    def test_good_summary_is_cleaned(self):
        s, errs = validate.check(GOOD, "第三家  只開到下午三點。", taxonomy.DEFAULT)
        self.assertEqual(errs, [])
        self.assertEqual(s["quotes"], ["只開到下午三點"])
        self.assertEqual(s["tags"]["place_types"], ["小吃"])
        self.assertEqual(s["extra"], {"預算": "500 日圓"})
        self.assertEqual(s["subcategory"], "日本 › 大阪")
        self.assertEqual((s["places"][0]["country"], s["places"][0]["city"]), ("日本", "大阪"))
        self.assertEqual(s["locations"], [["日本", "大阪"], ["日本", "京都"]])

    def test_travel_subcategory_normalized(self):
        s, _ = validate.check(dict(GOOD, subcategory="臺灣 › 臺北市"), "", taxonomy.DEFAULT)
        self.assertEqual(s["subcategory"], "台灣 › 台北")


class PlacesTest(unittest.TestCase):
    def test_city_spellings(self):
        for raw, want in (("大阪市", "大阪"), ("大阪府", "大阪"), ("Osaka", "大阪"), ("京都", "京都"), ("京都府", "京都"),
                          ("東京都", "東京"), ("北海道", "北海道"), ("新北市", "新北"), ("臺北市", "台北")):
            self.assertEqual(places.city(raw), want, raw)
        self.assertEqual(places.country("臺灣"), "台灣")

    def test_bad_category_and_missing_text(self):
        bad = dict(GOOD, category="不存在", one_line="")
        _, errs = validate.check(bad, "", taxonomy.DEFAULT)
        self.assertTrue(any(e.startswith("category") for e in errs))
        self.assertTrue(any(e.startswith("one_line") for e in errs))


class ItemsTest(unittest.TestCase):
    def test_capture_rules(self):
        ok = {"v": 1, "url": "https://a.example/x", "captured_at": "2026-10-29T10:00:00+08:00"}
        self.assertIsNone(items.check_capture(ok))
        self.assertIsNone(items.check_capture({"v": 1, "text": "筆記", "captured_at": "2026-10-29T10:00:00+08:00"}))
        self.assertIn("url", items.check_capture(dict(ok, url="javascript:alert(1)")))
        self.assertIn("needs", items.check_capture({"v": 1, "captured_at": "2026-10-29T10:00:00+08:00"}))
        self.assertIn("redo_of", items.check_capture(dict(ok, redo_of="../x")))


class PublishTest(unittest.TestCase):
    def _art(self, root: Path, item_id: str, content: dict, text: str, summary: dict | None):
        art = root / "art" / f"rb-{item_id}"
        art.mkdir(parents=True)
        (art / "status.json").write_text('{"status": "ok"}', encoding="utf-8")
        (art / "content.json").write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
        (art / "text.txt").write_text(text, encoding="utf-8")
        if summary is not None:
            (art / "summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
        return art

    def test_publish_entry_card_and_dedup(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            repo = root / "repo"
            (repo / "inbox").mkdir(parents=True)
            content = {"url": "https://www.threads.com/@t/post/A", "canonical_url": "https://www.threads.com/@t/post/A",
                       "platform": "threads", "kind": "social", "status": "full", "basis": "貼文文字",
                       "author": "測試", "handle": "t", "published_at": "2026-10-28", "chapters": []}
            for i in ("20261029-100000-aaaa", "20261029-100100-bbbb"):
                (repo / "inbox" / f"{i}.json").write_text(json.dumps(
                    {"v": 1, "url": content["url"], "captured_at": "2026-10-29T10:00:00+08:00", "why": "去大阪用"}), encoding="utf-8")
            a1 = self._art(root, "20261029-100000-aaaa", content, "第三家只開到下午三點", GOOD)
            a2 = self._art(root, "20261029-100100-bbbb", content, "第三家只開到下午三點", GOOD)
            tax = taxonomy.DEFAULT
            self.assertEqual(publish.publish_one(repo, a1, {"id": "20261029-100000-aaaa"}, tax), "ok")
            self.assertEqual(publish.publish_one(repo, a2, {"id": "20261029-100100-bbbb"}, tax), "dedup")
            e = json.loads((repo / "library" / "20261029-100000-aaaa.json").read_text(encoding="utf-8"))
            self.assertEqual(len(e["captures"]), 2)
            self.assertTrue(e["places"][0]["map_url"].startswith("https://www.google.com/maps/search/?api=1&query="))
            self.assertIn("%E9%9B%A3%E6%B3%A2", e["places"][0]["map_url"])  # 難波 is in the map query
            self.assertTrue((repo / "inbox" / "done" / "20261029-100100-bbbb.json").is_file())

            fail = dict(content, url="https://www.instagram.com/p/Z/", canonical_url="https://www.instagram.com/p/Z/",
                        platform="instagram", status="failed", basis="無", reason="Instagram 要求登入才能看")
            (repo / "inbox" / "20261029-100200-cccc.json").write_text(json.dumps(
                {"v": 1, "url": fail["url"], "captured_at": "2026-10-29T10:02:00+08:00"}), encoding="utf-8")
            a3 = self._art(root, "20261029-100200-cccc", fail, "", None)
            self.assertEqual(publish.publish_one(repo, a3, {"id": "20261029-100200-cccc"}, tax), "card")
            idx = publish.rebuild_index(repo)
            self.assertEqual(idx["count"], 2)
            card = next(r for r in idx["items"] if r["id"] == "20261029-100200-cccc")
            self.assertEqual(card["one_line"], "無法讀取內容，請點原文連結查看")
            self.assertEqual(card["title"], "Instagram · 測試 的貼文")
            self.assertFalse(card["ai_ok"])
            row = next(r for r in idx["items"] if r["id"] == "20261029-100000-aaaa")
            self.assertEqual(row["locations"], [["日本", "大阪"], ["日本", "京都"]])

            # Re-run: the result replaces the old entry under its id and keeps its captures.
            (repo / "inbox" / "20261029-110000-dddd.json").write_text(json.dumps(
                {"v": 1, "url": content["url"], "captured_at": "2026-10-29T11:00:00+08:00", "redo_of": "20261029-100000-aaaa"}), encoding="utf-8")
            a4 = self._art(root, "20261029-110000-dddd", content, "第三家只開到下午三點", dict(GOOD, title="重跑後的標題"))
            self.assertEqual(publish.publish_one(repo, a4, {"id": "20261029-110000-dddd"}, tax), "ok")
            e = json.loads((repo / "library" / "20261029-100000-aaaa.json").read_text(encoding="utf-8"))
            self.assertEqual((e["title"], len(e["captures"]), e["why"]), ("重跑後的標題", 2, "去大阪用"))
            self.assertFalse((repo / "library" / "20261029-110000-dddd.json").exists())


if __name__ == "__main__":
    unittest.main()
