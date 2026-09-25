/* StampStack neutered stand-in for Google Publisher Tag (googletagservices gpt.js).
   Implements the documented googletag surface (developers.google.com/publisher-tag/reference)
   so page scripts run to the end, but requests no ads: every slot renders empty. Slots keep
   the path, sizes and div they were defined with, and listeners get slotRequested,
   slotResponseReceived and slotRenderEnded {isEmpty: true}, because pages reveal content or
   drop placeholders from those events. slotOnload and impressionViewable never fire for an
   empty slot in real GPT either. */
(function () {
  'use strict';
  const w = window;
  const prior = w.googletag && typeof w.googletag === 'object' ? w.googletag : {};
  // A real GPT (or this stub, loaded twice) already owns the namespace.
  if (prior.apiReady === true && typeof prior.pubads === 'function') return;

  const noop = function () {};
  const self = function () { return this; };
  const yes = function () { return true; };
  const nothing = function () { return null; };
  const none = function () { return []; };
  const blank = function () { return ''; };
  const settings = function () { return {}; };
  const run = function (fn, arg) {
    try { fn.call(w, arg); } catch (_) {}
  };

  /** key -> string[], as setTargeting / getTargeting / clearTargeting expose it. */
  function Targeting() { this.map = new Map(); }
  Targeting.prototype.set = function (key, value) {
    if (key === undefined || key === null) return;
    const values = Array.isArray(value) ? value : [value];
    this.map.set(String(key), values.map(String));
  };
  Targeting.prototype.setAll = function (obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) this.set(key, obj[key]);
  };
  Targeting.prototype.get = function (key) { return (this.map.get(String(key)) || []).slice(); };
  Targeting.prototype.keys = function () { return Array.from(this.map.keys()); };
  Targeting.prototype.clear = function (key) {
    if (key === undefined) this.map.clear();
    else this.map.delete(String(key));
  };

  function sizesOf(size) {
    if (size === 'fluid') return ['fluid'];
    if (!Array.isArray(size)) return [];
    const list = typeof size[0] === 'number' ? [size] : size;
    const out = [];
    for (const s of list) {
      if (s === 'fluid') out.push('fluid');
      else if (Array.isArray(s) && s.length === 2) {
        const width = Number(s[0]);
        const height = Number(s[1]);
        out.push({ getWidth: function () { return width; }, getHeight: function () { return height; } });
      }
    }
    return out;
  }

  // --- services ------------------------------------------------------------------------------
  function Service(name) {
    this.name = name;
    this.listeners = new Map();
  }
  Service.prototype.addEventListener = function (type, fn) {
    if (typeof fn !== 'function') return this;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return this;
  };
  Service.prototype.removeEventListener = function (type, fn) {
    const set = this.listeners.get(type);
    if (set) set.delete(fn);
    return this;
  };
  Service.prototype.emit = function (type, event) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) run(fn, event);
  };
  Service.prototype.getName = function () { return this.name; };
  Service.prototype.getSlots = function () { return slots.slice(); };

  const pubads = new Service('publisher_ads');
  const companion = new Service('companion_ads');
  const content = new Service('content');
  let initialLoadDisabled = false;
  let singleRequest = false;
  let collapseEmpty = false;
  const pageTargeting = new Targeting();
  const pageAttributes = new Map();
  let pageExclusions = [];

  // --- slots ---------------------------------------------------------------------------------
  const slots = [];
  const state = new WeakMap();
  let instances = 0;

  function Slot(path, size, divId, outOfPage) {
    const n = instances++;
    const div = typeof divId === 'string' && divId ? divId : 'gpt_unit_' + path + '_' + n;
    state.set(this, {
      path: path,
      div: div,
      n: n,
      sizes: sizesOf(size),
      outOfPage: outOfPage,
      targeting: new Targeting(),
      attributes: new Map(),
      exclusions: [],
      services: [],
      collapse: null,
      fetched: false,
    });
  }
  const S = function (slot) { return state.get(slot); };
  const sp = Slot.prototype;
  sp.addService = function (service) {
    if (service && S(this).services.indexOf(service) < 0) S(this).services.push(service);
    return this;
  };
  sp.getServices = function () { return S(this).services.slice(); };
  sp.getAdUnitPath = function () { return S(this).path; };
  sp.getName = function () { return S(this).path; };
  sp.getSlotElementId = function () { return S(this).div; };
  sp.getDomId = function () { return S(this).div; };
  sp.getSizes = function () { return S(this).sizes.slice(); };
  sp.getOutOfPage = function () { return S(this).outOfPage; };
  sp.getSlotId = function () {
    const s = S(this);
    const id = s.path + '_' + s.n;
    return {
      getId: function () { return id; },
      getAdUnitPath: function () { return s.path; },
      getName: function () { return s.path; },
      getDomId: function () { return s.div; },
      getInstance: function () { return s.n; },
    };
  };
  sp.setTargeting = function (key, value) { S(this).targeting.set(key, value); return this; };
  sp.updateTargetingFromMap = function (map) { S(this).targeting.setAll(map); return this; };
  sp.getTargeting = function (key) { return S(this).targeting.get(key); };
  sp.getTargetingKeys = function () { return S(this).targeting.keys(); };
  sp.clearTargeting = function (key) { S(this).targeting.clear(key); return this; };
  sp.set = function (key, value) { S(this).attributes.set(String(key), value); return this; };
  sp.get = function (key) {
    const a = S(this).attributes;
    return a.has(String(key)) ? a.get(String(key)) : null;
  };
  sp.getAttributeKeys = function () { return Array.from(S(this).attributes.keys()); };
  sp.setCategoryExclusion = function (label) { S(this).exclusions.push(String(label)); return this; };
  sp.getCategoryExclusions = function () { return S(this).exclusions.slice(); };
  sp.clearCategoryExclusions = function () { S(this).exclusions = []; return this; };
  sp.setCollapseEmptyDiv = function (collapse) { S(this).collapse = !!collapse; return this; };
  sp.getCollapseEmptyDiv = function () { return S(this).collapse; };
  sp.defineSizeMapping = self;
  sp.setClickUrl = self;
  sp.setForceSafeFrame = self;
  sp.setSafeFrameConfig = self;
  sp.setConfig = self;
  sp.getConfig = settings;
  sp.getResponseInformation = nothing;
  sp.getClickUrl = blank;
  sp.getContentUrl = blank;
  sp.getEscapedQemQueryId = blank;
  sp.getHtml = blank;

  function forget(slot) {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
  }

  function define(path, size, div, outOfPage) {
    const id = typeof div === 'string' ? div : '';
    // Redefining a div replaces its slot, which is what single-page apps rely on.
    if (id) for (const old of slots.slice()) if (S(old).div === id) forget(old);
    const slot = new Slot(String(path === undefined ? '' : path), size, id, outOfPage);
    slots.push(slot);
    return slot;
  }

  function find(ref) {
    if (ref instanceof Slot) return ref;
    const id = typeof ref === 'string' ? ref : ref && typeof ref.id === 'string' ? ref.id : '';
    if (!id) return null;
    for (const slot of slots) if (S(slot).div === id) return slot;
    return null;
  }

  /** Report `list` as fetched and empty, after the caller's synchronous code, like real GPT. */
  function renderEmpty(list) {
    const targets = list.filter(function (slot) { return slot && slots.indexOf(slot) >= 0; });
    for (const slot of targets) S(slot).fetched = true;
    if (!targets.length) return;
    setTimeout(function () {
      for (const slot of targets) {
        if (slots.indexOf(slot) < 0) continue;
        const base = { serviceName: 'publisher_ads', slot: slot };
        pubads.emit('slotRequested', Object.assign({}, base));
        pubads.emit('slotResponseReceived', Object.assign({}, base));
        const collapse = S(slot).collapse === null ? collapseEmpty : S(slot).collapse;
        if (collapse) {
          const el = document.getElementById(S(slot).div);
          if (el && el.style) el.style.display = 'none';
        }
        pubads.emit('slotRenderEnded', Object.assign(base, {
          isEmpty: true,
          size: null,
          advertiserId: null,
          campaignId: null,
          companyIds: null,
          creativeId: null,
          creativeTemplateId: null,
          isBackfill: false,
          labelIds: null,
          lineItemId: null,
          slotContentChanged: false,
          sourceAgnosticCreativeId: null,
          sourceAgnosticLineItemId: null,
          yieldGroupIds: null,
        }));
      }
    }, 0);
  }

  function display(ref) {
    const slot = find(ref);
    if (!slot || initialLoadDisabled) return;
    // Single-request mode fetches every slot not yet fetched on the first display().
    if (singleRequest) renderEmpty(slots.filter(function (s) { return !S(s).fetched; }));
    else if (!S(slot).fetched) renderEmpty([slot]);
  }

  function PassbackSlot() {}
  const pp = PassbackSlot.prototype;
  pp.display = noop;
  pp.get = nothing;
  pp.set = self;
  pp.setClickUrl = self;
  pp.setForceSafeFrame = self;
  pp.setTagForChildDirectedTreatment = self;
  pp.setTargeting = self;
  pp.updateTargetingFromMap = self;

  const pa = pubads;
  pa.enableSingleRequest = function () { singleRequest = true; return true; };
  pa.disableInitialLoad = function () { initialLoadDisabled = true; };
  pa.isInitialLoadDisabled = function () { return initialLoadDisabled; };
  pa.collapseEmptyDivs = function () { collapseEmpty = true; return true; };
  pa.display = function (path, size, div) { display(define(path, size, div, false)); };
  pa.refresh = function (list) {
    renderEmpty(Array.isArray(list) ? list : slots.slice());
  };
  pa.clear = function (list) {
    for (const slot of Array.isArray(list) ? list : slots) if (state.has(slot)) S(slot).fetched = false;
    return true;
  };
  pa.getSlots = function () { return slots.slice(); };
  pa.getSlotIdMap = function () {
    const map = {};
    for (const slot of slots) map[slot.getSlotId().getId()] = slot;
    return map;
  };
  pa.setTargeting = function (key, value) { pageTargeting.set(key, value); return this; };
  pa.getTargeting = function (key) { return pageTargeting.get(key); };
  pa.getTargetingKeys = function () { return pageTargeting.keys(); };
  pa.clearTargeting = function (key) { pageTargeting.clear(key); return this; };
  pa.set = function (key, value) { pageAttributes.set(String(key), value); return this; };
  pa.get = function (key) {
    return pageAttributes.has(String(key)) ? pageAttributes.get(String(key)) : null;
  };
  pa.getAttributeKeys = function () { return Array.from(pageAttributes.keys()); };
  pa.setCategoryExclusion = function (label) { pageExclusions.push(String(label)); return this; };
  pa.clearCategoryExclusions = function () { pageExclusions = []; return this; };
  pa.definePassback = function () { return new PassbackSlot(); };
  pa.defineOutOfPagePassback = function () { return new PassbackSlot(); };
  pa.enableAsyncRendering = yes;
  pa.enableSyncRendering = yes;
  pa.enableLazyLoad = noop;
  pa.enableVideoAds = noop;
  pa.setVideoContent = noop;
  pa.getVideoContent = nothing;
  pa.getCorrelator = blank;
  pa.updateCorrelator = self;
  pa.setCentering = noop;
  pa.setCookieOptions = self;
  pa.setForceSafeFrame = self;
  pa.setLocation = self;
  pa.setPrivacySettings = self;
  pa.setPublisherProvidedId = self;
  pa.setRequestNonPersonalizedAds = self;
  pa.setSafeFrameConfig = self;
  pa.setTagForChildDirectedTreatment = self;
  pa.clearTagForChildDirectedTreatment = self;
  pa.setTagForUnderAgeOfConsent = self;

  companion.enableSyncLoading = noop;
  companion.setRefreshUnfilledSlots = noop;
  companion.isRoadblockingSupported = function () { return false; };
  content.setContent = noop;

  // --- namespace -----------------------------------------------------------------------------
  const googletag = prior;
  googletag.apiReady = true;
  googletag.pubadsReady = true;
  googletag.enums = {
    OutOfPageFormat: {
      TOP_ANCHOR: 2,
      BOTTOM_ANCHOR: 3,
      REWARDED: 4,
      INTERSTITIAL: 5,
      GAME_MANUAL_INTERSTITIAL: 7,
      LEFT_SIDE_RAIL: 8,
      RIGHT_SIDE_RAIL: 9,
    },
    TrafficSource: { ORGANIC: 0, PAID: 1 },
  };
  googletag.defineSlot = function (path, size, div) { return define(path, size, div, false); };
  googletag.defineOutOfPageSlot = function (path, divOrFormat) {
    return define(path, [], typeof divOrFormat === 'string' ? divOrFormat : '', true);
  };
  googletag.destroySlots = function (list) {
    for (const slot of Array.isArray(list) ? list.slice() : slots.slice()) forget(slot);
    return true;
  };
  googletag.display = display;
  googletag.enableServices = noop;
  googletag.pubads = function () { return pubads; };
  googletag.companionAds = function () { return companion; };
  googletag.content = function () { return content; };
  googletag.sizeMapping = function () {
    const mapping = [];
    const builder = {
      addSize: function (viewport, size) { mapping.push([viewport, size]); return builder; },
      build: function () { return mapping.slice(); },
    };
    return builder;
  };
  googletag.setConfig = noop;
  googletag.getConfig = settings;
  googletag.getVersion = blank;
  googletag.setAdIframeTitle = noop;
  googletag.openConsole = noop;
  googletag.disablePublisherConsole = noop;
  if (!Array.isArray(googletag.secureSignalProviders)) googletag.secureSignalProviders = [];
  if (typeof googletag.secureSignalProviders.clearAllCache !== 'function') {
    googletag.secureSignalProviders.clearAllCache = noop;
  }
  w.googletag = googletag;

  // The command queue: every function queued before load runs now, in order, and a later
  // push runs each of its arguments at once. The page's own array is kept, so a reference it
  // held on to still works. One failing command does not stop the others.
  const cmd = Array.isArray(googletag.cmd) ? googletag.cmd : [];
  const queued = cmd.splice(0, cmd.length);
  let done = 0;
  cmd.push = function () {
    for (let i = 0; i < arguments.length; i++) {
      const fn = arguments[i];
      if (typeof fn === 'function') run(fn);
      done++;
    }
    return done;
  };
  googletag.cmd = cmd;
  cmd.push.apply(cmd, queued);
})();
