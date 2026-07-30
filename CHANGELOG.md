# Changelog

Written for users, not for the commit log. Internal refactors and test-only work are omitted.

## 2.1.1

- **Fixed: "Block on this site" did nothing.** The switch was there, it moved when you dragged
  it, and clicking it had no effect whatsoever — on any site. Turning blocking off for a single
  site was impossible; the only thing that worked was "Pause everywhere". The control had no
  clickable area at all, so nothing was ever saved. Every other switch in the popup was
  unaffected.

  This shipped in 1.7.0 and went unnoticed until now. Apologies — it made the single most
  useful control in the extension useless.

## 2.1.0

A maintenance release about the two things a blocker cannot do for itself: stay current, and
find out when it has broken a page.

- **Tell the developer a site is broken.** The "Site broken?" panel now ends with a report
  action. It opens a pre-filled email you read and send yourself — StampStack transmits
  nothing. It carries the site name and your StampStack settings, never anything about the
  page you were on.
- **Settings shows how old the filter lists are**, and says so in red once a build is more
  than a month behind upstream. The lists are compiled into each release, so this is the one
  thing about coverage the interface could not previously tell you.
- **1,611 more blocking rules**, from a fresh pull of EasyList, EasyPrivacy, EasyList Cookie
  and uBlock Origin's lists — 121,988 in total.

## 2.0.0

The blocking got substantially deeper and the interface was rebuilt around it. Major version
because the popup is a different thing than it was, and because several rules that were shipping
without doing anything now actually run.

### Blocking

- **Popunders are blocked.** The `window.open` defuser and ~2,400 other scriptlet rules were
  being shipped to pages and silently discarded because the extension had no implementation for
  them. It does now.
- **Malware and phishing sites are blocked when you navigate to them**, not just when they load
  a subresource. 1,368 rules in the default badware list could only ever block sub-requests.
- **Anti-adblock defusers work.** Inline-script rewriting (945 rules) and abort-on-stack-trace
  now run, along with fetch, XHR, timer and eval guards.
- **Tracker-response filtering was repaired.** The XHR rewriting hook had never worked in any
  browser, so promoted-content stripping on X and Facebook was inert.
- **Cookie-wall handling improved** — the property hooks those consent scripts rely on were
  no-ops on nested object paths, which covered most real rules.

### New

- **Page report.** Open the popup on any site and see the trackers that page reached out to, by
  name, and which ones StampStack has rules for. Nothing leaves your browser to produce it.
- **Element picker.** Press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> or click "Hide an
  element", point at what annoys you, and it is gone on that site. Selectors are chosen to
  survive the site's next redesign.
- **Graded breakage repair.** Instead of one on/off switch: stop hiding elements → also stop
  running scriptlets → finally turn blocking off. The first two steps keep your ad blocking on.
- **Your own filters**, editable in Settings, with per-line errors instead of silent failures.
- **Site rules manager** — every site you changed something on, in one place.
- **Settings export / import.**
- **Per-category SponsorBlock**, plus an Undo on the skip toast. StampStack only requests the
  categories you picked; turn them all off and it never contacts the API.

### Fixed

- **Dark mode no longer flashes white** on every page load.
- **The rule count tells the truth.** If Chrome's shared rule limit forces a list to be dropped,
  StampStack says so instead of reporting full protection.
- **Purchase state is no longer clobbered** by a slow license refresh landing after a purchase.
- **SponsorBlock survives a failed request** rather than silently doing nothing for the rest of
  the page, and can no longer skip past the end of a video.
- **Controls that should have been hidden behind the purchase were visible.** A CSS rule was
  overriding the `hidden` attribute.
- Service-worker wakes no longer make a network request, re-index the whole ruleset, and message
  every open tab.

### Changed

- The popup was rebuilt: status and its toggle are one card, the two primary actions sit
  together, and YouTube / Dark mode collapse into sections that still show their state.
- Filter data is smaller and faster to load despite covering more.
