/* StampStack neutered stand-in for googlesyndication adsbygoogle.js.
   Provides the globals pages feature-detect so layouts don't break, but loads no ads. */
(function () {
  'use strict';
  const noop = function () {};
  const adsbygoogle = window.adsbygoogle || [];
  // adsbygoogle is normally an array whose .push() triggers ad loads; make push inert
  // while still swallowing the config objects pages hand it.
  adsbygoogle.loaded = true;
  adsbygoogle.push = function () {
    return 1;
  };
  // Some integrations read these:
  adsbygoogle.pauseAdRequests = 0;
  window.adsbygoogle = adsbygoogle;
  // Google Auto Ads occasionally probes these:
  window.__google_ad_urls = window.__google_ad_urls || [];
  window.googleadv = window.googleadv || { cmd: { push: noop } };
})();
