#!/usr/bin/env python3
"""
Refresh cards_op_jp.js -- the Japanese One Piece prints the English catalogue
(cards_op.js) does not have yet.

Japan runs ahead: a set, a starter deck or a promo is out there months before
its English release, and Limitless -- the source behind cards_op.js -- only
carries a set once it exists in English (its "Japanese" pages mirror the
English set list print for print). The official Japanese card list,
www.onepiece-cardgame.com/cardlist, is the one place those cards are listed.

Only card IDs missing from cards_op.js are kept. Everything else is already in
the English catalogue, and the language is chosen by typing "jp", not by
picking a different row -- the same card ID is the same card in both. Run this
AFTER fetch_op_cards.py, so a card that has since come out in English drops out
of this file on its own.

    python scripts/fetch_op_cards.py      # English first
    python scripts/fetch_op_jp_cards.py   # then the Japanese extras

Names come back in Japanese. Where the same Japanese name belongs to a card
that IS in the English catalogue, the English name is used instead
("モンキー・Ｄ・ルフィ" -> "Monkey.D.Luffy"), so most rows can still be found by
typing the character in English; the rest are found by their ID.
"""
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

BASE = "https://www.onepiece-cardgame.com/cardlist/"
HERE = os.path.dirname(__file__)
EN_PATH = os.path.join(HERE, "..", "cards_op.js")
OUT_PATH = os.path.join(HERE, "..", "cards_op_jp.js")
UA = "Mozilla/5.0 (compatible; pawfect-pricing/1.0)"

# The official site's rarity marks -> the app's rarity column.
RARITY = {"C": "C", "UC": "UC", "R": "R", "SR": "SR", "SEC": "SEC", "L": "L",
          "P": "P", "SP CARD": "SR", "TR": "SEC"}


def get(url, attempts=4):
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read().decode("utf-8", "replace")
        except Exception as e:
            wait = 4 * (attempt + 1)
            print(f"  {url} failed ({e}), retrying in {wait}s...")
            time.sleep(wait)
    print(f"  gave up on {url}")
    return ""


def clean(s):
    # Unescape first: the series names carry an escaped "<br>" of their own.
    return " ".join(re.sub(r"<[^>]+>", " ", html.unescape(s)).split())


def norm(s):
    """Full-width to half-width, so "Ｄ" and "D" are one name."""
    return unicodedata.normalize("NFKC", s).strip()


def load_english():
    src = open(EN_PATH, encoding="utf-8").read()
    m = re.search(r"const CARDS_OP = (\[.*\]);", src, re.S)
    return json.loads(m.group(1)) if m else []


def series_list(page):
    """[(value, title)] for every series in the card list's product filter."""
    sel = re.search(r'<select[^>]*name="series".*?</select>', page, re.S)
    body = sel.group(0) if sel else page
    return [(v, clean(t)) for v, t in re.findall(r'<option value="(\d{6})"[^>]*>(.*?)</option>', body, re.S)]


def set_code(title):
    """"...【EB-04】" -> "EB04"; promo / limited-product lists have none."""
    m = re.search(r"【([A-Z]+)-?(\d+)】", title)
    return f"{m.group(1)}{m.group(2)}" if m else ""


# The product lists that have no set code of their own, in English.
LIST_NAMES = {"プロモーションカード": "Promotion Card",
              "限定商品収録カード": "Limited Product Card",
              "ファミリーデッキセット": "Family Deck Set"}


def set_name(title):
    """Drop the Japanese product category in front of the name, keep the code:
    "エクストラブースター EGGHEAD CRISIS【EB-04】" -> "EGGHEAD CRISIS [EB-04]"."""
    if title in LIST_NAMES:
        return LIST_NAMES[title]
    t = re.sub(r"^(ブースターパック|エクストラブースター|プレミアムブースター|スタートデッキEX|"
               r"スタートデッキ|アルティメットデッキ)\s*", "", title)
    return t.replace("【", " [").replace("】", "]").strip()


