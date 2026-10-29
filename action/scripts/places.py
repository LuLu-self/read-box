"""One spelling per country and city, so 大阪／大阪市／Osaka filter as the same place."""
from __future__ import annotations

import re

COUNTRY = {
    "臺灣": "台灣", "中華民國": "台灣", "taiwan": "台灣", "japan": "日本", "日本國": "日本",
    "南韓": "韓國", "大韓民國": "韓國", "korea": "韓國", "south korea": "韓國", "thailand": "泰國",
    "vietnam": "越南", "singapore": "新加坡", "malaysia": "馬來西亞", "hong kong": "香港", "香港特別行政區": "香港",
    "macau": "澳門", "中國大陸": "中國", "china": "中國", "usa": "美國", "united states": "美國", "uk": "英國",
    "united kingdom": "英國", "france": "法國", "italy": "義大利", "意大利": "義大利", "germany": "德國",
    "australia": "澳洲", "澳大利亞": "澳洲",
}
CITY = {
    "臺北": "台北", "臺中": "台中", "臺南": "台南", "臺東": "台東", "osaka": "大阪", "kyoto": "京都",
    "tokyo": "東京", "東京都": "東京", "nara": "奈良", "kobe": "神戶", "fukuoka": "福岡", "sapporo": "札幌",
    "okinawa": "沖繩", "沖縄": "沖繩", "seoul": "首爾", "漢城": "首爾", "busan": "釜山", "bangkok": "曼谷",
    "chiang mai": "清邁", "taipei": "台北", "kaohsiung": "高雄", "taichung": "台中", "tainan": "台南",
    "hokkaido": "北海道", "北海道道": "北海道",
}
# Prefectures/provinces written with their suffix: dropping it would change the meaning less than keeping
# two spellings, so 大阪府→大阪, 京都府→京都, 新北市→新北.
SUFFIX = re.compile(r"(市|縣|府|都|道|省)$")
KEEP = {"北海道", "京都", "成都", "首都"}


def country(name: str | None) -> str:
    n = " ".join(str(name or "").split())[:20]
    return COUNTRY.get(n.lower(), COUNTRY.get(n, n))


def city(name: str | None) -> str:
    n = " ".join(str(name or "").split())[:30]
    if not n:
        return ""
    n = CITY.get(n.lower(), CITY.get(n, n))
    if n in KEEP:
        return n
    stripped = SUFFIX.sub("", n)
    n = stripped if len(stripped) >= 2 and re.search(r"[㐀-鿿]", stripped) else n
    return CITY.get(n, n)


def location_key(c: str, ci: str) -> tuple[str, str]:
    return country(c), city(ci)
