/* StampStack neutered stand-in for Google Analytics (analytics.js / ga.js / gtm.js).
   Implements the public surface pages call so nothing throws, but sends no beacons. */
(function () {
  'use strict';
  const noop = function () {};

  // Classic ga.js / analytics.js
  function ga() {
    const a = arguments;
    // ga('create', ...) with a callback / ga(function(){}) — invoke callbacks so page
    // code waiting on the tracker continues.
    if (a.length && typeof a[0] === 'function') {
      try { a[0](); } catch (_) {}
    }
    if (a.length && typeof a[a.length - 1] === 'object' && a[a.length - 1] &&
        typeof a[a.length - 1].hitCallback === 'function') {
      try { a[a.length - 1].hitCallback(); } catch (_) {}
    }
  }
  ga.create = function () { return { get: noop, set: noop, send: noop }; };
  ga.getByName = function () { return null; };
  ga.getAll = function () { return []; };
  ga.remove = noop;
  ga.loaded = true;
  ga.q = [];
  window.ga = window.ga || ga;
  window.GoogleAnalyticsObject = 'ga';
  window._gaq = { push: noop, _getAsyncTracker: function () {
    return { _getLinkerUrl: function (u) { return u; }, _trackEvent: noop, _trackPageview: noop };
  } };

  // gtag.js
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
})();
