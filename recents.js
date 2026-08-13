// Recent searches: the cards you actually looked up, ranked above everything
// else in the autocomplete, and synced across your devices through a private
// GitHub gist.
//
// Why a gist: this app is a static page on GitHub Pages -- there is no server
// to sync through. A secret gist is a free, already-yours key/value store that
// a static page can read and write directly. The token is entered once per
// device and lives only in that device's localStorage; it is never in the repo
// and never in the published HTML.
//
// Everything degrades cleanly: no token means no sync and a purely local list,
// and every network failure is swallowed so the dropdown keeps working offline.

(function (root) {
  "use strict";

  var LS_ITEMS = "recentSearches";
  var LS_TOKEN = "syncToken";
  var LS_GIST = "syncGistId";
  var LS_PULLED = "syncLastPull";
  var LS_ETAG = "syncEtag";     // lets an unchanged pull come back as a 304
  var LS_DIRTY = "syncDirty";   // survives a reload, so an unsent change isn't lost

  // Local cap. 2000 rows is ~160KB of localStorage (limit is ~5MB) and a full
  // scan of it per keystroke is well under a millisecond, so the dropdown stays
  // instant. Oldest entries fall off the end, first-in-first-out.
  var MAX_ITEMS = 2000;
  // Only the newest slice is synced. The whole point of the list is recency, so
  // shipping 2000 rows to every device would cost bandwidth for entries nobody
  // will ever match against.
  var SYNC_ITEMS = 500;

  var GIST_FILE = "pawfect-recents.json";
  var API = "https://api.github.com";

  // Tuned for the real usage pattern: one device does nearly all the searching,
  // the other is opened occasionally. That means the far side almost never has
  // anything new, so polling it hard is pure waste -- and the near side wants
  // its many searches collapsed into as few writes as possible.
  //
  // PUSH_DEBOUNCE is long because leaving the app (visibilitychange -> hidden)
  // force-flushes anyway, so the timer is only a backstop for a session left
  // open. A 20-search session costs ONE write, not twenty.
  var PUSH_DEBOUNCE = 20000;
  // Opening the app always checks (see startAutoSync) -- that's the moment you
  // expect to see the other device's searches, and thanks to the ETag it's
  // normally a bodyless 304 that doesn't even count against the rate limit.
  // This interval only throttles the *re-focus* check, so flicking between
  // windows doesn't produce a request per switch.
  var PULL_INTERVAL = 2 * 60 * 1000;

  var items = load();
  var pushTimer = null;
  var listeners = [];

  // ── Storage ────────────────────────────────────────────────
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_ITEMS) || "[]");
      return Array.isArray(raw) ? raw.filter(valid).sort(byRecent).slice(0, MAX_ITEMS) : [];
    } catch (e) { return []; }
  }

  function valid(it) { return it && typeof it.q === "string" && it.q.length > 0; }
  function byRecent(a, b) { return (b.t || 0) - (a.t || 0); }

  function save() {
    try {
      localStorage.setItem(LS_ITEMS, JSON.stringify(items));
    } catch (e) {
      // Quota exhausted (other keys, a huge history): halve the list and retry
      // once rather than throwing out of a click handler.
      items = items.slice(0, Math.floor(items.length / 2));
      try { localStorage.setItem(LS_ITEMS, JSON.stringify(items)); } catch (e2) {}
    }
  }

  function key(q) { return q.toLowerCase().replace(/\s+/g, " ").trim(); }

  // Collector-number canonicaliser, injected by index.html so there is exactly
  // one definition of "071/072 is 71/72" in the app. Falls back to a plain
  // lowercase if it's never set, which keeps this module standalone.
  var canon = function (s) { return String(s == null ? "" : s).toLowerCase(); };
  function setCanon(fn) { if (typeof fn === "function") canon = fn; }

  // ── Recording ──────────────────────────────────────────────
  // Called when a search is actually run (an eBay button, or desktop Compare) --
  // not on every keystroke. Typing is intent; searching is a decision, and only
  // decisions deserve to outrank the catalog.
  //
  // parse(q) is injected by the caller (index.html's parseCardQuery) so the
  // name/number split used for matching is character-for-character the same one
  // used for card lookups.
  function record(rawQuery, parse) {
    var q = String(rawQuery || "").replace(/\s+/g, " ").trim();
    if (!q) return;
    var k = key(q);
    var parsed = (typeof parse === "function" ? parse(q) : null) || {};
    var num = parsed.number ? (parsed.total ? parsed.number + "/" + parsed.total : parsed.number) : "";
    var now = Date.now();

    var existing = null;
    for (var i = 0; i < items.length; i++) {
      if (key(items[i].q) === k) { existing = items.splice(i, 1)[0]; break; }
    }
    items.unshift({
      q: q,
      nm: (parsed.name || q).toLowerCase(),
      num: num,
      t: now,
      n: (existing && existing.n ? existing.n : 0) + 1
    });
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS; // FIFO: oldest drops off
    save();
    schedulePush();
    emit();
  }

  // ── Matching ───────────────────────────────────────────────
  // Same rules as the local card scan: every typed name-core must appear in the
  // remembered name, and a typed collector number must prefix-match. Results
  // come back strictly newest-first -- searching "pikachu 20/200" then typing
  // "pika" puts 20/200 above the 18/091 you looked up yesterday.
  function match(cores, number, total, limit) {
    var out = [];
    var numLower = canon(number);
    var want = numLower && total ? numLower + "/" + canon(total) : numLower;
    for (var i = 0; i < items.length && out.length < (limit || 6); i++) {
      var it = items[i];
      var nm = it.nm || "";
      var ok = true;
      for (var j = 0; j < cores.length; j++) {
        if (nm.indexOf(cores[j]) === -1) { ok = false; break; }
      }
      if (!ok) continue;
      if (want) {
        // Canonicalised on read, so entries saved before this rule existed
        // (or by an older version on another device) still match.
        var itNum = canon(it.num);
        var parts = itNum.split("/");
        // Match a full "18/091", a partial collector number ("18"), or the set
        // total on its own ("091") — the same three ways the catalog search
        // accepts a number, so recents never behave differently from cards.
        if (itNum.indexOf(want) !== 0
            && parts[0].indexOf(numLower) !== 0
            && !(!total && parts[1] === numLower)) continue;
      }
      out.push(it);
    }
    return out;
  }

  function all() { return items.slice(); }
  function count() { return items.length; }

  function clear() {
    items = [];
    save();
    schedulePush();
    emit();
  }

  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  // ── Merge ──────────────────────────────────────────────────
  // Union by query, newest timestamp wins, search counts add up. Order-
  // independent and idempotent, so two devices that sync in either order (or
  // twice) land on the same list -- which is what lets this work without any
  // server-side coordination.
  // Returns { changed, localOnly } -- `changed` drives a repaint, `localOnly`
  // says whether this device holds searches the remote hasn't got. Without that
  // second answer, a device that opens weekly and searches nothing would still
  // push a full copy back every time just because merging reordered its list.
  function merge(remote) {
    if (!Array.isArray(remote)) return { changed: false, localOnly: false };
    var remoteKeys = {};
    remote.forEach(function (it) { if (valid(it)) remoteKeys[key(it.q)] = true; });
    var localOnly = items.some(function (it) { return !remoteKeys[key(it.q)]; });
    var byKey = {};
    var order = [];
    function put(it) {
      if (!valid(it)) return;
      var k = key(it.q);
      var prev = byKey[k];
      if (!prev) { byKey[k] = { q: it.q, nm: it.nm || it.q.toLowerCase(), num: it.num || "", t: it.t || 0, n: it.n || 1 }; order.push(k); return; }
      prev.n = Math.max(prev.n || 1, it.n || 1);
      if ((it.t || 0) > (prev.t || 0)) { prev.t = it.t; prev.q = it.q; prev.nm = it.nm || prev.nm; prev.num = it.num || prev.num; }
    }
    items.forEach(put);
    remote.forEach(put);
    var mergedList = order.map(function (k) { return byKey[k]; }).sort(byRecent).slice(0, MAX_ITEMS);
    var changed = mergedList.length !== items.length
      || mergedList.some(function (it, i) { return key(it.q) !== key(items[i].q) || it.t !== items[i].t; });
    items = mergedList;
    if (changed) { save(); emit(); }
    return { changed: changed, localOnly: localOnly };
  }

  // ── Sync (GitHub gist) ─────────────────────────────────────
  var syncState = { status: "off", message: "", busy: false };
  // Read from storage every time rather than caching in a variable: markSynced
  // writes there, a second tab may write there, and a reload starts fresh. One
  // source of truth means the interval can't silently drift out of sync with
  // what was actually recorded.
  function lastPullAt() { return Number(localStorage.getItem(LS_PULLED) || 0); }

  function token() { return localStorage.getItem(LS_TOKEN) || ""; }
  function gistId() { return localStorage.getItem(LS_GIST) || ""; }
  function isConfigured() { return !!token(); }

  // Deduped rather than conditional: the message is always kept truthful, and
  // silence comes from there being nothing new to say. An earlier version
  // skipped the update entirely while already "ok", which left the panel
  // reporting a stale count ("Synced 0 searches" with two in hand).
  function setState(status, message) {
    message = message || "";
    if (syncState.status === status && syncState.message === message) return;
    syncState.status = status;
    syncState.message = message;
    emit();
  }
  function getState() {
    return {
      status: syncState.status,
      message: syncState.message,
      configured: isConfigured(),
      gistId: gistId(),
      lastSync: Number(localStorage.getItem(LS_PULLED) || 0),
      pending: isDirty()
    };
  }

  // Low-level call that exposes the status and ETag, so a conditional GET can
  // come back as a bodyless 304. `cache: "no-store"` keeps the browser's own
  // HTTP cache out of it -- we want OUR validator on the wire and the real
  // status handed back, not a silently replayed cached response.
  function ghRaw(path, opts) {
    opts = opts || {};
    var headers = {
      "Authorization": "Bearer " + token(),
      "Accept": "application/vnd.github+json"
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      var etag = r.headers.get("ETag") || "";
      if (r.status === 304) return { status: 304, etag: etag, body: null };
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error("GitHub " + r.status + ": " + t.slice(0, 120));
        });
      }
      return r.json().then(function (b) { return { status: r.status, etag: etag, body: b }; });
    });
  }

  function gh(path, opts) {
    return ghRaw(path, opts).then(function (r) { return r.body; });
  }

  // Connect a device. Given only the token, find the gist this app already
  // created (identified by its filename) and adopt it; create one if there is
  // none. That is what makes the second device a paste-the-same-token job with
  // no ids to copy around.
  function connect(newToken) {
    var t = String(newToken || "").trim();
    if (!t) return Promise.reject(new Error("No token provided"));
    localStorage.setItem(LS_TOKEN, t);
    setState("syncing", "Connecting…");
    return findGist(1, 3)
      .then(function (found) {
        if (found) { localStorage.setItem(LS_GIST, found.id); return found.id; }
        return gh("/gists", {
          method: "POST",
          body: {
            description: "Pawfect Pricing — recent searches (synced across devices)",
            public: false,
            files: payloadFiles()
          }
        }).then(function (g) { localStorage.setItem(LS_GIST, g.id); return g.id; });
      })
      .then(function () { return pull(true); })
      .then(function () { return push(true); })
      .then(function () { setState("ok", "Synced " + items.length + " searches"); return true; })
      .catch(function (e) {
        // Don't leave a token that didn't work sitting in storage — the setup
        // panel would then render as "connected" with no way to re-enter it.
        if (!gistId()) localStorage.removeItem(LS_TOKEN);
        setState("error", cleanErr(e));
        throw e;
      });
  }

  // Walk the account's gists looking for the one this app made. Paged, because
  // a busy account can push it past the first 100 and a missed match would
  // silently create a second gist — i.e. two devices that never see each other.
  function findGist(page, maxPages) {
    return gh("/gists?per_page=100&page=" + page).then(function (list) {
      if (!list || !list.length) return null;
      var hit = list.find(function (g) { return g.files && g.files[GIST_FILE]; });
      if (hit) return hit;
      if (page >= maxPages || list.length < 100) return null;
      return findGist(page + 1, maxPages);
    });
  }

  function disconnect() {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_GIST);
    setState("off", "");
  }

  function payloadFiles() {
    var files = {};
    files[GIST_FILE] = { content: JSON.stringify({ v: 1, updated: Date.now(), items: items.slice(0, SYNC_ITEMS) }) };
    return files;
  }

  // `quiet` keeps a background sync from touching the visible state at all --
  // no "Checking…" flicker on the badge for something the user didn't ask for.
  // Only the final result is reported, and only if it actually changed.
  function pull(force, quiet) {
    if (!isConfigured() || !gistId()) return Promise.resolve(false);
    var now = Date.now();
    if (!force && now - lastPullAt() < PULL_INTERVAL) return Promise.resolve(false);
    localStorage.setItem(LS_PULLED, String(now));
    if (!quiet) setState("syncing", "Checking…");

    var etag = localStorage.getItem(LS_ETAG) || "";
    return ghRaw("/gists/" + gistId(), { etag: etag })
      .then(function (r) {
        // Any non-throwing response (including a 304) means we're up to date
        // with the remote, which is the precondition for being allowed to
        // write. Errors fall through to .catch and leave this false.
        sessionPulled = true;
        // 304: the gist is byte-for-byte what we already have. No body is
        // transferred and GitHub doesn't count it against the rate limit, so
        // the overwhelmingly common "other device did nothing" case is close
        // to free.
        if (r.status === 304) { markSynced(); return false; }
        if (r.etag) localStorage.setItem(LS_ETAG, r.etag);
        var g = r.body || {};
        var file = g.files && g.files[GIST_FILE];
        if (!file) { markSynced(); return false; }
        // Gists over 1MB come back truncated with a raw_url to fetch instead.
        var body = file.truncated
          ? fetch(file.raw_url).then(function (x) { return x.text(); })
          : Promise.resolve(file.content);
        return Promise.resolve(body).then(function (text) {
          var res = merge(JSON.parse(text || "{}").items || []);
          // We hold searches the remote doesn't -- schedule a write so the
          // other device eventually sees them.
          if (res.localOnly) setDirty(true);
          markSynced();
          return res.changed;
        });
      })
      .catch(function (e) { reportErr(e, quiet); return false; });
  }

  // Writes only happen when this device actually has something new. A device
  // that's opened, reads, and searches nothing never writes at all.
  var pushing = null;      // in-flight write, so two triggers can't both send
  var rev = 0;             // bumped on every local change
  var sessionPulled = false; // has a pull succeeded since this page loaded?

  function push(force) {
    if (!isConfigured() || !gistId()) return Promise.resolve(false);
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!force && !isDirty()) return Promise.resolve(false);
    // Never write on top of a remote we haven't read. If the startup pull
    // failed (offline, token expired), the local changes stay marked dirty and
    // go out on a later run instead of overwriting the other device's work.
    if (!force && !sessionPulled) return Promise.resolve(false);
    // Leaving the app can fire visibilitychange AND pagehide back to back, and
    // `dirty` isn't cleared until the request resolves -- so without this the
    // same payload goes up twice.
    if (pushing) return pushing;

    var sentRev = rev;
    pushing = ghRaw("/gists/" + gistId(), { method: "PATCH", body: { files: payloadFiles() } })
      .then(function (r) {
        // Adopt the ETag from our own write so the next pull 304s immediately
        // instead of downloading back the copy we just uploaded.
        if (r.etag) localStorage.setItem(LS_ETAG, r.etag);
        // Only declare us clean if nothing was recorded while this was in
        // flight; otherwise that newer search would never be sent.
        if (rev === sentRev) setDirty(false);
        else schedulePush();
        markSynced();
        return true;
      })
      .catch(function (e) { reportErr(e, true); return false; })
      .then(function (ok) { pushing = null; return ok; });
    return pushing;
  }

  // Coalesce a burst of searches into one write. The timer is only a backstop:
  // leaving the app flushes immediately (see startAutoSync), which is what
  // normally ends a mobile session.
  function schedulePush() {
    rev += 1;
    setDirty(true);
    if (!isConfigured() || !gistId()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, PUSH_DEBOUNCE);
  }

  function flush() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (isDirty()) push();
  }

  function isDirty() { return localStorage.getItem(LS_DIRTY) === "1"; }
  function setDirty(v) {
    if (v) localStorage.setItem(LS_DIRTY, "1");
    else localStorage.removeItem(LS_DIRTY);
  }

  function markSynced() {
    localStorage.setItem(LS_PULLED, String(Date.now()));
    setState("ok", "Synced " + items.length + " searches");
  }
  function reportErr(e, quiet) {
    // A background failure is not worth shouting about -- the next sync retries
    // and nothing was lost, because the list is local first.
    if (quiet && /Failed to fetch|NetworkError/i.test((e && e.message) || "")) return;
    setState("error", cleanErr(e));
  }

  function cleanErr(e) {
    var m = (e && e.message) || String(e);
    if (/401|Bad credentials/i.test(m)) return "Token rejected — check it has the 'gist' scope";
    if (/403/.test(m)) return "Rate limited or missing 'gist' permission";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Offline — will retry";
    return m.slice(0, 90);
  }

  // All of this runs in the background and never blocks anything: the recent
  // list is rendered from localStorage on the first frame, and a sync can only
  // ever add to what's already on screen.
  var autoSyncStarted = false;
  function startAutoSync() {
    if (!isConfigured()) { setState("off", ""); return; }
    if (autoSyncStarted) return;   // listeners are registered exactly once
    autoSyncStarted = true;

    // ALWAYS pull before pushing, and always on load. A push replaces the whole
    // gist file -- there is no server-side merge -- so sending this device's
    // list before taking in the other device's would silently wipe out every
    // search made elsewhere since we last looked. Anything left unsent by a
    // previous session (app killed mid-debounce) goes out only after that
    // merge, and only if the pull actually succeeded.
    pull(true, true).then(function () {
      if (sessionPulled && isDirty()) push();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        // LEAVING is the reliable moment to write on mobile. iOS frequently
        // skips pagehide/unload when you switch apps, so a pending debounced
        // push would simply be lost; this is the event that actually fires.
        flush();
      } else {
        // Coming back: cheap conditional check, usually a 304.
        pull(false, true);
      }
    });
    // Desktop belt-and-braces; harmless where visibilitychange already fired
    // because flush() is a no-op once there's nothing dirty.
    window.addEventListener("pagehide", flush);
  }

  root.Recents = {
    SYNC_ITEMS: SYNC_ITEMS,
    record: record,
    match: match,
    merge: merge,
    all: all,
    count: count,
    clear: clear,
    onChange: onChange,
    connect: connect,
    disconnect: disconnect,
    pull: pull,
    push: push,
    flush: flush,
    getState: getState,
    isConfigured: isConfigured,
    startAutoSync: startAutoSync,
    setCanon: setCanon
  };
})(typeof window !== "undefined" ? window : globalThis);
