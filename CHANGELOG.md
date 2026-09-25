# Changelog

Written for users, not for the commit log. Internal refactors and test-only work are omitted.

## Unreleased

- **Fixed: many news sites broke because of StampStack.** A script patch meant to stop one ad
  script on arstechnica.com, nypost.com, nbcnews.com, howtogeek.com and about 2,400 other
  sites also took basic page functions away from every other script on the page, such as
  creating elements, reading cookies and listening for events. Those functions now keep
  working, and only the targeted script is stopped. Some rules also silently dropped a page's
  own "on load" handler. They no longer do.
- **Fixed: element hiding and YouTube ad blocking could quietly switch off.** Chrome refused
  all of StampStack's element hiding, and the YouTube ad blocking with it, in two cases: with
  the Chinese filter list on (it is turned on automatically when the browser is set to
  Chinese), or after adding a site such as `10.0.0` in Settings. The Chinese list's broken
  entry is now skipped, and if Chrome ever turns down an update, the previous working setup
  stays in place.
- **Fixed: script patches now run before the page does.** Filter-list script patches that stop
  anti-adblock walls and popups, such as the one for worldfreeware.com, used to arrive 30 to
  200 milliseconds after a page started, and often after it had finished loading. By then most
  had nothing left to stop. Chrome now runs them before the page's first script, including in
  frames a page creates for itself and on pages opened while StampStack's background worker
  was asleep. Rules written for a site name across all its endings, such as `yts.*`, work this
  way too. Patches for frames from other sites still arrive a little later, because StampStack
  first checks whether you switched off the page they are on.
- Script patches no longer leave anything behind on the page that a site could use to spot
  StampStack or switch its patches off.
- Settings > Add a site now says why it cannot use an entry, such as an incomplete address
  like `10.0.0` or `192.168.1`, and keeps what you typed so you can correct it. It used to
  clear the field and do nothing. A pasted web address now adds its site.
- **Turning StampStack off for a site now follows the page you are on.** Switching off
  youtube.com used to also unblock YouTube videos embedded on every other site, with their ads
  and trackers. The same went for comment boxes and social widgets. Embeds on other sites now
  get network blocking, YouTube ad blocking, site-specific hiding and script patches again,
  and frames on a site you switched off get none of these. The lighter breakage fixes work
  the same way. Two gaps remain because Chrome decides them by each frame's own address:
  general ad hiding inside a frame still follows the frame's own site, and a YouTube player
  on a site you switched off still has its ads blocked.
- **YouTube:** ads that get past the blocking are now skipped for as long as the tab stays
  open. The skip helper used to stop 10 minutes after you opened YouTube.
- **More ads get a silent stand-in instead of playing.** Audio and video ads on sites such as
  SoundCloud, Spotify, TF1, RTÉ, myCANAL and Tubi now receive a short silent clip, and many ad
  images receive a transparent placeholder, the way uBlock Origin handles them. About 200
  filters that used to be dropped now work, including EasyList's video-ad rules written in
  Adblock Plus syntax.
- **Fixed: some filters worked against their purpose.**
  - Two filters meant to switch element hiding back on switched it off: on kobieta.wp.pl no
    ads were hidden at all, and on seznamzpravy.cz general ad hiding was off.
  - An exception meant for WordPress.com sites let the Jetpack stats tracker (stats.wp.com)
    load on every website. A LastPass ad frame was also allowed everywhere.
  - Some scam and malware blocks blocked links leaving a bad site instead of the bad site
    itself, and did nothing when you typed its address or opened it from a bookmark.
  - About 135 filters that leave out one kind of content, such as images or scripts, also
    blocked whole pages. A filter for `-banner-ads-` blocked any page with that phrase in its
    address, and an EasyList China filter for 57 sites blocked every link leaving them.
- Exceptions that EasyList limits to the search results of Google, DuckDuckGo and Yandex used
  to switch general ad hiding off across the whole site, Google News included. They now apply
  to the results pages only, where general hiding could hide real results. A few similar
  exceptions on other sites, such as Weibo's share page, are now limited to their page too.
- Filter lists are read the way uBlock Origin reads them for Chrome. Sections written only for
  Firefox, Safari, phones or other ad blockers (614 lines) no longer apply. Among them was a
  Firefox-only rule that let Amazon ad scripts load on 14 sites.
- Script patches read their settings the way uBlock Origin does, quotes and backslashes
  included. This fixes the Facebook feed-ad rule, the Admiral anti-adblock rules on about 265
  sites, filemoon, and datanodes.to, where a rule removed almost every inline script.
- Script patches follow uBlock Origin's rules more closely:
  - Popup blocking now catches popups that open in a new tab, leaves same-tab links alone, and
    waits the full number of seconds a rule asks for.
  - Countdown skippers only speed up the timer they were written for. On about 180 sites they
    used to speed up every timer on the page, animations included.
  - Rules that remove click handlers only touch the element and event they name. One rule
    used to remove every click handler on link.paid4link.com.
  - Rules that edit a page's inline scripts now respect their conditions and exclusions. They
    no longer touch `<noscript>` text or content added after the page loads.
  - Promoted posts in X, Facebook and Pinterest feeds are removed entirely, instead of staying
    in the feed looking like normal posts. These rules also no longer edit data they were not
    written for.
  - Facebook rules that rewrite streamed search results are no longer undone.
  - Rules aimed at a setting deep inside a site's configuration now apply when the site builds
    that configuration piece by piece. Among them are the video-ad rules for howtogeek.com,
    makeuseof.com, cbr.com, gamerant.com and 27 other sites, n-tv.de and rtl.de, which had
    no effect before.
  - Rules that set a value on every object of a page no longer show up as an extra entry when
    the page lists an object's contents, which could break the page's own scripts.
