// One Piece TCG: catalogue search, shorthand, and the eBay keyword string.
//
// The One Piece card game names a card differently from Pokemon, and the whole
// module follows from that one fact. A Pokemon card is pinned by "name +
// collector number" because the number ("125/197") is only unique inside its
// set. A One Piece card is pinned by its ID alone -- "OP01-016" carries the set
// (OP01) and the card (016) in one token, and no other card in the game shares
// it. The name is still worth sending -- plenty of sellers title on the
// character and never type an ID at all -- and it is sent WHOLE, exactly as it
// was typed.
//
// What the ID does not pin down is the printing, and that is where the money
// is. OP01-016 exists as a plain Rare (a couple of dollars), as an Alternate
// Art (hundreds), and as a Manga Art (thousands). One number, three cards, three
// prices. So a short tag ("aa", "manga", "sp") rides along to say which one you
// are holding.
//
// The query this builds is deliberately THIN. eBay ANDs every word, so every
// word added is listings removed, and the earlier build spelled its tags out
// ("aa" -> "alt art") and excluded words the plain print supposedly never has
// ("-alt -manga -parallel"). Both guesses cost real comps: a seller who titled
// the card "Alternate Art" or mentioned "alt" anywhere in the title vanished.
// So the rule is: keep what was TYPED. The character name goes in verbatim,
// and most tags do too. Type "luffy" for the wide net; type "monkey.d.luffy"
// for the narrow one. Which of those you want is a decision only you can make,
// because only you can see the card.
//
// Two things are exceptions, and both are exceptions for the same reason --
// they are the cases where ONE ID IS TWO CARDS, so nothing the typist can add
// to the ID separates them:
//
//   the printing   the SP and the alternate art of a number are different
//                  cards at different prices. Each asks for its own wording as
//                  an OR-group and shuts the other out, and a card with no tag
//                  at all -- the plain print, the cheap one -- shuts out both
//                  (see PRINT_SEARCH).
//   the language   Bandai prints the same ID on the English and the Japanese
//                  card, so both are on one results page. A foreign card asks
//                  for its language; an English one excludes the others, and
//                  never asks for "english" (see LANGS).
//
// eBay's any-of syntax -- (alt,alternate,parallel) -- is what makes those
// affordable. A bare keyword is ANDed, so one spelling of a word sellers spell
// three ways loses the other two; a group asks for all of them at once.
//
// Depends on cards_op.js (CARDS_OP). Standalone and side-effect free otherwise.

