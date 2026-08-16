/**
 * Growth OS attribution.
 *
 * ⚠️ THIS IS NOT ANALYTICS. It captures the acquisition context for OUR forms
 * and nothing else. There is no pageview beacon, no event API, and no network
 * request of any kind — this script only writes to `sessionStorage`, and the
 * form reads it at submission time.
 *
 * WHAT IT STORES (ADR-0028)
 *   sid             opaque per-tab id, generated here, linked to no person
 *   firstSeenAt     ISO timestamp
 *   landingPath     PATH ONLY — the query string is discarded
 *   referrerOrigin  ORIGIN ONLY — the path and query are discarded
 *   utm*            the five standard campaign parameters
 *   gclid, fbclid   ad-platform click identifiers
 *
 * WHAT IT NEVER COLLECTS
 *   browsing history · page content · other forms' fields · keystrokes ·
 *   mouse movement · session replay · scroll · clicks · cookies of any kind ·
 *   fingerprints · any name, email, phone or message · the landing page's
 *   query string beyond the parameters named above.
 *
 * The path-and-origin truncation is a PII control, not tidiness: query strings
 * routinely carry personal data — a booking confirmation link, an email
 * tracking parameter, a reset token someone pasted.
 *
 * FIRST TOUCH WINS. Written once per tab, then never overwritten, so a visitor
 * who lands on a campaign page and submits from `/contact` is attributed to the
 * campaign rather than to the page the form happened to sit on.
 *
 * STORAGE IS `sessionStorage`: tab lifetime, origin-scoped, never transmitted
 * automatically, and no cookie banner required by us.
 */
(function () {
  'use strict';

  var KEY = 'growth-os.attribution';

  function disabled() {
    try {
      return window.sessionStorage.getItem('growth-os.optout') === '1';
    } catch (e) {
      return false;
    }
  }

  function origin(value) {
    if (!value) return undefined;
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
      // Origin only. A Google referrer's `?q=` is discarded here, deliberately
      // and permanently — see ADR-0012 on why a search query is never inferred.
      return url.origin;
    } catch (e) {
      return undefined;
    }
  }

  function capture() {
    if (disabled()) return;

    var storage;
    try {
      storage = window.sessionStorage;
      // FIRST TOUCH WINS. Present means this tab already has a landing page,
      // and the visitor is simply on another of the customer's pages.
      if (storage.getItem(KEY)) return;
    } catch (e) {
      // Blocked, disabled, private mode, quota. Attribution is unavailable and
      // THE FORM STILL WORKS — a business must never lose an enquiry because a
      // visitor declined tracking (ADR-0028 §5).
      return;
    }

    var params = new URLSearchParams(window.location.search);
    var data = {
      v: 1,
      sid: id(),
      firstSeenAt: new Date().toISOString(),
      // PATH only. The query string this page was loaded with is discarded,
      // except for the specific parameters read below.
      landingPath: window.location.pathname.slice(0, 512),
    };

    var referrer = origin(document.referrer);
    // A referrer from the customer's own site is not an acquisition source —
    // it means the visitor moved between their pages, and recording it would
    // attribute every lead to the site it came from.
    if (referrer && referrer !== window.location.origin) data.referrerOrigin = referrer;

    var utm = ['source', 'medium', 'campaign', 'term', 'content'];
    for (var i = 0; i < utm.length; i++) {
      var value = params.get('utm_' + utm[i]);
      if (value) {
        data['utm' + utm[i].charAt(0).toUpperCase() + utm[i].slice(1)] = value.slice(0, 255);
      }
    }

    var gclid = params.get('gclid');
    if (gclid) data.gclid = gclid.slice(0, 255);
    var fbclid = params.get('fbclid');
    if (fbclid) data.fbclid = fbclid.slice(0, 255);

    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      /* Storage full or blocked. Attribution is best-effort, always. */
    }
  }

  function id() {
    try {
      var bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    } catch (e) {
      // Not security-sensitive: `sid` correlates a first touch with a
      // submission inside one tab and identifies nobody.
      return String(Date.now()) + String(Math.floor(Math.random() * 1e9));
    }
  }

  /**
   * The consent hook.
   *
   * Callable from a consent manager before or after load. Documented rather
   * than automated: we do not know the customer's jurisdiction and will not
   * guess one (ADR-0028 §6).
   */
  window.GrowthOS = window.GrowthOS || {};
  window.GrowthOS.disableAttribution = function () {
    try {
      window.sessionStorage.setItem('growth-os.optout', '1');
      window.sessionStorage.removeItem(KEY);
    } catch (e) {
      /* Nothing to disable if storage is unavailable. */
    }
  };

  capture();
})();
