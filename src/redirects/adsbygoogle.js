/* StampStack neutered stand-in for googlesyndication adsbygoogle.js.
   Loads no ads, but leaves the page looking the way it does when AdSense has no ad to show:
   - every <ins class="adsbygoogle"> gets a 1px iframe#aswift_N (with iframe#google_ads_frameN
     inside) and data-adsbygoogle-status="done" / data-ad-status="unfilled". Anti-adblock
     checks read an empty <ins> as "blocked", and uBO rules that redirect here pair the redirect
     with hiding [id^="aswift_"], which only works if those frames exist;
   - the H5 Ad Placement API (adConfig / adBreak, sent through adsbygoogle.push) gets its
     onReady and adBreakDone callbacks, which games wait on before they start or resume. No
     ad is shown, so beforeAd / afterAd / beforeReward are not called and no reward is granted. */
(function () {
  'use strict';
  const w = window;
  const d = document;
  const prior = w.adsbygoogle;
  // Already loaded, by the real library or by this stub.
  if (prior && prior.loaded === true) return;

  const later = function (fn, arg) {
    setTimeout(function () {
      try { fn(arg); } catch (_) {}
    }, 0);
  };

  /** One object pushed by the page: an ad unit's `{}`, or an adConfig / adBreak call. */
  function handle(item) {
    if (!item || typeof item !== 'object') return;
    if (typeof item.onReady === 'function') later(item.onReady);
    if (typeof item.adBreakDone === 'function') {
      const type = typeof item.type === 'string' ? item.type : '';
      later(item.adBreakDone, {
        breakType: type,
        breakName: typeof item.name === 'string' ? item.name : '',
        breakFormat: type === 'reward' ? 'reward' : 'interstitial',
        breakStatus: 'noAdPreloaded',
      });
    }
  }

  const FRAME_CSS =
    'border:0!important;height:1px!important;max-height:1px!important;' +
    'max-width:1px!important;width:1px!important;';
  let next = 0;
  function freeIndex() {
    while (d.getElementById('aswift_' + next)) next++;
    return next++;
  }

  /** Give every ad unit not handled yet the frames and status an unfilled unit has. */
  function fillUnits() {
    let units;
    try {
      units = d.querySelectorAll('.adsbygoogle');
    } catch (_) {
      return;
    }
    for (const unit of units) {
      if (unit.hasAttribute('data-adsbygoogle-status')) continue;
      const n = freeIndex();
      const frame = d.createElement('iframe');
      frame.id = 'aswift_' + n;
      frame.name = 'aswift_' + n;
      frame.setAttribute('style', FRAME_CSS);
      const inner = d.createElement('iframe');
      inner.id = 'google_ads_frame' + n;
      frame.appendChild(inner);
      unit.appendChild(frame);
      unit.setAttribute('data-adsbygoogle-status', 'done');
      unit.setAttribute('data-ad-status', 'unfilled');
    }
  }

  const adsbygoogle = Array.isArray(prior) ? prior : [];
  const queued = adsbygoogle.slice();
  adsbygoogle.loaded = true;
  adsbygoogle.push = function () {
    for (let i = 0; i < arguments.length; i++) handle(arguments[i]);
    fillUnits();
    return adsbygoogle.length;
  };
  // Some integrations read these:
  if (adsbygoogle.pauseAdRequests === undefined) adsbygoogle.pauseAdRequests = 0;
  w.adsbygoogle = adsbygoogle;
  // Google Auto Ads occasionally probes these:
  w.__google_ad_urls = w.__google_ad_urls || [];
  w.googleadv = w.googleadv || { cmd: { push: function () {} } };

  for (const item of queued) handle(item);
  fillUnits();
  // The script is usually async in <head>: units further down are not parsed yet.
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', fillUnits, { once: true });
})();
