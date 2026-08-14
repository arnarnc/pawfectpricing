// Searching the saved comp sets by the cards inside them.
//
// A saved set is a past negotiation, but the question you actually ask of a
// stack of them is a card-level one: "what did I comp this at last time?"
// Answering with sets would make you open each one to find out, so this
// searches the ROWS and answers with them -- the card, the price it was
// comped at, and the rate it was offered at -- carrying the set each row came
// from so the list can jump straight back into it.
//
// Read-only by construction. Nothing here writes to a set or a row, and every
// price and rate it reports is parsed by money.js -- the same rules the totals
// use -- so what a search shows can never disagree with, or alter, what a comp
// is worth.

(function (root) {
  "use strict";

  // How many rows a search will return. The list is scrolled through by thumb
  // on a phone; past a screenful or two, refining the query beats scrolling.
  var LIMIT = 20;

  // Collector-number canonicaliser, injected by index.html (canonNum) so that
  // "125/094" and "125/94" are the same card here, in the catalogue search and
  // in recents alike. Falls back to a plain lowercase, which keeps this module
  // standalone and testable on its own.
  var canon = function (s) { return String(s == null ? "" : s).toLowerCase(); };
  function setCanon(fn) { if (typeof fn === "function") canon = fn; }

  // money.js is the single source of truth for what a stored price means, and
  // it must load first. Parsing prices any other way here would let the row a
  // search shows drift from the row the totals add up -- the exact class of
  // bug the whole-dollar rule exists to prevent.
  function dollars(v) { return root.Money.toDollars(v); }
  function pct(v) { return root.Money.toPct(v, 100); }   // same default as computeTotals

  // Split the query into terms. Every term has to be present (AND), which is
  // what makes typing more words narrow the list instead of widening it --
  // "char 125" is a sharper query than "char", not a broader one.
  function terms(query) {
    return canon(String(query == null ? "" : query)).split(/\s+/).filter(Boolean);
  }

  // Substring, not prefix: a comp label is free text the user typed ("Charizard
  // 125/094 nm", "PSA 9 Umbreon VMAX"), so the word you remember is often in
  // the middle of it.
  //
  // Takes either a raw query or an already-split term list. Both sides MUST be
  // canonicalised or "125/094" would fail to match "125/94" from one direction
  // only — a half-working equivalence is worse than none, so a plain string is
  // run through terms() rather than compared as-is.
  function matches(label, query) {
    var ts = Array.isArray(query) ? query : terms(query);
    var hay = canon(label == null ? "" : label);
    for (var i = 0; i < ts.length; i++) {
      if (hay.indexOf(ts[i]) === -1) return false;
    }
    return true;
  }

  // sets: the saved comp sets, newest first (that is how index.html keeps them).
  // Returns { rows, matched, sets, truncated }:
  //   rows      -- capped list of { set, setId, label, price, pct, excluded, index }
  //   matched   -- how many cards matched in total, before the cap
  //   sets      -- how many distinct sets those cards came from
  //   truncated -- matched minus what fitted
  //
  // Order is newest set first, and within a set most expensive first: the same
  // "most recent, most valuable" reading order the set rows already use, so a
  // search result never ranks by something invisible.
  //
  // Only the customer's cards are searched. The vendor's items are the other
  // side of the trade -- they carry no comped price or payout rate, so a
  // question phrased as "what did I comp this at" has no answer there.
  function search(sets, query, limit) {
    var ts = terms(query);
    var empty = { rows: [], matched: 0, sets: 0, truncated: 0 };
    if (!ts.length || !sets || !sets.length) return empty;

    var cap = limit > 0 ? limit : LIMIT;
    var rows = [];
    var matched = 0;
    var setCount = 0;

    for (var s = 0; s < sets.length; s++) {
      var set = sets[s];
      if (!set) continue;
      var items = set.compItems || [];
      var hits = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || !matches(item.label, ts)) continue;
        hits.push({
          set: set,
          setId: set.id,
          label: String(item.label == null ? "" : item.label),
          price: dollars(item.price),
          pct: pct(item.pct),
          // Kept rather than filtered out: a row you excluded is still a comp
          // you looked up, and hiding it would make a card you know is in
          // there look missing. It is labelled instead.
          excluded: !!item.excluded,
          index: i
        });
      }
      if (!hits.length) continue;
      hits.sort(function (a, b) { return b.price - a.price; });   // stable: ties keep set order
      matched += hits.length;
      setCount += 1;
      rows = rows.concat(hits);
    }

    return {
      rows: rows.slice(0, cap),
      matched: matched,
      sets: setCount,
      truncated: Math.max(0, matched - Math.min(rows.length, cap))
    };
  }

  var api = {
    LIMIT: LIMIT,
    search: search,
    terms: terms,
    matches: matches,
    setCanon: setCanon
  };

  root.CompSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
