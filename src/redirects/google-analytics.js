/* StampStack neutered stand-in for Google Analytics and Google Tag Manager (analytics.js,
   ga.js, gtm.js, gtag/js). Sends no beacons, but runs what the page queued for the real
   library: ready callbacks, hitCallback / eventCallback / event_callback, and the anti-flicker
   `dataLayer.hide.end()`. Without that a redirect behaves like a block: the page stays at
   opacity 0 until the snippet's timeout, and links that navigate from a callback go nowhere. */
(function () {
  'use strict';
  const w = window;
  const noop = function () {};
  const call = function (fn, arg) {
    try { fn(arg); } catch (_) {}
  };
  // GTM runs eventCallback after its tags fire, never inside the push that queued it.
  const later = function (fn, arg) {
    setTimeout(function () { call(fn, arg); }, 1);
  };

  // --- analytics.js --------------------------------------------------------------------------
  function Tracker() {}
  Tracker.prototype.get = function () { return undefined; };
  Tracker.prototype.set = noop;
  Tracker.prototype.send = function () { runHitCallback(arguments); };

  /** A command's hitCallback: in a fields object, or as `'hitCallback', fn`. */
  function runHitCallback(args) {
    const last = args[args.length - 1];
    if (last && typeof last === 'object' && typeof last.hitCallback === 'function') {
      call(last.hitCallback);
      return;
    }
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === 'hitCallback' && typeof args[i + 1] === 'function') {
        call(args[i + 1]);
        return;
      }
    }
  }

  function ga() {
    if (!arguments.length) return;
    // ga(function (tracker) {}) is the ready callback.
    if (typeof arguments[0] === 'function') {
      call(arguments[0], new Tracker());
      return;
    }
    runHitCallback(arguments);
  }
  ga.create = function () { return new Tracker(); };
  ga.getByName = function () { return new Tracker(); };
  ga.getAll = function () { return [new Tracker()]; };
  ga.remove = noop;
  ga.loaded = true;

  // The snippet may rename the global (`GoogleAnalyticsObject`), and it defines that global as
  // a queue before the library loads. Replace the queue and replay it; a real analytics.js
  // that some exception let through is left alone.
  const gaName = typeof w.GoogleAnalyticsObject === 'string' && w.GoogleAnalyticsObject
    ? w.GoogleAnalyticsObject
    : 'ga';
  const existing = w[gaName];
  const isRealGa = typeof existing === 'function' && existing.loaded === true &&
    typeof existing.create === 'function';
  if (!isRealGa) {
    w[gaName] = ga;
    if (typeof w.GoogleAnalyticsObject !== 'string') w.GoogleAnalyticsObject = gaName;
    const queued = existing && Array.isArray(existing.q) ? existing.q.slice() : [];
    if (existing && Array.isArray(existing.q)) existing.q.length = 0;
    for (const args of queued) {
      try { ga.apply(w, Array.prototype.slice.call(args)); } catch (_) {}
    }
  }

  // --- ga.js (legacy) ------------------------------------------------------------------------
  const LEGACY_METHODS = (
    '_addIgnoredOrganic _addIgnoredRef _addItem _addOrganic _addTrans _clearIgnoredOrganic ' +
    '_clearIgnoredRef _clearOrganic _clearTrans _clearXKey _clearXValue _cookiePathCopy ' +
    '_createEventTracker _deleteCustomVar _getClientInfo _getDetectFlash _getDetectTitle ' +
    '_getLocalGifPath _getServiceMode _getVisitorCustomVar _getXKey _getXValue _initData ' +
    '_linkByPost _setAccount _setAllowAnchor _setAllowHash _setAllowLinker _setCampContentKey ' +
    '_setCampMediumKey _setCampNOKey _setCampNameKey _setCampSourceKey _setCampTermKey ' +
    '_setCampaignCookieTimeout _setCampaignTrack _setClientInfo _setCookiePath ' +
    '_setCookiePersistence _setCookieTimeout _setCustomVar _setDetectFlash _setDetectTitle ' +
    '_setDomainName _setLocalGifPath _setLocalRemoteServerMode _setLocalServerMode ' +
    '_setReferrerOverride _setRemoteServerMode _setSampleRate _setSessionCookieTimeout ' +
    '_setSessionTimeout _setSiteSpeedSampleRate _setVar _setVisitorCookieTimeout _setXKey ' +
    '_setXValue _trackEvent _trackPageLoadTime _trackPageview _trackSocial _trackTiming ' +
    '_trackTrans _visitCode'
  ).split(' ');

  /** `_link` sends the visitor to the URL; a stub that drops it leaves the link dead. */
  function follow(url) {
    if (typeof url !== 'string' || !url) return;
    try { w.location.assign(url); } catch (_) {}
  }

  function legacyTracker() {
    const t = {};
    for (const m of LEGACY_METHODS) t[m] = noop;
    t._getAccount = function () { return ''; };
    t._getName = function () { return ''; };
    t._getVersion = function () { return ''; };
    t._getLinkerUrl = function (url) { return url; };
    t._link = follow;
    return t;
  }

  function runLegacy(cmd) {
    if (typeof cmd === 'function') {
      call(cmd);
      return;
    }
    if (!Array.isArray(cmd) || typeof cmd[0] !== 'string') return;
    // Commands may be prefixed with a tracker name: ['t2._link', url].
    const name = cmd[0].slice(cmd[0].lastIndexOf('.') + 1);
    if (name === '_link') follow(cmd[1]);
    else if (name === '_set' && cmd[1] === 'hitCallback' && typeof cmd[2] === 'function') call(cmd[2]);
  }

  const gaq = w._gaq;
  // ga.js turns the array into an object with its own push. Anything else is not ours to replace.
  if (gaq === undefined || Array.isArray(gaq)) {
    const queued = Array.isArray(gaq) ? gaq.slice() : [];
    w._gaq = {
      push: function () {
        for (let i = 0; i < arguments.length; i++) runLegacy(arguments[i]);
        return 0;
      },
      _createAsyncTracker: legacyTracker,
      _getAsyncTracker: legacyTracker,
    };
    for (const cmd of queued) runLegacy(cmd);
  }
  if (w._gat === undefined) {
    w._gat = {
      _anonymizeIp: noop,
      _createTracker: legacyTracker,
      _forceSSL: noop,
      _getTracker: legacyTracker,
      _getTrackerByName: legacyTracker,
    };
  }

  // --- gtm.js / gtag.js ----------------------------------------------------------------------
  const settled = new WeakSet();
  /** Run the callbacks a dataLayer item asks for once its (absent) tags have fired. */
  function settle(item) {
    if (!item || typeof item !== 'object' || settled.has(item)) return;
    settled.add(item);
    if (typeof item.eventCallback === 'function') later(item.eventCallback);
    // gtag() pushes its `arguments`: ('event' | 'config', id, { event_callback }) and
    // ('get', id, field, callback).
    const cmd = item[0];
    if ((cmd === 'event' || cmd === 'config') && item[2] && typeof item[2].event_callback === 'function') {
      later(item[2].event_callback);
    } else if (cmd === 'get' && typeof item[3] === 'function') {
      later(item[3], undefined);
    }
  }

  // gtm.js and gtag/js take the data layer's name from `l=` (default dataLayer).
  let dlName = 'dataLayer';
  try {
    const src = document.currentScript && document.currentScript.src;
    const l = src ? new URL(src).searchParams.get('l') : null;
    if (l && /^[A-Za-z_$][\w$]*$/.test(l)) dlName = l;
  } catch (_) {}
  if (w[dlName] === undefined) w[dlName] = [];
  const dl = w[dlName];
  if (dl && typeof dl === 'object') {
    // Optimize's anti-flicker snippet keeps <html> at opacity 0 until the container calls this.
    const hide = dl.hide;
    if (hide && typeof hide === 'object' && typeof hide.end === 'function') {
      const end = hide.end;
      hide.end = noop;
      call(end);
    }
    // A real container (gtm.js or gtag.js let through by an exception) defines
    // google_tag_manager and runs these callbacks itself. Otherwise wrap whatever push is there:
    // a consent tool may have hooked it first.
    // This stub also stands in for gtm.js, gtag/js and analytics.js on one page, so it can run
    // several times; only the first wraps, or every callback would run once per copy.
    const WRAPPED = Symbol.for('stampstack.redirect.dataLayer');
    if (Array.isArray(dl) && typeof dl.push === 'function' && !dl.push[WRAPPED] &&
        w.google_tag_manager === undefined) {
      const push = dl.push;
      const wrapper = function () {
        const n = push.apply(this, arguments);
        for (let i = 0; i < arguments.length; i++) settle(arguments[i]);
        return n;
      };
      Object.defineProperty(wrapper, WRAPPED, { value: true });
      dl.push = wrapper;
      for (const item of dl.slice()) settle(item);
    }
  }
  if (typeof w.gtag !== 'function') {
    w.gtag = function () { w[dlName].push(arguments); };
  }
})();
