#!/usr/bin/env python3
"""
Refresh cards.js -- the local card dataset that powers the instant autocomplete.

By default this runs INCREMENTALLY: it reads the cards.js you already have,
asks pokemontcg.io which sets exist, and downloads only the sets that are
missing or still filling in. A routine "a new set just dropped" refresh pulls
one or two sets instead of all ~20,000 cards, so it finishes in seconds and
barely touches the rate limit.

Usage:
    python scripts/fetch_cards.py                  # incremental (what you want)
    python scripts/fetch_cards.py --full           # rebuild from scratch
    python scripts/fetch_cards.py YOUR_API_KEY     # key = faster, higher limits
    POKEMONTCG_API_KEY=... python scripts/fetch_cards.py

A key isn't required. Without one you're on the keyless tier, which is slower
and throttled -- fine for an incremental run, painful for --full.

Newly released cards are ALSO covered live by the API fallback in index.html,
so running this is about making them instant offline, not about correctness.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://api.pokemontcg.io/v2"
PAGE_SIZE = 250
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "cards.js")
# Remembers how many cards the API actually returned per set. Some sets -- the
# Black Star Promo lines especially -- have a printed total the API can't fill
# (307 printed, 304 catalogued). Without this the "incomplete" check would
# redownload those sets on every single run, forever, and never add a card.
STATE_PATH = os.path.join(os.path.dirname(__file__), "fetch_state.json")

# A set released within this window is treated as "still filling in": secret
# rares and alternate arts are catalogued for weeks after a set goes live, so a
# set fetched on release day is usually incomplete.
RECENT_DAYS = 75


def request(url, api_key, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    if api_key:
        req.add_header("X-Api-Key", api_key)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def retrying(url, api_key, label, attempts=5):
    for attempt in range(attempts):
        try:
            return request(url, api_key)
        except Exception as e:
            wait = 5 * (attempt + 1)
            print(f"  {label} failed ({e}), retrying in {wait}s...")
            time.sleep(wait)
    print(f"  {label} gave up")
    return None


# ── Existing dataset ───────────────────────────────────────────
def load_existing():
    """Rows already in cards.js, or [] if there's no usable file yet."""
    if not os.path.exists(OUT_PATH):
        return []
    try:
        with open(OUT_PATH, encoding="utf-8") as f:
            text = f.read()
        m = re.search(r"const CARDS\s*=\s*(\[.*\])\s*;", text, re.S)
        if not m:
            return []
        rows = json.loads(m.group(1))
        return [r for r in rows if isinstance(r, list) and len(r) >= 6]
    except Exception as e:
        print(f"WARNING: couldn't read the existing {OUT_PATH} ({e}) -- doing a full fetch.")
        return []


def row_of(card):
    s = card.get("set") or {}
    name = card.get("name") or ""
    return [
        name,
        card.get("number") or "",
        s.get("printedTotal") or s.get("total") or "",
        s.get("name") or "",
        (s.get("releaseDate") or "").replace("/", "-"),
        name.lower(),
    ]


def days_between(a, b):
    """Whole days from date string a to date string b ('YYYY-MM-DD'), 0 if unparseable."""
    try:
        fmt = "%Y-%m-%d"
        return (time.mktime(time.strptime(b, fmt)) - time.mktime(time.strptime(a, fmt))) / 86400
    except Exception:
        return 0


# ── Which sets need fetching ───────────────────────────────────
def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1, sort_keys=True)
    except Exception as e:
        print(f"  (couldn't save {STATE_PATH}: {e})")


def stale_sets(sets, existing, state):
    """The sets worth downloading, newest first, each with the reason why.

    Three reasons a set makes the list:
      new        -- no cards from it in the local file at all
      recent     -- released in the last RECENT_DAYS, so still being catalogued
      incomplete -- fewer local cards than the printed total, AND fewer than the
                    API gave us last time (so a permanently short set settles).
    """
    counts = {}
    for r in existing:
        counts[r[3]] = counts.get(r[3], 0) + 1

    today = time.strftime("%Y-%m-%d")
    todo = []
    for s in sets:
        name = s.get("name") or ""
        release = (s.get("releaseDate") or "").replace("/", "-")
        have = counts.get(name, 0)
        printed = s.get("printedTotal") or s.get("total") or 0
        seen_from_api = (state.get(s.get("id") or "") or {}).get("api")

        if have == 0:
            reason = "new"
        elif release and days_between(release, today) < RECENT_DAYS:
            reason = "recent"
        elif printed and have < printed and (seen_from_api is None or have < seen_from_api):
            reason = "incomplete"
        else:
            continue
        todo.append((s, reason, have, printed))

    todo.sort(key=lambda t: (t[0].get("releaseDate") or ""), reverse=True)
    return todo


