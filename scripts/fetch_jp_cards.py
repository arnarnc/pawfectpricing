#!/usr/bin/env python3
"""
Fetch Japanese-exclusive Pokemon cards from TCGdex and write them as a compact
cards_jp.js for the autocomplete's local dataset -- in ENGLISH format (English
species name + collector number), tagged "(JP)" on the set so they read as
"Meowscarada ex  101/101 · Triplet Beat (JP)".

Why this exists: the English pokemontcg.io catalog (cards.js) has no Japanese
sets, and TCGdex's Japanese cards only carry Japanese names. So we translate
each card's Japanese name -> English via a PokeAPI species dictionary. Cards
that aren't a Pokemon species (Trainers, Energy) don't match the dictionary and
are skipped on purpose -- there's no clean English source for those.

Usage:
    python scripts/fetch_jp_cards.py
Re-run whenever you want to refresh (new Japanese sets). The species dictionary
is cached in scripts/jp_species.json so repeat runs don't re-hit PokeAPI.
"""
import json
import os
import re
import sys
import time
import urllib.request

TCGDEX = "https://api.tcgdex.net/v2"
POKEAPI_GQL = "https://beta.pokeapi.co/graphql/v1beta"
HERE = os.path.dirname(__file__)
SPECIES_CACHE = os.path.join(HERE, "jp_species.json")
OUT_PATH = os.path.join(HERE, "..", "cards_jp.js")

# Regional-form prefixes: Japanese names front-load the region, English cards
# do too ("アローラロコン" -> "Alolan Vulpix").
REGION_PREFIXES = [
    ("アローラ", "Alolan"),
    ("ガラル", "Galarian"),
    ("ヒスイ", "Hisuian"),
    ("パルデア", "Paldean"),
]

# Trailing rarity suffixes printed in latin on the Japanese card -> English token.
SUFFIXES = [
    ("vmax", " VMAX"),
    ("vstar", " VSTAR"),
    ("ex", " ex"),
    ("gx", " GX"),
    ("v", " V"),
]


def http_json(url, data=None, timeout=40):
    headers = {"User-Agent": "Mozilla/5.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["X-Method-Used"] = "graphiql"
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def load_species_dict():
    """{japanese_name: english_name} for all ~1025 species, cached to disk."""
    if os.path.exists(SPECIES_CACHE):
        with open(SPECIES_CACHE, encoding="utf-8") as f:
            return json.load(f)
    print("Building JP->EN species dictionary from PokeAPI...")
    q = {"query": "query{pokemon_v2_pokemonspeciesname(where:{language_id:{_in:[1,9]}})"
                  "{name language_id pokemon_species_id}}"}
    rows = http_json(POKEAPI_GQL, data=q)["data"]["pokemon_v2_pokemonspeciesname"]
    ja = {r["pokemon_species_id"]: r["name"] for r in rows if r["language_id"] == 1}
    en = {r["pokemon_species_id"]: r["name"] for r in rows if r["language_id"] == 9}
    pairs = {ja[i]: en[i] for i in ja if i in en}
    with open(SPECIES_CACHE, "w", encoding="utf-8") as f:
        json.dump(pairs, f, ensure_ascii=False)
    print(f"  cached {len(pairs)} species to {SPECIES_CACHE}")
    return pairs


def japanese_exclusive_sets():
    """Sets present in the Japanese catalog but not the English one."""
    ja = http_json(f"{TCGDEX}/ja/sets")
    en = http_json(f"{TCGDEX}/en/sets")
    en_ids = {s["id"].lower() for s in en}
    return [s for s in ja if s["id"].lower() not in en_ids]


def translate(jp_name, species_by_len):
    """Japanese card name -> English ('マスカーニャex' -> 'Meowscarada ex'),
    or None when it isn't a Pokemon species (Trainer/Energy/unmatched)."""
    name = jp_name.strip()

    # Strip a trailing latin rarity suffix (ex / V / VMAX / VSTAR / GX).
    suffix_en = ""
    for jp, en in SUFFIXES:
        m = re.search(r"\s*" + jp + r"\s*$", name, re.IGNORECASE)
        if m:
            suffix_en = en
            name = name[:m.start()].strip()
            break

    # Pull off a regional-form prefix.
    region_en = ""
    for jp, en in REGION_PREFIXES:
        if name.startswith(jp):
            region_en = en
            name = name[len(jp):]
            break

    # Longest species name that appears in what's left wins, so リザードン
    # (Charizard) beats リザード (Charmeleon).
    for jp_species, en_species in species_by_len:
        if jp_species in name:
            parts = [p for p in (region_en, en_species) if p]
            return " ".join(parts) + suffix_en
    return None


def main():
    species = load_species_dict()
    # Match longest Japanese species names first.
    species_by_len = sorted(species.items(), key=lambda kv: len(kv[0]), reverse=True)

    sets = japanese_exclusive_sets()
    print(f"{len(sets)} Japanese-exclusive sets to scan")

    rows = []
    seen = set()
    skipped = 0
    for i, s in enumerate(sets, 1):
        sid = s["id"]
        # TCGdex has no English NAME for these JP-exclusive sets (only Japanese),
        # so label by the latin set code ("SV1a (JP)") to keep the dropdown free
        # of Japanese text. Collectors recognize the code anyway.
        set_name = sid + " (JP)"
        cc = s.get("cardCount") or {}
        total = cc.get("official") or cc.get("total") or ""
        release = (s.get("releaseDate") or "").replace("/", "-")
        for attempt in range(4):
            try:
                cards = http_json(f"{TCGDEX}/ja/cards?set={sid}", timeout=30)
                break
            except Exception as e:
                wait = 4 * (attempt + 1)
                print(f"  set {sid} failed ({e}), retrying in {wait}s...")
                time.sleep(wait)
        else:
            print(f"  set {sid} gave up")
            continue

        kept = 0
        for c in cards if isinstance(cards, list) else []:
            en_name = translate(c.get("name") or "", species_by_len)
            if not en_name:
                skipped += 1
                continue
            num = str(c.get("localId") or "")
            if num.isdigit():
                num = str(int(num))  # "001" -> "1" to match the English dataset
            key = (en_name, num, set_name)
            if key in seen:
                continue
            seen.add(key)
            rows.append([en_name, num, str(total), set_name, release, en_name.lower()])
            kept += 1
        print(f"  [{i}/{len(sets)}] {sid}: {kept} cards -> {len(rows)} total")
        time.sleep(0.2)

    rows.sort(key=lambda r: r[4], reverse=True)  # newest sets first

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("// Auto-generated by scripts/fetch_jp_cards.py -- do not hand-edit.\n")
        f.write(f"// Snapshot: {time.strftime('%Y-%m-%d')} | {len(rows)} Japanese cards "
                f"(English names, Pokemon only)\n")
        f.write("// Re-run the script to refresh.\n")
        f.write("const CARDS_JP = " + json.dumps(rows, separators=(",", ":"), ensure_ascii=False) + ";\n")

    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"\nWrote {OUT_PATH} ({len(rows)} cards, {size_kb:.0f} KB; "
          f"{skipped} non-Pokemon cards skipped)")


if __name__ == "__main__":
    main()
