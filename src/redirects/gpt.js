/* StampStack neutered stand-in for Google Publisher Tag (googletagservices gpt.js).
   Reproduces the googletag API shape so page scripts run, but defines no ad slots. */
(function () {
  'use strict';
  const noop = function () {};
  const noopThis = function () { return this; };

  function makeSlot() {
    const slot = {
      addService: noopThis,
      defineSizeMapping: noopThis,
      setCollapseEmptyDiv: noopThis,
      setTargeting: noopThis,
      setCategoryExclusion: noopThis,
      setClickUrl: noopThis,
      setForceSafeFrame: noopThis,
      set: noopThis,
      get: noop,
      getAdUnitPath: function () { return ''; },
      getSlotElementId: function () { return ''; },
      getTargeting: function () { return []; },
      getTargetingKeys: function () { return []; },
      getResponseInformation: function () { return null; },
      clearTargeting: noopThis,
      updateTargetingFromMap: noopThis,
    };
    return slot;
  }

  const pubads = {
    addEventListener: noopThis,
    removeEventListener: noopThis,
    enableSingleRequest: noopThis,
    disableInitialLoad: noopThis,
    collapseEmptyDivs: noopThis,
    setTargeting: noopThis,
    clearTargeting: noopThis,
    refresh: noop,
    display: noop,
    getSlots: function () { return []; },
    setCentering: noopThis,
    setPrivacySettings: noopThis,
    updateCorrelator: noopThis,
    setRequestNonPersonalizedAds: noopThis,
  };

  const googletag = window.googletag || {};
  googletag.cmd = googletag.cmd || [];
  googletag.apiReady = true;
  googletag.pubadsReady = true;
  googletag.defineSlot = makeSlot;
  googletag.defineOutOfPageSlot = makeSlot;
  googletag.pubads = function () { return pubads; };
  googletag.enableServices = noop;
  googletag.display = noop;
  googletag.destroySlots = noop;
  googletag.sizeMapping = function () {
    const b = { addSize: function () { return b; }, build: function () { return []; } };
    return b;
  };
  googletag.companionAds = function () { return { setRefreshUnfilledSlots: noop }; };

  // Drain any queued commands and make future pushes run synchronously.
  const queue = googletag.cmd;
  googletag.cmd = { push: function (fn) { try { typeof fn === 'function' && fn(); } catch (_) {} return 1; } };
  if (Array.isArray(queue)) {
    for (const fn of queue) { try { typeof fn === 'function' && fn(); } catch (_) {} }
  }
  window.googletag = googletag;
})();