def fetch_set(set_id, api_key):
    """Every card in one set, following pagination."""
    cards, page = [], 1
    while True:
        url = (f"{API}/cards?pageSize={PAGE_SIZE}&page={page}"
               f"&select=name,number,set&q=" + urllib.parse.quote(f'set.id:"{set_id}"'))
        data = retrying(url, api_key, f"set {set_id} page {page}")
        if not data:
            return cards
        batch = data.get("data", [])
        cards.extend(batch)
        if len(batch) < PAGE_SIZE:
            return cards
        page += 1
        time.sleep(0.15 if api_key else 1.0)


def fetch_everything(api_key):
    """The --full path: walk the whole catalog page by page."""
    first = retrying(f"{API}/cards?pageSize={PAGE_SIZE}&page=1&select=name,number,set",
                     api_key, "page 1")
    if not first:
        return []
    total = first.get("totalCount", 0)
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    print(f"totalCount={total} pages={pages}")

    cards = list(first.get("data", []))
    for page in range(2, pages + 1):
        data = retrying(f"{API}/cards?pageSize={PAGE_SIZE}&page={page}&select=name,number,set",
                        api_key, f"page {page}")
        if data:
            cards.extend(data.get("data", []))
        print(f"  page {page}/{pages} -> {len(cards)} cards so far")
        time.sleep(0.15 if api_key else 1.0)
    return cards


# ── Merge + write ──────────────────────────────────────────────
def merge(existing, new_rows):
    """Union keyed on (name, number, set). Fresh rows win, so a corrected
    printed total or set name from the API replaces the stale local copy."""
    by_key = {}
    order = []
    for r in existing:
        k = (r[0], r[1], r[3])
        if k not in by_key:
            order.append(k)
        by_key[k] = r
    added = 0
    for r in new_rows:
        k = (r[0], r[1], r[3])
        if k not in by_key:
            order.append(k)
            added += 1
        by_key[k] = r
    rows = [by_key[k] for k in order]
    rows.sort(key=lambda r: r[4], reverse=True)  # newest sets first
    return rows, added


def write(rows):
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("// Auto-generated by scripts/fetch_cards.py -- do not hand-edit.\n")
        f.write(f"// Snapshot: {time.strftime('%Y-%m-%d')} | {len(rows)} cards\n")
        f.write("// Re-run the script to refresh. Newer sets are also covered live via the API fallback.\n")
        f.write("const CARDS_SNAPSHOT = " + json.dumps(time.strftime("%Y-%m-%d")) + ";\n")
        f.write("const CARDS = " + json.dumps(rows, separators=(",", ":"), ensure_ascii=False) + ";\n")
    return os.path.getsize(OUT_PATH) / 1024


def main():
    args = [a for a in sys.argv[1:]]
    full = "--full" in args
    args = [a for a in args if not a.startswith("--")]
    api_key = (args[0] if args else None) or os.environ.get("POKEMONTCG_API_KEY")
    if not api_key:
        print("NOTE: no API key -- keyless tier is slower and throttled.")
        print("  python scripts/fetch_cards.py YOUR_API_KEY\n")

    existing = [] if full else load_existing()
    if full:
        print("Full rebuild requested.\n")
        cards = fetch_everything(api_key)
        rows, added = merge([], [row_of(c) for c in cards])
        print(f"\nFetched {len(rows)} cards.")
    else:
        print(f"Existing dataset: {len(existing)} cards")
        sets = retrying(f"{API}/sets?pageSize=500", api_key, "set list")
        if sets is None:
            print("Couldn't reach the API -- nothing written, your cards.js is untouched.")
            return 1
        sets = sets.get("data", [])
        state = load_state()
        todo = stale_sets(sets, existing, state)
        print(f"{len(sets)} sets published, {len(todo)} need fetching\n")

        if not todo:
            print("Already up to date -- nothing to do.")
            return 0

        new_rows = []
        for i, (s, reason, have, printed) in enumerate(todo, 1):
            print(f"  [{i}/{len(todo)}] {s.get('name')} ({s.get('releaseDate')}) "
                  f"- {reason}, have {have}/{printed or '?'}")
            cards = fetch_set(s.get("id"), api_key)
            new_rows.extend(row_of(c) for c in cards)
            # Record the count under THIS set's name, not the raw card count.
            # One set id can span several set names (svp returns 165 "Scarlet &
            # Violet Black Star Promos" plus 35 "Scarlet & Violet Promos"), and
            # the local tally is name-keyed -- comparing it to the raw total
            # would leave the set looking permanently short.
            if cards:
                same_name = sum(1 for c in cards
                                if ((c.get("set") or {}).get("name") or "") == s.get("name"))
                state[s.get("id") or ""] = {
                    "api": same_name, "fetched": len(cards), "at": time.strftime("%Y-%m-%d")
                }
            print(f"        fetched {len(cards)} cards")
            time.sleep(0.15 if api_key else 1.0)

        save_state(state)
        rows, added = merge(existing, new_rows)
        print(f"\n{added} new cards added ({len(existing)} -> {len(rows)}).")
        if added == 0 and len(rows) == len(existing):
            print("Nothing changed, but rewriting anyway to refresh the snapshot date.")

    size_kb = write(rows)
    print(f"Wrote {os.path.normpath(OUT_PATH)} ({len(rows)} cards, {size_kb:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