def fetch_series(value):
    """Every print on one series page: (card_id, variant_suffix, rarity, jp_name)."""
    page = get(f"{BASE}?search=true&series={value}")
    out = []
    for m in re.finditer(r'<dl class="modalCol" id="([^"]+)">(.*?)</dl>', page, re.S):
        anchor, block = m.group(1), m.group(2)
        info = re.search(r'<div class="infoCol">(.*?)</div>', block, re.S)
        name = re.search(r'<div class="cardName">(.*?)</div>', block, re.S)
        if not (info and name):
            continue
        spans = [clean(s) for s in re.findall(r"<span>(.*?)</span>", info.group(1), re.S)]
        if len(spans) < 2:
            continue
        cid, rarity = spans[0], spans[1]
        variant = anchor[len(cid):].lstrip("_") if anchor.startswith(cid) else ""
        out.append((cid, variant, RARITY.get(rarity, ""), norm(clean(name.group(1)))))
    return out


def main():
    english = load_english()
    if not english:
        print("cards_op.js is empty -- run fetch_op_cards.py first.")
        return 1
    have_ids = {r[1].upper() for r in english}

    first = get(BASE)
    series = series_list(first)
    if not series:
        print("Couldn't read the series list -- nothing written.")
        return 1
    print(f"{len(series)} Japanese series to scan\n")

    scanned = []   # (cid, variant, rarity, jp_name, set_name, set_code)
    for i, (value, title) in enumerate(series, 1):
        prints = fetch_series(value)
        print(f"  [{i}/{len(series)}] {title}: {len(prints)} prints")
        for p in prints:
            scanned.append(p + (set_name(title), set_code(title)))
        time.sleep(0.5)

    # Japanese name -> English name, learned from every card that exists in
    # both catalogues. Only an unambiguous mapping is kept.
    en_by_id = {}
    for r in english:
        en_by_id.setdefault(r[1].upper(), r[0])
    votes = {}
    for cid, _, _, jp, _, _ in scanned:
        en = en_by_id.get(cid.upper())
        if en:
            votes.setdefault(jp, {}).setdefault(en, 0)
            votes[jp][en] += 1
    jp_to_en = {jp: max(c, key=c.get) for jp, c in votes.items() if len(c) == 1}

    out, seen = [], set()
    today = time.strftime("%Y-%m-%d")
    for cid, variant, rarity, jp, sname, scode in scanned:
        if cid.upper() in have_ids:
            continue
        # A parallel ("_p1", "_p2", ...) is what English sellers call the alt
        # art. The official list does not say which parallel is a manga or an
        # SP, so every one of them is filed as AA and they collapse to one row.
        treat = "AA" if variant.startswith("p") else ""
        key = (cid, treat)
        if key in seen:
            continue
        seen.add(key)
        name = jp_to_en.get(jp, jp)
        lower = name.lower() if name == jp else f"{name.lower()} {jp.lower()}"
        # Release date: the scan date. These are, by construction, cards newer
        # than anything in English, so they sort to the top as the newest rows.
        own = scode if cid.upper().replace("-", "").startswith(scode) and scode else ""
        out.append([name, cid, rarity, treat, sname, today, lower, own, "jp"])

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("// Auto-generated by scripts/fetch_op_jp_cards.py -- do not hand-edit.\n")
        f.write(f"// Snapshot: {today} | {len(out)} Japanese One Piece prints not yet in cards_op.js\n")
        f.write("// Row: [name, cardId, rarity, treatment, setName, releaseDate, nameLower, setCode, \"jp\"]\n")
        f.write("const CARDS_OP_JP = " + json.dumps(out, separators=(",", ":"), ensure_ascii=False) + ";\n")
    named = sum(1 for r in out if re.search(r"[A-Za-z]", r[0]))
    print(f"\nWrote {os.path.normpath(OUT_PATH)} ({len(out)} prints, {named} with English names, "
          f"{os.path.getsize(OUT_PATH) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
