// Money rules for the pricing tool, kept in one place so they can be tested
// (tests.html) instead of living inline in index.html.
//
// ONE rule underpins everything here: **every dollar amount is a whole-dollar
// integer**. There are no cents anywhere -- not in what's typed, not in what's
// stored, not in what's totalled, not in what's displayed. Anything that could
// introduce a fraction rounds at the moment it enters the system.
//
// That matters because these numbers are used to quote a customer. A price the
// UI shows as "12" but stores as 12.4 (the old behaviour) means the printed
// total silently disagrees with the sum of the visible rows, and the vendor
// eats the difference. Integers make displayed == stored == totalled, always.

(function (root) {
  "use strict";

  var MAX_PRICE = 9999999; // sanity ceiling: a fat-fingered extra digit shouldn't quote $9m

  // ── Parsing ────────────────────────────────────────────────
  // Any user-supplied price -> a whole-dollar integer >= 0.
  // "12.50" -> 13, "1,299" -> 1299, "-5" -> 0, "abc"/""/null -> 0.
  // Negatives clamp to 0 rather than subtracting: a negative comp would quietly
  // shrink a payout, and there is no legitimate way to enter one.
  function toDollars(v) {
    if (typeof v === "number") return clampDollars(v);
    var s = String(v == null ? "" : v).replace(/[,$\s]/g, "");
    if (!s) return 0;
    var n = parseFloat(s);
    return clampDollars(n);
  }

  function clampDollars(n) {
    if (!isFinite(n) || isNaN(n)) return 0;
    if (n < 0) return 0;
    if (n > MAX_PRICE) return MAX_PRICE;
    return Math.round(n);
  }

  // Payout percentage -> integer 0..100. Deliberately NOT `parseInt(v) || 100`:
  // that turns a legitimate 0% into 100%, i.e. the maximum possible payout.
  // Anything unparseable falls back to `fallback` (the caller's current rate),
  // never to a silently more generous number.
  function toPct(v, fallback) {
    var n = parseInt(String(v == null ? "" : v).replace(/[%\s]/g, ""), 10);
    if (isNaN(n)) return typeof fallback === "number" ? fallback : 100;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  // ── Formatting ─────────────────────────────────────────────
  // Display an integer dollar amount: 1299 -> "1,299". No decimal places, ever.
  function fmtMoney(n) {
    return clampDollars(n).toLocaleString("en-US");
  }

  // Live formatting while typing. Keeps digits and (temporarily) a single
  // decimal point so a half-typed "12." isn't destroyed mid-keystroke, and
  // commas the integer part. Crucially it does NOT strip the dot and glue the
  // digits together -- the old code turned "12.50" into "1250", a 100x
  // over-quote. The fraction is dropped on commit (see commitPriceInput).
  function livePriceText(raw) {
    var s = String(raw == null ? "" : raw).replace(/[^\d.]/g, "");
    var dot = s.indexOf(".");
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
    var parts = s.split(".");
    var intPart = parts[0].replace(/^0+(?=\d)/, "");
    var head = intPart ? Number(intPart).toLocaleString("en-US") : (parts.length > 1 ? "0" : "");
    return parts.length > 1 ? head + "." + parts[1] : head;
  }

  // Commit: round to whole dollars and render the canonical text.
  // Returns { value: <int>, text: <display string> }.
  function commitPrice(raw) {
    var v = toDollars(raw);
    return { value: v, text: v > 0 ? fmtMoney(v) : "" };
  }

  // ── Totals ─────────────────────────────────────────────────
  // items: [{ price, pct, excluded }]. Excluded rows contribute nothing.
  //
  // Payout rounds ONCE, on the summed total -- not per row. Rounding each row
  // and then adding accumulates up to half a dollar of drift per item (25 rows
  // could be $12 off); rounding the sum keeps the error under 50c no matter how
  // many rows there are, and keeps "market x rate" reconcilable.
  function computeTotals(compItems, tradeItems, headerPct) {
    var comps = (compItems || []).filter(function (x) { return !x.excluded; });
    var trades = (tradeItems || []).filter(function (x) { return !x.excluded; });

    var market = comps.reduce(function (s, x) { return s + toDollars(x.price); }, 0);
    var payoutRaw = comps.reduce(function (s, x) {
      return s + toDollars(x.price) * (toPct(x.pct, 100) / 100);
    }, 0);
    var payout = clampDollars(payoutRaw);
    var trade = trades.reduce(function (s, x) { return s + toDollars(x.price); }, 0);

    // Everything below is integer arithmetic, so equality/sign tests are exact
    // -- no float-epsilon fudging needed.
    var diff = trade - payout;
    var effRate = market > 0 ? (payout / market * 100) : toPct(headerPct, 100);

    return {
      market: market,
      payout: payout,
      trade: trade,
      diff: diff,
      effRate: effRate,
      settlement: settle(trade, payout, diff)
    };
  }

  // diff = vendor's items value - customer's payout.
  //   > 0  customer received more value than they gave  -> customer pays the gap
  //   < 0  vendor still owes cash on top of their items -> vendor pays the gap
  //   = 0  with value on both sides                     -> straight swap
  // The `hasValue: false` case (both sides empty) is what hides the panel.
  function settle(trade, payout, diff) {
    if (trade <= 0 && payout <= 0) return { hasValue: false, kind: "none", label: "", amount: 0 };
    if (diff === 0 && trade > 0 && payout > 0) {
      return { hasValue: true, kind: "even", label: "Direct Trade", amount: 0 };
    }
    if (diff > 0) {
      return { hasValue: true, kind: "customer", label: "Customer to Pay", amount: diff };
    }
    return { hasValue: true, kind: "vendor", label: "Vendor to Pay", amount: -diff };
  }

  // Monotonically increasing id. Date.now() alone collides when two rows are
  // added inside the same millisecond, and the delete/update handlers match by
  // id -- so a collision would edit or remove the wrong row.
  var lastId = 0;
  function nextId() {
    var t = Date.now() * 1000;      // headroom for many ids inside one millisecond
    lastId = t > lastId ? t : lastId + 1;
    return lastId;                  // strictly increasing, so it can never repeat
  }

  // Bring older saved data (which could hold decimals) onto the integer rule,
  // so a comp list saved before this change totals the same as it displays.
  function normalizeItems(items) {
    return (items || []).map(function (x) {
      return Object.assign({}, x, {
        price: toDollars(x.price),
        pct: x.pct === undefined ? x.pct : toPct(x.pct, 100)
      });
    });
  }

  var api = {
    MAX_PRICE: MAX_PRICE,
    toDollars: toDollars,
    toPct: toPct,
    fmtMoney: fmtMoney,
    livePriceText: livePriceText,
    commitPrice: commitPrice,
    computeTotals: computeTotals,
    settle: settle,
    nextId: nextId,
    normalizeItems: normalizeItems
  };

  root.Money = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