- Most of EasyList China's and CJX Annoyance's `:-abp-has()` and `:-abp-contains()` hiding
  rules now work. They were shipped but could never match.
- More pattern-based filters now load, including EasyList's rule for rotating ad scripts and
  EasyPrivacy's fingerprinting blockers for Kleinanzeigen, Spectrum and TD Bank. Filters that
  apply only to certain kinds of requests, such as form submissions, now work too, and filters
  that strip tracking parameters from links honor the lists' exceptions.
- Turning StampStack off for `localhost`, or turning element hiding off there, now stops
  element hiding on it too. Before, only network blocking stopped. EasyList's own exceptions
  for local development pages at `localhost` and `127.0.0.1` now apply as well.
- Dark mode: a per-site setting on an IP address, such as a router page at 192.168.1.1, no
  longer turns dark mode off everywhere.
- Installs that started on the very first version no longer keep a leftover script patch that
  ran on every page.
- **A new icon.** A postage stamp with a postmark, in the same green as the rest of StampStack.
  The old one was a small scene of "AD" cards under a "BLOCK" stamp, and at toolbar size it
  turned into a smudge. The new one still reads as a stamp at 16 pixels, on light and dark
  toolbars alike.
- The popup and Settings show that icon where the green dot used to be. In the popup it goes
  grey whenever the current site is not being filtered, because StampStack is paused or turned
  off for that site, just as the dot did. In Settings it goes grey while StampStack is paused.
- **Plainer words.** "Scriptlets" are now called script patches in the popup, in Settings and
  in the breakage report email. The Settings subtitle says what StampStack is rather than how
  it is built, and the filter-list notes say "element hiding" instead of "cosmetics". After the
  first repair step, the panel used to say "Ads and scriptlets are still active". It meant ad
  blocking, and now says so. Settings now calls the sponsor toggle "Skip sponsor segments", as
  the popup already did, instead of "SponsorBlock skip".
- The element picker highlights in StampStack's green instead of teal. Its outline now sits
  exactly on the element under the pointer. It used to spill 4 pixels past the right and bottom
  edges, so on a full-width bar the right-hand side of the outline was off-screen.
- StampStack's description on the extensions page now appears in Simplified or Traditional
  Chinese when your browser is set to either.

## 2.2.2

- **Fixed: a backup and restore wiped your own filters.** Exporting settings and importing
  them again deleted every filter you had written in the picker or the Settings editor, and
  reset which SponsorBlock categories were on. Those choices now travel with the backup.
  An older backup that never contained them leaves your current filters and categories alone.
- **Facebook feed ads hide again.** A parser bug stripped the backslashes out of regex
  scriptlets, so several Facebook rules (and others like them) no longer matched. The
  intended patterns are restored.
- Turning a filter list off now also drops that list's "don't hide on this site" exceptions.
  A disabled cookie list can no longer keep generic hiding off on sites it used to except.
- More hide rules actually run — ones that only used `:remove()`, `:matches-attr()`,
  `:matches-path()` or `:if()`, which were being shipped as broken CSS.
- Changing SponsorBlock categories in Settings now applies to the video already playing,
  not only the next one.
- Editing your own filters updates open pages immediately. Removing the last rule unhides
  the element without a reload.
- The page report describes the tab you are on, not a random iframe inside it.
- Dark mode follows theme switches that sites make with `data-theme` / `data-color-mode`
  instead of a class.
- Text-based hide rules (`:has-text`) update when a page rewrites existing text, and
  `:first-child` after a text match hides the element itself rather than a descendant.
- Filter lists refreshed from upstream (129,482 network rules).

## 2.2.1

- **Fixed: sponsor skipping was far too aggressive.** It skipped much more than sponsor
  segments, at what looked like random moments. Every one of the seven SponsorBlock
  categories was on by default — so intros, outros, previews, "like and subscribe" asides
  and non-music sections were all being auto-skipped, and community markers for those are
  scattered all over videos. The default is now the same as the official SponsorBlock
  extension: **sponsors only**. Everything else is opt-in under Settings → Which segments
  to skip. If you had explicitly turned a category on, your choice is kept.
- Skips no longer fire while a YouTube ad is playing — the player clock belongs to the ad
  during those, which made skips land at genuinely random places.
- The "Skipped — Undo" notice now shows in fullscreen, where skips used to be silent. Undo
  remains the way to watch a segment: it seeks back and stops that segment skipping again
  for the rest of the video.
- Segments that run to the very end of a video (outros, for those who opt in) now skip to
  just before the end. They previously never skipped at all.

## 2.2.0

- **中文界面 · Chinese interface.** StampStack now speaks Simplified and Traditional Chinese,
  and picks your language automatically from your browser's — nothing to configure.
- **Chinese filter lists.** EasyList China (12,046 rules) is switched on automatically when
  your browser is set to Chinese, with CJX's Annoyance List available alongside it in Settings.
  EasyList and EasyPrivacy barely touch Chinese ad networks, so this is the difference between
  the extension looking right and actually blocking anything on the sites you use.
- The interface is translated everywhere else too — any language Chrome supports falls back to
  English until someone translates it.

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