(function (root) {
  "use strict";

  // ── Print treatments ──────────────────────────────────────
  // Three columns now, not four:
  //
  //   code   what cards_op.js stores (from the Limitless print label)
  //   label  what the status badge shows a human
  //   type   every shorthand that maps to this treatment
  //
  // There is no longer an `ebay` column. What goes to eBay is the token the
  // user typed, unexpanded -- "alt" stays "alt", "sp" stays "sp", "treasure"
  // stays "treasure". A seller who wrote "Alt Art", "Alternate Art" or just
  // "ALT" is matched by the short form and missed by the long one, and the
  // short form is never worse. The table survives only to name the printing in
  // the badge and to recognise a tag as "not part of the character's name".
  var TREATMENTS = [
    { code: "AA",     label: "Alt Art",     type: ["aa", "alt", "altart", "alternate"] },
    { code: "MANGA",  label: "Manga",       type: ["manga", "mr", "comic"] },
    { code: "SP",     label: "SP",          type: ["sp", "special"] },
    { code: "FA",     label: "Full Art",    type: ["fa", "fullart"] },
    { code: "TR",     label: "Treasure",    type: ["tr", "treasure"] },
    { code: "PAN",    label: "Pandaman",    type: ["pan", "panda", "pandaman"] },
    { code: "TF",     label: "Textured",    type: ["tf", "textured"] },
    { code: "PF",     label: "Pirate Foil", type: ["pf", "pirate"] },
    { code: "SERIAL", label: "Serial",      type: ["serial", "ser"] },
    { code: "WINNER", label: "Winner",      type: ["winner", "win"] },
    { code: "JR",     label: "Judge",       type: ["jr", "judge"] },
    { code: "WANTED", label: "Wanted",      type: ["wanted", "wp"] }
  ];

  // The plain printing names itself in the badge but contributes NOTHING to the
  // eBay query. It used to contribute exclusions ("-alt -manga -parallel"),
  // which is the single biggest source of missing comps in the old build: a
  // listing that merely mentioned one of those words anywhere in its title was
  // struck out, base print or not. No seller writes "base" either, so there is
  // no keyword to swap the exclusions for -- the honest answer is nothing.
  var BASE = {
    code: "BASE", label: "Base Print", quiet: true,
    type: ["base", "reg", "regular", "normal", "plain"]
  };

  // Language, as eBay syntax rather than as a word.
  //
  // This is the one thing about One Piece that has no Pokemon equivalent, and
  // it costs real money to get wrong: Bandai prints the SAME card ID on the
  // English and the Japanese card. "OP01-016" returns both on one results
  // page, at different prices, and no amount of ID precision separates them --
  // only the language does.
  //
  // Two directions, and they are not symmetric:
  //
  //   a foreign card ASKS for its language, as every spelling sellers use.
  //   an English card EXCLUDES the others, and never asks for "english".
  //
  // Asking for "english" is the same trap as asking for "parallel": plenty of
  // genuine English listings never write the word ("One Piece TCG Romance Dawn
  // OP01-003 Monkey D Luffy Leader" is a real title), so requiring it throws
  // away most of the pool it was meant to clean up. Excluding the languages
  // that DO get written is the half that works, because a Japanese seller
  // nearly always says so somewhere in the title.
  var LANGS = {
    en: "english", eng: "english", english: "english",
    jp: "japanese", jpn: "japanese", jap: "japanese", japanese: "japanese",
    cn: "chinese", chn: "chinese", china: "chinese", chinese: "chinese",
    kr: "korean", kor: "korean", korea: "korean", korean: "korean"
  };

  // What to ASK for, per language. An OR-group, not one spelling: eBay ANDs
  // bare keywords, so demanding "japanese" loses everybody who wrote "JP" and
  // demanding "jp" loses everybody who wrote it out.
  var LANG_SEARCH = {
    japanese: ["japanese", "jap", "jp", "jpn"],
    chinese: ["chinese", "cn", "chn", "china"],
    korean: ["korean", "kor", "kr", "korea"]
  };

  // What an English card excludes: every language above, in one negated group,
  // plus the country words sellers write instead of the language ("From JAP",
  // "Japan import"). One group rather than a dozen "-word" terms, which eBay
  // accepts the same way it accepts a positive one.
  var NOT_ENGLISH = ["japanese", "japan", "jap", "jp", "jpn", "nihongo",
                     "chinese", "china", "cn", "chn",
                     "korean", "korea", "kr", "kor",
                     "indonesian", "indonesia"];

  // eBay's any-of syntax: (alt,alternate,parallel). No spaces inside -- a
  // space ends the group and the rest becomes separate ANDed keywords.
  function orGroup(words) {
    var list = (words || []).filter(Boolean);
    if (!list.length) return "";
    return list.length === 1 ? list[0] : "(" + list.join(",") + ")";
  }

  // The language part of a card query: a group to ask for, or a negated group
  // that leaves the English pool standing. Never both, never "english".
  function langTerms(lang) {
    var want = String(lang || "").toLowerCase();
    if (want && want !== "english" && LANG_SEARCH[want]) return orGroup(LANG_SEARCH[want]);
    if (want && want !== "english") return want;
    return "-" + orGroup(NOT_ENGLISH);
  }

  // How to ask for a printing, and how to shut the other printings of the same
  // number out.
  //
  // A One Piece ID names a NUMBER, not a product. 957 of the catalogue's 2,795
  // numbers carry a plain print and at least one other printing, and the other
  // printing is not a near-miss -- OP01-016 Nami is a plain Rare, an alternate
  // art, a manga art and an SP, at four prices spanning three orders of
  // magnitude. So a query has to say which one it means, in both directions:
  //
  //   ask   the words a seller of THIS printing writes, as an OR-group,
  //         because they spell it several ways and agree on none.
  //   veto  the words to subtract when this printing is the SIBLING you are
  //         not holding.
  //
  // `ask` is empty where the printing has no word that is safe to demand, and
  // then whatever was typed goes through instead -- the old rule. `veto` is
  // empty in the same cases, which is the more important half: subtracting a
  // word is subtracting listings, and a word that is merely COMMON does far
  // more damage as an exclusion than it does good.
  //
  //   Full Art   "full" and "fa" are both unsafe. The phrase is everywhere in
  //              TCG titles and the abbreviation is two letters.
  //   Pirate Foil  "pirate" is a One Piece word before it is a printing --
  //              Pirate King, pirate crew, the game's own marketing.
  //
  // Those two are the known gap: a plain print whose only sibling is a Full Art
  // or a Pirate Foil gets no exclusion, because every word that would express
  // it costs more than it saves. 160 numbers are in that position.
  var PRINT_SEARCH = {
    // "parallel" is Bandai's own word, "alternate" is the one most titles use,
    // "alt" catches "Alt Art" and the bare "ALT".
    //
    // altWording marks the one veto that cannot be pointed at another PRINTING,
    // only at the plain print. Every non-base printing in the game gets called
    // an "alt art" or a "parallel" by somebody -- an SP is titled "SP Alt Art"
    // as often as "(SP)" -- so "-alt" aimed at a manga art or an SP throws away
    // the listings it was aimed at. Aimed at the plain print it is exact: the
    // plain print is the one card nobody describes that way.
    AA:     { ask: ["alt", "alternate", "parallel"],
              veto: ["alt", "alternate", "parallel"], altWording: true },
    SP:     { ask: ["sp"], veto: ["sp"] },
    MANGA:  { ask: ["manga", "comic"], veto: ["manga", "comic"] },
    TR:     { ask: ["treasure", "tr"], veto: ["treasure"] },
    TF:     { ask: ["textured"], veto: ["textured"] },
    PAN:    { ask: ["pandaman", "panda"], veto: ["pandaman", "panda"] },
    SERIAL: { ask: ["serial"], veto: ["serial"] },
    WINNER: { ask: ["winner"], veto: ["winner"] },
    JR:     { ask: ["judge"], veto: ["judge"] },
    WANTED: { ask: ["wanted"], veto: ["wanted"] },
    FA:     { ask: [], veto: [] },
    PF:     { ask: [], veto: [] },
    BASE:   { ask: [], veto: [] }
  };

  // Vetoes come out in this order whatever order the catalogue lists the
  // printings in, so one card always produces one query. TREATMENTS is the
  // order the printings are declared in at the top of the file.
  var VETO_ORDER = TREATMENTS.map(function (t) { return t.code; });

  // What to exclude when the catalogue cannot say which printings a number has
  // -- an ID it does not carry, or cards_op.js not loaded yet. The two that
  // share a number most often, and between them the two the plain print is
  // most often mispriced against.
  var FALLBACK_SIBLINGS = ["AA", "SP"];

  // Which printings actually exist for a card ID, or null when the catalogue
  // has no opinion. Built once, lazily, and never cached from an empty
  // catalogue -- cards_op.js may simply not have loaded yet.
  //
  // This is what makes the exclusions affordable. A blanket "-(alt,...,manga,
  // treasure,...)" on every plain print would subtract six words from the 511
  // numbers whose only sibling is an alternate art, and every one of those
  // words is listings gone for a card that has no manga print to be confused
  // with. Asking the catalogue means a query excludes exactly the printings
  // that exist to be excluded.
  var cardIndex = null;
  function indexed(code) {
    if (!code) return null;
    if (!cardIndex) {
      var all = rows();
      if (!all.length) return null;
      cardIndex = {};
      all.forEach(function (r) {
        var id = String(r[1] || "").toUpperCase();
        var e = cardIndex[id] || (cardIndex[id] = { codes: {}, words: {} });
        e.codes[r[3] || "BASE"] = 1;
        // The card's own name, word by word. Used to tell a printing tag from a
        // character -- see `chooseTreatment`.
        String(r[6] || r[0] || "").toLowerCase().split(/[^0-9a-z]+/)
          .forEach(function (w) { if (w) e.words[w] = 1; });
      });
    }
    return cardIndex[String(code || "").toUpperCase()] || null;
  }

  function treatmentsFor(code) {
    var e = indexed(code);
    return e ? Object.keys(e.codes) : null;
  }

  // Is this word part of what the card is CALLED? "Vinsmoke Judge", "Mad
  // Treasure" and "Hurry Up and Make Me the Pirate King!" are characters and
  // card titles, and "judge", "treasure" and "pirate" are also printing tags.
  // The catalogue settles it, because it knows the name that goes with the ID.
  function isNameWord(code, word) {
    var e = indexed(code);
    return !!(e && e.words[word]);
  }

  // The printing part of a card query: what this printing is called, then what
  // the other printings of its number are called, subtracted.
  //
  // A query with no card ID gets neither. The box is then a free-text search on
  // a character's name, nothing has claimed a printing, and there is no number
  // for the printings to be siblings OF -- which is the same reason the badge
  // shows nothing there.
  function printTerms(p, typed) {
    if (!p.code) return p.treatWords;
    var asked = p.treat ? p.treat.code : "BASE";
    var rule = PRINT_SEARCH[asked] || { ask: [], veto: [] };

    var out = rule.ask.length ? [orGroup(rule.ask)] : p.treatWords.slice();

    var siblings = treatmentsFor(p.code) || FALLBACK_SIBLINGS;
    var words = [], seen = {};
    VETO_ORDER.forEach(function (code) {
      if (code === asked || siblings.indexOf(code) === -1) return;
      // A printing named in the box is never subtracted, whichever of its
      // spellings was typed: "op01-016 alt manga" asked for the alt, and
      // subtracting "comic" there would still be arguing with the box.
      if (p.treatCodes.indexOf(code) !== -1) return;
      var other = PRINT_SEARCH[code];
      if (!other || !other.veto.length) return;
      if (other.altWording && asked !== "BASE") return;
      other.veto.forEach(function (w) {
        // Never subtract a word that was TYPED. Two ways that happens, and both
        // produce a query that argues with itself:
        //
        //   two tags     "op01-016 alt manga" -- only the first tag is asked
        //                for, and without this the second is then EXCLUDED, so
        //                the box says manga and the query says never manga.
        //   the name     "Mad Treasure EB02-057" and "Vinsmoke Judge OP11-044"
        //                are characters, not printings. A number of theirs that
        //                also has a Treasure or Judge print would otherwise
        //                subtract a word out of the card's own name, and eBay
        //                would return an empty page for a card that sells fine.
        //
        // The typist wins either way: what is in the box is in the search.
        if (typed && typed.indexOf(w) !== -1) return;
        if (!seen[w]) { seen[w] = 1; words.push(w); }
      });
    });
    if (words.length) out.push("-" + orGroup(words));
    return out;
  }

  // Every word the query itself is made of, lowercased and split the way a
  // veto word would have to match. Built from what was TYPED rather than from
  // the parse, so a word is protected whichever part of the parse claimed it.
  function typedWords(raw) {
    return String(raw == null ? "" : raw).toLowerCase().split(/[^0-9a-z]+/).filter(Boolean);
  }

  // Sealed product shorthand. etb/bbx are already global in index.html; these
  // are the ones only One Piece has.
  var PRODUCTS = {
    sd: "starter deck", st: "starter deck", deck: "starter deck",
    dp: "double pack", case: "sealed case"
  };
  var SEALED_RE = /\b(booster box|bbx|starter deck|sd|sealed|case|display|carton|dp|double pack)\b/i;

  var BY_SHORTHAND = {};   // "aa" -> treatment
  var BY_CODE = {};        // "AA" -> treatment
  [BASE].concat(TREATMENTS).forEach(function (t) {
    BY_CODE[t.code] = t;
    t.type.forEach(function (s) { BY_SHORTHAND[s] = t; });
  });

  // Everything the parser recognises as "not part of a character's name".
  // "ace" is deliberately NOT here, unlike on the Pokemon side: ACE Grading
  // exists, but in One Piece "Ace" is Portgas D. Ace and that is overwhelmingly
  // what the word means in this box. Treating it as a grader cost the name.
  var GRADERS = /^(psa|bgs|cgc|sgc|tag)$/;
  var CONDITIONS = /^(nm|lp|mp|hp|dmg|mint|near|lightly|moderately|heavily|played|damaged|raw|graded|sealed|gem)$/;

  // Collector-number canonicaliser, injected by index.html so "OP01-016" and
  // "op1-16" are one card here, in recents and in the saved-comp search alike.
  var canon = function (s) { return String(s == null ? "" : s).toLowerCase(); };
  function setCanon(fn) { if (typeof fn === "function") canon = fn; }

  // ── Card IDs ──────────────────────────────────────────────
  // "OP01-016", "ST21-001", "EB03-090", "PRB01-001", "P-001": a set family in
  // letters, a 2-digit set number, and a 3-digit card number. The separator and
  // the zero padding are both optional to type, so "op1-16", "op01 016" and
  // "op01016" all reach the same card.
  //
  // One digit run is the ambiguous case, and the set family settles it. Every
  // family but one numbers its sets -- OP01, ST21, EB03, PRB01 -- so a lone
  // "op17" is a SET, not a card. "P" is the exception: promos have no set
  // number, so "P-001" is a card. Getting this backwards is not a near miss;
  // it turns "op17 booster box" into a search for the card OP01-007.
  var CODE_RE = /^([a-z]{1,4})[-\s]?(\d{1,5})(?:[-\s](\d{1,4}))?$/i;
  var PROMO_FAMILY = /^p$/i;

  function pad(n, w) { n = String(n || ""); return n.length >= w ? n : "0000".slice(0, w - n.length) + n; }

  // { family, set, card } for anything ID-shaped, else null. `card` is "" for a
  // bare set code, which is what a sealed-product search is asking about.
  function splitCode(tok) {
    var m = CODE_RE.exec(String(tok || ""));
    if (!m) return null;
    var family = m[1].toUpperCase();
    if (m[3]) return { family: family, set: m[2], card: m[3] };
    if (PROMO_FAMILY.test(family)) return { family: family, set: "", card: m[2] };
    // No separator and enough digits to hold both halves: "op01016".
    if (m[2].length >= 4) return { family: family, set: m[2].slice(0, 2), card: m[2].slice(2) };
    return { family: family, set: m[2], card: "" };
  }

  function looksLikeCode(tok) { return !!splitCode(tok); }

  // Is this a set family the game actually has? familyList() reads them off the
  // catalogue, so a new set brings its own family along and nothing here has to
  // be kept by hand.
  function knownFamily(family) {
    return familyList().indexOf(String(family || "").toLowerCase()) !== -1;
  }

  // Printed form, which is also the form eBay sellers put in their titles.
  function canonCode(tok) {
    var p = splitCode(tok);
    if (!p) return String(tok || "").toUpperCase();
    if (!p.card) return p.family + pad(p.set, 2);
    return p.family + (p.set ? pad(p.set, 2) : "") + "-" + pad(p.card, 3);
  }

  // Comparison form: letters and digits only, so a typed fragment can be
  // prefix-matched against a full ID without the dash getting in the way.
  function looseCode(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // The shapes a typed fragment might have been aiming at: as typed, and
  // zero-padded the way the card is printed. "op1-16" only reaches OP01-016
  // through the padded form; a half-typed "op01-0" only through the raw one.
  function codeKeys(tok) {
    var keys = [looseCode(tok)];
    var p = splitCode(tok);
    if (p && p.card) {
      [p.family + pad(p.set, 2) + pad(p.card, 3),
       p.family + pad(p.set, 2) + p.card].forEach(function (v) {
        v = looseCode(v);
        if (v && keys.indexOf(v) === -1) keys.push(v);
      });
    }
    return keys.filter(Boolean);
  }

  // ── ID repair: O vs 0, and the missing dash ───────────────
  // Two things go wrong when a card ID is typed on a phone, and both are
  // repairable without guessing, because the ID shape is rigid: a set family in
  // LETTERS, then digits, and nothing else.
  //
  //   the wrong O    "0P01-016", "OPO1-016", "OP01-O16" are all OP01-016. The
  //                  ID is a dense mix of the letter O and the digit 0 -- the
  //                  commonest family is literally "OP" and the numbers next to
  //                  it are full of zeroes -- and the two keys sit side by side.
  //   the missing -  "op01 021" is OP01-021; "p 150" is P-150.
  //
  // Both are settled by the same fact: there are exactly five set families, and
  // they come from the catalogue rather than a hand-kept list, so a new set
  // brings its family along with it. A token only counts as an ID if its
  // leading run IS one of those families (reading O and 0 as the same
  // character) and everything after it is digits once the O's are flipped back.
  // That one rule replaces the old denylist of words-that-precede-a-number:
  // "psa 10" cannot join because "psa" is not a family, and "robin" is not
  // repaired because "-obin" is not a number. A token that fails is handed back
  // untouched, so a character's name is never "corrected".
  var FALLBACK_FAMILIES = ["OP", "ST", "EB", "PRB", "P"];
  var families = null;

  function familyList() {
    if (families) return families;
    var seen = {};
    rows().forEach(function (r) {
      var m = /^([A-Za-z]+)/.exec(String(r[1] || ""));
      if (m) seen[m[1].toLowerCase()] = 1;
    });
    families = Object.keys(seen);
    if (!families.length) families = FALLBACK_FAMILIES.map(function (f) { return f.toLowerCase(); });
    // Longest first, or "PRB01-001" is read as the promo family P followed by
    // a number that isn't one.
    families.sort(function (a, b) { return b.length - a.length; });
    return families;
  }

  // Lowercase ID with its separator normalised to a dash, or null if the token
  // is not ID-shaped. A bare family ("op") comes back as itself, so it can
  // still pick up the number typed after it.
  function repairCode(tok) {
    var low = String(tok || "").toLowerCase();
    var fams = familyList();
    for (var i = 0; i < fams.length; i++) {
      var f = fams[i];
      // O and 0 are the same character for the purpose of finding the family.
      if (low.slice(0, f.length).replace(/0/g, "o") !== f) continue;
      var rest = low.slice(f.length).replace(/o/g, "0");
      if (!rest) return f;
      // O's become zeroes only when at least one REAL digit was typed. Without
      // that guard the repair invents IDs out of ordinary words: "po" reads as
      // the promo card P-000 and "sto" as the set ST00, because every letter
      // after the family happens to be an O. Harmless while you are mid-word
      // inside a One Piece search -- but the game detector asks this same
      // question of every keystroke in the box, and "Poliwag" and "Stoutland"
      // were bouncing the tab to One Piece on their third character and back
      // on their fourth. One typed digit is what separates a mistyped ID from
      // a word that merely starts like one.
      if (!/[0-9]/.test(low)) continue;
      var m = /^[-.]?(\d{1,5})(?:[-.](\d{1,4}))?$/.exec(rest);
      if (!m) continue;
      return f + m[1] + (m[2] ? "-" + m[2] : "");
    }
    return null;
  }

  // A lone card number, possibly with O's typed for zeroes.
  function asNumber(tok) {
    var v = String(tok == null ? "" : tok).toLowerCase().replace(/o/g, "0");
    return /^\d{1,4}$/.test(v) ? v : null;
  }

  // The pre-pass: repair every ID-shaped token, and glue a family to the number
  // typed after it. Runs before tokenising, because once the halves are
  // separate tokens they are parsed as unrelated things and the card is lost.
  function normalizeIds(str) {
    var parts = String(str == null ? "" : str).split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var fixed = repairCode(parts[i]);
      var num = fixed ? asNumber(parts[i + 1]) : null;
      // Only a family that does not already carry a card number can take one:
      // "op01-016 10" is an ID followed by a grade, not a longer ID.
      if (num !== null && !(splitCode(fixed) || {}).card) {
        out.push(fixed + "-" + num);
        i++;
        continue;
      }
      out.push(fixed || parts[i]);
    }
    return out.join(" ");
  }

  // Does this text carry a real One Piece card ID or set code?
  //
  // parseQuery().code answers a looser question on purpose: inside a One Piece
  // search, anything ID-SHAPED is an ID, because nothing else in the box looks
  // like one. Asked from outside -- by the game detector, which has to decide
  // whether the box is even a One Piece search -- shape alone is not enough:
  // a Pokemon promo number is spelled "SWSH050", which is letters-then-digits
  // and therefore ID-shaped, and mistaking it for a set code would drag the app
  // out of Pokemon mid-word.
  //
  // The set family is what separates them, and repairCode already checks the
  // typed family against the ones the catalogue actually ships (OP, ST, EB,
  // PRB, P). Nothing in Pokemon is spelled that way, so a token that clears it
  // AND carries a number is a One Piece code and not a coincidence.
  function hasCode(raw) {
    var parts = normalizeIds(String(raw == null ? "" : raw).toLowerCase().replace(/[,#]/g, " "))
      .split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var fixed = repairCode(parts[i]);
      if (!fixed) continue;
      var p = splitCode(fixed);
      // A bare family ("op", "st") is not a code -- it is two letters that
      // happen to lead one, and on their own they name nothing.
      if (p && (p.card || p.set)) return true;
    }
    return false;
  }

  // ── Character names ───────────────────────────────────────
  // The name goes to eBay as it was typed, whole.
  //
  // It used to be trimmed to its final real word -- "monkey.d.luffy" ->
  // "luffy", "trafalgar law" -> "law" -- on the theory that eBay titles use the
  // short famous form and every extra word is listings lost. That theory is
  // right about which search is WIDEST and wrong about whose decision it is.
  // Two costs, one of them invisible:
  //
  //   it overrode you   The name is the one part of the query typed out in
  //                     full, in a box whose whole promise is that the search
  //                     is what you typed. Deleting most of it, silently, is
  //                     the app disagreeing about the card in your hand -- and
  //                     you are the one holding it.
  //   it contradicted   A sealed search sends the set's whole name ("The
  //   the other half    World's Strongest Warriors"), never one word of it. Two
  //                     branches of one function, two answers to "how much of
  //                     the name do we keep".
  //
  // So: nothing is trimmed anywhere now. Typing "luffy" still gets the wide
  // net, because that is still what you typed.
  var TREAT_FILLER = /^(art|rare|foil|card|parallel|edition)$/;

  // ── Query parsing ─────────────────────────────────────────
  // Turns whatever was typed into the parts that mean something:
  //
  //   "PSA 10 Nami OP01-016 aa nm"
  //     -> code "OP01-016", treat AA, treatWords ["aa"], name ["nami"],
  //        extras ["psa","10","nm"]
  //
  // Never throws. A query it cannot make sense of comes back as name words and
  // no code, which is exactly what a free-text eBay search should be.
  function parseQuery(raw) {
    var tokens = normalizeIds(String(raw == null ? "" : raw).toLowerCase().replace(/[,#]/g, " "))
      .split(/\s+/).filter(Boolean);
    var out = { code: "", codeRaw: "", treat: null, treatWords: [], treatCodes: [],
                lang: "", name: [], extras: [], sealed: false, setCode: "" };
    var treatAt = -2;   // index of the last treatment token, for absorbing "art"
    // Printing tags are collected rather than settled here: which typed token
    // is really the printing cannot be known until the card ID has been read,
    // and the ID may be typed last. `slots` keeps the name in typing order with
    // a tag's place held open, so a tag that turns out to be part of the
    // character's name drops back into the name where it was typed.
    var tags = [], slots = [], current = null;

    tokens.forEach(function (tok, i) {
      if (BY_SHORTHAND[tok] && !(tok === "sd" || tok === "st")) {
        // A treatment tag. "sp" is both a treatment and nothing else, so it is
        // safe; "sd"/"st" are product words and are handled below.
        current = { tok: tok, def: BY_SHORTHAND[tok], tokens: [tok],
                    words: BY_SHORTHAND[tok].quiet ? [] : [tok] };
        tags.push(current);
        slots.push(current);
        treatAt = i;
        return;
      }
      // "art" in "alt art", "rare" in "treasure rare": filler that only means
      // anything attached to the tag in front of it. Kept when it was typed --
      // the rule is to pass wording through, not to invent or delete it -- but
      // never allowed to fall through and be mistaken for a character's name.
      if (TREAT_FILLER.test(tok) && i === treatAt + 1 && current) {
        current.tokens.push(tok); current.words.push(tok); treatAt = i; return;
      }
      // Deferred for the same reason a printing tag is: "Swallow Bond en Avant
      // OP15-096" is a card whose NAME contains "en", and until the ID has been
      // read there is no way to know that. Read eagerly it cost twice over --
      // the name lost a word, and a "jp" typed after it was ignored, because
      // the name had already claimed the language slot as English.
      if (LANGS[tok]) {
        current = null;
        slots.push({ lang: LANGS[tok], tok: tok, tokens: [tok] });
        return;
      }
      if (PRODUCTS[tok]) { out.sealed = true; out.extras.push(PRODUCTS[tok]); return; }
      var split = splitCode(tok);
      // ID-SHAPED is not the same as an ID. "Deathly Poison Gas Bomb MH5" is a
      // card name, and "MH5" is letters-then-digits, so the set-code branch
      // below used to swallow it whole -- the query lost a word of the card's
      // own name and gained nothing, because a set code is ignored once a card
      // ID has been read. The set families are known (they come from the
      // catalogue, see familyList), so the shape can be checked against them.
      if (split && !knownFamily(split.family)) split = null;
      if (split) {
        // A full ID pins the card; a bare set code ("OP17") only pins the set,
        // which is what a sealed-product search is asking about. codeRaw keeps
        // the fragment as typed, because a half-finished ID still has to
        // prefix-match the catalogue while canonCode has already padded it out.
        if (split.card && !out.code) {
          out.code = canonCode(tok); out.codeRaw = tok; return;
        }
        if (!split.card && !out.setCode) { out.setCode = canonCode(tok); return; }
      }
      if (GRADERS.test(tok) || CONDITIONS.test(tok) || /\d/.test(tok)) { out.extras.push(tok); return; }
      slots.push(tok);
    });

    var chosen = chooseTreatment(tags, out.code);
    slots.forEach(function (slot) {
      if (typeof slot === "string") { out.name.push(slot); return; }
      if (slot.lang) {
        // A language word that is part of what the card is CALLED is not a
        // claim about the print run. The first real one wins, as before.
        if (isNameWord(out.code, slot.tok)) out.name.push(slot.tok);
        else out.lang = out.lang || slot.lang;
        return;
      }
      if (slot.isName) {
        // Never a printing: it is what the card is called. Back into the name,
        // in the position it was typed.
        slot.tokens.forEach(function (t) { out.name.push(t); });
        return;
      }
      if (slot === chosen) out.treat = slot.def;
      slot.words.forEach(function (w) { out.treatWords.push(w); });
      // Every printing named in the box, not just the one being searched for.
      // Two printings cannot both be the card in your hand, so only one is
      // asked for -- but one you NAMED is one the query must never subtract,
      // and the word you typed is not always the word the veto table would use.
      if (out.treatCodes.indexOf(slot.def.code) === -1) out.treatCodes.push(slot.def.code);
    });

    if (SEALED_RE.test(String(raw || ""))) out.sealed = true;
    return out;
  }

  // Which of the typed tags is the printing, once the card ID is known.
  //
  // Two questions the catalogue can answer and a bare token cannot:
  //
  //   is it a printing at all?   "Vinsmoke Judge OP06-062 aa" has two tag-shaped
  //                              words in it and one of them is the character.
  //                              Before this, "judge" won for being first, the
  //                              "aa" was dropped, an alternate art was searched
  //                              and badged as a Judge promo -- and the dropdown
  //                              showed nothing at all, because it filtered the
  //                              catalogue to Judge promos of a card with none.
  //   which printing exists?     Between two real tags, the one the number
  //                              actually carries wins.
  //
  // A number the catalogue does not know gets the old rule, first tag wins:
  // guessing from an empty catalogue is how a half-typed ID starts rewriting
  // the box. And when the catalogue knows the number but carries none of the
  // printings typed, the first still wins -- the card in your hand outranks a
  // catalogue of English prints, and `badge` says so rather than the search
  // quietly disagreeing with you.
  function chooseTreatment(tags, code) {
    if (!tags.length) return null;
    var have = treatmentsFor(code);
    if (!have) return tags[0];

    var real = [];
    tags.forEach(function (t) {
      if (isNameWord(code, t.tok)) t.isName = true;
      else real.push(t);
    });
    if (!real.length) return null;
    for (var i = 0; i < real.length; i++) {
      if (have.indexOf(real[i].def.code) !== -1) return real[i];
    }
    return real[0];
  }

  // What recents and the saved-comp search need: the same {name, number, total}
  // shape index.html's Pokemon parser returns, so one matcher serves both games.
  // The card ID plays the part of the collector number.
  function parseForRecents(raw) {
    var p = parseQuery(raw);
    return { name: p.name.join(" "), number: canon(p.code || p.setCode || ""), total: "" };
  }

  // ── eBay keyword string ───────────────────────────────────
  // Thin on purpose. eBay ANDs every word and has no working OR, so the only
  // lever is how few words are sent, and every one of them has to be a word a
  // seller plausibly typed. What comes out is, in order:
  //
  //   the card ID          OP01-016      the one token that pins the card
  //   the character name   monkey.d.luffy   whole, exactly as typed
  //   the printing        (alt,alternate,parallel) -sp   for the two printings
  //                        that share an ID; any other tag exactly as typed
  //   the language        (japanese,jap,jp,jpn), or the negated group that
  //                        leaves the English pool standing
  //   anything else typed  psa 10, nm    in the order it was typed
  //
  // Two things ARE excluded now, and both are exclusions the ID cannot make on
  // its own: the other printing of a shared number (see PRINT_SEARCH) and the
  // other languages of it (see LANGS). Everything else is still passed through
  // as typed -- no tag is spelled out and no name is trimmed. The name
  // is kept even though the ID alone is unique: "OP01-016" is unique to the
  // CARD, but plenty of sellers put the character and no ID in the title at
  // all, and the ID is not what a buyer searched. How wide that net is stays in
  // the typist's hands -- the same rule the sealed branch above already follows
  // when it sends a set's full name.
  function buildQuery(raw) {
    var p = parseQuery(raw);

    // Sealed: a set code means the set's NAME, because that is how boxes are
    // titled. Nobody lists "OP17 booster box"; they list "The World's Strongest
    // Warriors Booster Box".
    if (p.sealed && !p.code) {
      var setName = p.setCode ? setNameFor(p.setCode) : "";
      if (!setName) return String(raw || "");
      // The language belongs here for exactly the reason it belongs on a card.
      // A Japanese booster box of a set is a different product from the English
      // one at a different price, both are titled with the set's name, and the
      // set name alone returns both -- and the box is the bigger ticket of the
      // two, so getting it wrong costs more. It used to be dropped outright:
      // "op17 bbx jp" searched the English box and threw the "jp" away.
      return ["one piece", setName].concat(p.extras, p.name, [langTerms(p.lang)])
        .join(" ").trim();
    }

    var parts = [];
    if (p.code) {
      // A promo ID is just "P-001": two tokens, neither distinctive, which on
      // its own returns half of eBay. Only that shape needs the game name.
      if (/^[A-Z]+-/.test(p.code) && !/\d/.test(p.code.split("-")[0])) parts.push("one piece");
      parts.push(p.code);
    }
    parts = parts.concat(p.name, printTerms(p, typedWords(raw)), p.extras);

    // Nothing recognisable was typed -- a free-text search this module has no
    // business rewriting. Hand back exactly what was in the box. Checked
    // BEFORE the language goes on, or the empty query would come back as a
    // page of exclusions and nothing to exclude them from.
    if (!parts.length) return String(raw || "");

    // Every card query carries a language, typed or not: an untyped one means
    // English, and for One Piece that is a claim about the card rather than a
    // silence -- the Japanese print of this exact ID is on the same page, at a
    // different price. It goes last so the words a title is matched on read
    // first in the box.
    parts.push(langTerms(p.lang));

    var seen = {};
    return parts.join(" ").split(/\s+/)
      .filter(function (w) { return w && !seen[w] && (seen[w] = 1); })
      .join(" ");
  }

  // The chip under the search box: says, in words, which printing the query is
  // actually asking eBay for. "" when nothing One-Piece-specific was typed.
  function badge(raw) {
    var p = parseQuery(raw);
    if (!p.code) return "";
    var label = p.treat ? p.treat.label : "Base Print";
    // The catalogue knows every English printing of every number, so it can say
    // when the tag you typed names a card that does not exist -- "op09-001
    // manga" when OP09-001 was only ever printed plain and alternate. The
    // search still runs exactly as typed: the catalogue is English-only, the
    // card in your hand is the authority, and a printing it has not heard of is
    // a question rather than an answer. But an empty results page reads as "no
    // sales" when it actually means "no such card", and those are worth
    // telling apart.
    if (p.treat && p.treat.code !== "BASE") {
      var have = treatmentsFor(p.code);
      if (have && have.indexOf(p.treat.code) === -1) return label + " — not on this number";
    }
    return label;
  }

  // ── Catalogue ─────────────────────────────────────────────
  // cards_op.js declares CARDS_OP with `const`, which puts it in the global
  // LEXICAL scope rather than on `window` -- so it has to be reached by bare
  // name, exactly as index.html reaches CARDS. Going through root.CARDS_OP
  // silently finds undefined and leaves the catalogue looking empty.
  function rows() {
    return (typeof CARDS_OP !== "undefined" && CARDS_OP) ? CARDS_OP : [];
  }
  function ready() { return rows().length > 0; }

  // Set code -> set name, built once from the card IDs themselves so it can
  // never disagree with the catalogue it came from.
  var setNames = null;
  function setNameFor(code) {
    if (!setNames) {
      setNames = {};
      // Only a row from the set's OWN release names it. A promo product
      // reprints cards from every set, so keying on the card ID alone would
      // have "OP17" answering "Premium Card Collection".
      rows().forEach(function (r) {
        if (r[7] && !setNames[r[7]]) setNames[r[7]] = r[4];
      });
    }
    return setNames[String(code || "").toUpperCase()] || "";
  }

  // Search the bundled catalogue. cores are lowercase name fragments (from
  // index.html's nameCores, so punctuation in "Monkey.D.Luffy" never blocks a
  // match); every one has to appear in the name. A typed ID prefix-matches.
  //
  // Rows come back in catalogue order, which is newest set first, so the
  // printing you are most likely holding is near the top before any ranking.
  function search(raw, limit) {
    var all = rows();
    if (!all.length) return null;
    var p = parseQuery(raw);
    var keys = (p.codeRaw || p.setCode) ? codeKeys(p.codeRaw || p.setCode) : null;

    var out = scan(all, nameCores(p.name.join(" ")), keys, p.treat, limit);

    // Nothing found, and a printing tag was claimed: the tag may have been part
    // of the character's name all along. `parseQuery` settles that from the
    // catalogue, but only once a card ID has been typed -- and a name search is
    // exactly the case where there is no ID yet. "vinsmoke judge" returned
    // nothing at all, because "judge" filtered the catalogue to Judge promos of
    // a card that has none, and the name was searched as "vinsmoke".
    //
    // Only ever a second pass, never the first, so a real tag still narrows the
    // list: "nami op01-016 aa" does not fall back to every Nami printing.
    if (!out.length && p.treatWords.length) {
      out = scan(all, nameCores(p.name.concat(p.treatWords).join(" ")), keys, null, limit);
    }
    return out;
  }

  function scan(all, cores, keys, treat, limit) {
    if (!cores.length && !keys) return [];

    var out = [];
    for (var i = 0; i < all.length && out.length < (limit || 60); i++) {
      var c = all[i];
      var ok = true;
      for (var j = 0; j < cores.length; j++) {
        if (c[6].indexOf(cores[j]) === -1) { ok = false; break; }
      }
      if (!ok) continue;
      if (keys) {
        var id = looseCode(c[1]), hit = false;
        for (var k = 0; k < keys.length; k++) {
          if (id.indexOf(keys[k]) === 0) { hit = true; break; }
        }
        if (!hit) continue;
      }
      // A typed treatment filters the list rather than just colouring it: once
      // you have said "aa", the plain print is not what you are pricing.
      if (treat && treat.code !== "BASE" && c[3] !== treat.code) continue;
      if (treat && treat.code === "BASE" && c[3]) continue;
      out.push(toRow(c));
    }
    return out;
  }

  // One catalogue row -> one dropdown row. `fill` is what lands back in the
  // search box when the row is picked: name first so the box stays readable,
  // then the ID, then the shorthand for the printing. All three reach eBay as
  // they land here -- what the box says is what gets searched.
  function toRow(c) {
    var t = c[3] ? BY_CODE[c[3]] : null;
    var tag = t ? t.type[0] : "";
    return {
      // True when this is the printing the card number was minted in, as
      // opposed to a later promo reprint of the same number. Used only to break
      // ties in the dropdown, where the original is the likelier card in hand.
      orig: !!c[7] && String(c[1]).split("-")[0].toUpperCase() === c[7],
      name: c[0],
      num: c[1],
      set: c[4],
      rarity: c[2],
      treat: c[3],
      label: t ? t.label : "",
      fill: (c[0] + " " + c[1] + (tag ? " " + tag : "")).trim(),
      src: ""
    };
  }

  // Same splitter index.html uses, duplicated rather than imported so this file
  // stays testable on its own. Sub-words under 2 characters are dropped except
  // the last, which is the prefix still being typed.
  function nameCores(name) {
    var words = String(name || "").trim().split(/\s+/).filter(Boolean);
    var cores = [];
    words.forEach(function (w, wi) {
      var subs = w.split(/[^0-9a-zÀ-￿]+/i).filter(Boolean);
      subs.forEach(function (sub, si) {
        var isFinal = wi === words.length - 1 && si === subs.length - 1;
        if (sub.length >= 2 || isFinal) cores.push(sub.toLowerCase());
      });
    });
    return cores;
  }

  root.OnePiece = {
    setCanon: setCanon,
    parseQuery: parseQuery,
    parseForRecents: parseForRecents,
    buildQuery: buildQuery,
    badge: badge,
    search: search,
    ready: ready,
    setNameFor: setNameFor,
    canonCode: canonCode,
    looksLikeCode: looksLikeCode,
    hasCode: hasCode,
    treatments: TREATMENTS,
    base: BASE
  };
})(typeof window !== "undefined" ? window : this);
