// Curated tracker/ad-network domains → the organization a user would recognize.
//
// Why curated rather than derived: the shipped lists contain ~101,000 domain-anchored block
// rules (2.2 MB as raw hostnames), far too much to add to the worker bundle — and it would tell
// the user nothing anyway, since "pagead2.googlesyndication.com" is not a useful label. A few
// hundred named organizations cover the overwhelming majority of third-party requests on real
// pages, and let the report say "Google Analytics" or "Taboola" instead of dumping hostnames.
//
// Inclusion criterion is "does this domain exist to profile, target or measure the visitor" —
// NOT "do we happen to ship a rule for it". Naming a tracker we do not block is useful, and
// compile-filters marks each entry with whether a shipped rule actually matches it, so the
// report can distinguish "blocked" from "seen, not blocked" instead of guessing.
//
// Deliberately excluded: functional asset CDNs (fbcdn.net, scdn.co, ttvnw.net, pinimg.com,
// gravatar.com, media-amazon.com, licdn.com, intercomcdn.com, zdassets.com, …). They are third
// parties, but flagging Spotify album art or an avatar service as a tracker would cost the
// report the credibility that is the whole point of showing it.

/** @type {Record<string, string[]>} organization label → domains it serves from */
export const TRACKER_ORGS = {
  'Google Ads': [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'googletagservices.com',
    '2mdn.net',
    'adservice.google.com',
  ],
  'Google Analytics': ['google-analytics.com', 'analytics.google.com', 'googletagmanager.com'],
  'Meta (Facebook)': ['facebook.net', 'connect.facebook.net'],
  'Amazon Ads': ['amazon-adsystem.com', 'assoc-amazon.com'],
  'Microsoft / Bing Ads': ['bat.bing.com', 'atdmt.com'],
  'Microsoft Clarity': ['clarity.ms'],
  TikTok: ['analytics.tiktok.com'],
  'X (Twitter)': ['ads-twitter.com', 'analytics.twitter.com'],
  LinkedIn: ['ads.linkedin.com', 'snap.licdn.com'],
  Pinterest: ['ct.pinterest.com'],
  Snapchat: ['tr.snapchat.com'],
  Reddit: ['events.reddit.com'],

  Criteo: ['criteo.com', 'criteo.net'],
  Taboola: ['taboola.com', 'taboolasyndication.com'],
  Outbrain: ['outbrain.com', 'zemanta.com'],
  'The Trade Desk': ['adsrvr.org'],
  PubMatic: ['pubmatic.com'],
  Rubicon: ['rubiconproject.com'],
  Magnite: ['magnite.com'],
  'Index Exchange': ['casalemedia.com', 'indexww.com'],
  OpenX: ['openx.net', 'openx.com'],
  AppNexus: ['adnxs.com', 'adnxs-simple.com'],
  Xandr: ['xandr.com'],
  Smartadserver: ['smartadserver.com'],
  Teads: ['teads.tv'],
  Sharethrough: ['sharethrough.com'],
  Sovrn: ['lijit.com', 'sovrn.com'],
  Adform: ['adform.net'],
  'Yahoo / Verizon Media': ['advertising.com', 'yieldmanager.com', 'flurry.com'],
  'Media.net': ['media.net'],
  'Prebid / AppLovin': ['prebid.org', 'applovin.com', 'applvn.com'],
  Unruly: ['unrulymedia.com'],
  'Improve Digital': ['360yield.com'],
  Adyoulike: ['adyoulike.com', 'omnitagjs.com'],
  Nativo: ['postrelease.com', 'nativo.com'],
  Revcontent: ['revcontent.com'],
  MGID: ['mgid.com'],
  Adnami: ['adnami.io'],
  Seedtag: ['seedtag.com'],

  Quantcast: ['quantserve.com', 'quantcast.com', 'quantcount.com'],
  Comscore: ['scorecardresearch.com', 'comscore.com'],
  Nielsen: ['imrworldwide.com', 'nielsen.com'],
  Chartbeat: ['chartbeat.com', 'chartbeat.net'],
  Parsely: ['parsely.com', 'parse.ly'],
  Hotjar: ['hotjar.com', 'hotjar.io'],
  Mixpanel: ['mixpanel.com'],
  Amplitude: ['amplitude.com'],
  Segment: ['segment.com', 'segment.io'],
  Heap: ['heapanalytics.com', 'heap.io'],
  FullStory: ['fullstory.com'],
  Optimizely: ['optimizely.com'],
  VWO: ['visualwebsiteoptimizer.com'],
  'Adobe Analytics': ['omtrdc.net', 'demdex.net', '2o7.net', 'adobedtm.com', 'everesttech.net'],
  Salesforce: ['krxd.net', 'exacttarget.com', 'pardot.com'],
  Braze: ['appboycdn.com', 'braze.com'],
  Klaviyo: ['klaviyo.com'],
  Mailchimp: ['list-manage.com'],
  HubSpot: ['hs-analytics.net', 'hsforms.net'],
  Intercom: ['intercom.io'],
  Drift: ['drift.com', 'driftt.com'],
  'New Relic': ['newrelic.com', 'nr-data.net'],
  Sentry: ['sentry.io'],
  Datadog: ['datadoghq.com', 'datadoghq-browser-agent.com'],
  Yandex: ['mc.yandex.ru', 'yandex.net'],
  Matomo: ['matomo.cloud'],
  Plausible: ['plausible.io'],
  'Cloudflare Insights': ['cloudflareinsights.com'],
  Bugsnag: ['bugsnag.com'],
  LogRocket: ['logrocket.com', 'lr-ingest.io'],
  Smartlook: ['smartlook.com'],
  Inspectlet: ['inspectlet.com'],
  'Crazy Egg': ['crazyegg.com'],
  Mouseflow: ['mouseflow.com'],
  'Lucky Orange': ['luckyorange.com'],
  Pingdom: ['pingdom.net'],

  OneTrust: ['onetrust.com', 'cookielaw.org', 'otsdk.com'],
  Sourcepoint: ['sp-prod.net'],
  'Quantcast (consent)': ['quantcast.mgr.consensu.org'],
  Didomi: ['didomi.io'],
  Usercentrics: ['usercentrics.eu', 'usercentrics.com'],
  TrustArc: ['trustarc.com', 'truste.com'],

  Branch: ['branch.io', 'app.link'],
  AppsFlyer: ['appsflyer.com'],
  Adjust: ['adjust.com', 'adjust.io'],
  Kochava: ['kochava.com'],
  Tealium: ['tiqcdn.com', 'tealium.com'],
  Ensighten: ['ensighten.com'],
  'Bounce Exchange': ['bounceexchange.com'],
  Sailthru: ['sailthru.com'],
  Attentive: ['attentivemobile.com'],
  Postscript: ['postscript.io'],
  Yotpo: ['yotpo.com'],
  Bazaarvoice: ['bazaarvoice.com'],
  Disqus: ['disqus.com'],
  AddThis: ['addthis.com'],
  ShareThis: ['sharethis.com'],

  PopAds: ['popads.net', 'popcash.net'],
  PropellerAds: ['propellerads.com', 'propellerpops.com'],
  Exoclick: ['exoclick.com', 'exosrv.com'],
  JuicyAds: ['juicyads.com'],
  TrafficJunky: ['trafficjunky.net', 'trafficjunky.com'],
  Adsterra: ['adsterra.com', 'highperformancecpmgate.com'],
  Infolinks: ['infolinks.com'],
  Ezoic: ['ezoic.net', 'ezoic.com'],
  Mediavine: ['mediavine.com'],
  AdThrive: ['adthrive.com'],
  Monumetric: ['monumetric.com'],
  Playwire: ['playwire.com', 'intergi.com'],
  Freestar: ['pubnation.com', 'freestar.com'],
};

/** Flatten to domain → display label. The first org to claim a domain keeps it. */
export function trackerDomainMap() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [label, domains] of Object.entries(TRACKER_ORGS)) {
    for (const d of domains) {
      const domain = d.toLowerCase().trim();
      if (domain && !(domain in out)) out[domain] = label;
    }
  }
  return out;
}
