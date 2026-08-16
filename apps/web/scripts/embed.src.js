/**
 * Growth OS embed loader.
 *
 * ⚠️ THIS RUNS ON A CUSTOMER'S WEBSITE. It is third-party code with our name on
 * it, next to their content and their customers, on a page we cannot test.
 *
 * SO IT DOES AS LITTLE AS POSSIBLE. Read its own attributes, insert an iframe,
 * listen for one resize message. That is the entire host-page footprint —
 * under 1 KB, no dependencies, no framework.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - read the host page's DOM, forms, or inputs
 *   - read or write cookies of any kind
 *   - execute anything the host page provides
 *   - send anything anywhere (the iframe owns its own network calls)
 *   - define globals beyond one guarded namespace
 *
 * The isolation is STRUCTURAL, not promised: the form lives on our origin, so
 * the host cannot read what a visitor types into it and we cannot read their
 * page. That is the whole reason for an iframe over a script embed (ADR-0027).
 *
 * Built to public/scripts/embed.js by `npm run build:embed`. Source is tracked;
 * the build output is generated and gitignored.
 */
(function () {
  'use strict';

  // Guard against double inclusion — a customer with two forms includes the
  // script twice, and a CMS may inject it again on soft navigation.
  if (window.__growthOsEmbed) return;
  window.__growthOsEmbed = true;

  var ORIGIN = '__GROWTH_OS_ORIGIN__';

  function mount(script) {
    var key = script.getAttribute('data-growth-form');
    // A malformed key is ignored silently rather than logged. A console error
    // on a customer's production site, from our script, over a typo in their
    // own markup, is not our place.
    if (!key || !/^[0-9a-f]{32}$/.test(key)) return;

    var theme = script.getAttribute('data-growth-theme') || '';
    var query = theme === 'light' || theme === 'dark' ? '&theme=' + theme : '';

    var frame = document.createElement('iframe');
    frame.src = ORIGIN + '/f/' + key + '?embed=1' + query;
    frame.title = 'Contact form';
    frame.loading = 'lazy';
    frame.style.cssText = 'width:100%;border:0;display:block;min-height:320px;color-scheme:normal';
    // `allow-top-navigation` is NOT granted: a compromised form can never
    // redirect the customer's visitor away from their own site.
    frame.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups');
    frame.setAttribute('data-growth-form', key);

    script.parentNode.insertBefore(frame, script.nextSibling);

    window.addEventListener('message', function (event) {
      // VALIDATED, unlike the outbound message. Three checks, because a page
      // may contain many frames and several unrelated postMessage senders:
      //   1. it came from OUR origin
      //   2. it came from THIS frame
      //   3. it names THIS form
      if (event.origin !== ORIGIN) return;
      if (event.source !== frame.contentWindow) return;

      var data = event.data;
      if (!data || data.source !== 'growth-os' || data.type !== 'resize') return;
      if (data.formKey !== key) return;

      var height = Number(data.height);
      // Bounded. A hostile or buggy message must not be able to create a
      // 10-million-pixel element on someone's page.
      if (!isFinite(height) || height < 100 || height > 5000) return;

      frame.style.height = height + 'px';
    });
  }

  var scripts = document.querySelectorAll('script[data-growth-form]');
  for (var i = 0; i < scripts.length; i++) mount(scripts[i]);
})();
