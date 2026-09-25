# Changelog

Written for users, not for the commit log. Internal refactors and test-only work are omitted.

## Unreleased

- **Google Search ads are hidden again.** EasyList's rules for Google Search are written for
  `www.google.*`, and StampStack never applied them, so sponsored results stayed visible on every
  Google domain. The same fix brings back rules written for a site name across all its endings,
  such as `read.amazon.*`, and uBlock Origin rules written with `>>`, as a pattern, or with
  non-Latin site names.
- **Fixed: filters meant to repair a page broke it instead.** uBlock Origin filters that restyle
  an element, or remove one of its attributes or classes, were applied as "hide this element".
  The play button on hianime.ms and a captcha form on networkhint.com disappeared, and pages such
  as bitdefender.com could stay blank. These filters now do what they say, and filters StampStack
  cannot carry out are left out instead of hiding anything.
- **A page can no longer bring back what StampStack hides everywhere.** A site's own `!important`
  style could undo StampStack's general element hiding. That hiding now also applies at the
  browser's user level, as in uBlock Origin, with no new flash of ads.
- **One broken filter no longer switches off the others.** A single malformed rule, in a list or
  in My filters, could cancel every other site-specific hide on a page, and very large sets of
  rules were only partly applied. Each rule now stands on its own.
- **A rule for www no longer applies to the whole site.** A filter or exception written for
  www.youtube.com or www.yahoo.com also reached music.youtube.com, mail.yahoo.com and every other
  subdomain. It now stays on the site it names, as in uBlock Origin.
- **Anti-adblock bait stays visible where uBlock Origin keeps it visible.** uBlock Origin's list
  stops EasyList from hiding elements that sites use to detect ad blockers. StampStack now honors
  those exceptions across lists, so fewer "please disable your ad blocker" walls appear. As in
  uBlock Origin, some pages may now show an empty box where an ad would have been.
- **Fixed: elements hidden on the very sites a rule was meant to spare.** An exception that left
  out some sites made StampStack hide elements on exactly those sites (onet.pl, fakt.pl,
  forbes.pl and others).
- Chinese-list and other rules that look for text inside an element's children now hide what
  they target: 149 of EasyList China's text-matching rules matched nothing before.
- Hidden list rows come back when a site reuses them for normal content, and an ad stays hidden
  when the page rewrites its style.
- Ads written into blank frames on a page now get that page's element hiding, the general rules
  included.
- **Turning StampStack off for a site now also covers what is embedded in it.** Ads and widgets
  in frames from other sites kept their element hiding on a site you switched off. They no longer
  do, as in uBlock Origin. The other way round, a site you switched off no longer loses element
  hiding when it appears inside a site you have not.
- **The site switch and repair steps now work on go.dev, lg.com, wordpress.com, codesandbox.io
  and single-name intranet hosts**, covering that host only. IPv6 addresses and Chrome Web Store
  pages say why they cannot be switched.
- **Repair steps now reach StampStack's YouTube features too.** The first step also stops the
  sponsored and Shorts hiding; the second also stops the Shorts redirect and sponsor skipping.
- A repair step on one subdomain no longer deletes the parent site's fix, Remove in Settings
  deletes only that row, and turning blocking back on also clears the repair steps. The popup's
  status line shows an active repair step, and names the parent site an inherited fix comes from.
- **Your own exceptions now work on every kind of rule**, including rules that find ads by their
  text, and a list's "no site-specific hiding" exception now turns those off too.
- My filters: text-matching and `:style()` rules now work, rules that could never apply are shown
  as errors instead of being counted, and `example.*`, localhost and non-Latin site names are
  accepted.
- Element picker: ad iframes can be picked, the page no longer sees the click, Esc always closes
  it, widening survives small mouse moves, and a pick is narrowed to the one element you pointed
  at, with a live match count. It says so when a pick could not be saved, does not start where
  element hiding is off, and works on single-name intranet hosts.
- Settings: My filters no longer loses unsaved text, and keeps rules the picker added while you
  were editing. Switching a list on no longer shows a false "Not active — rule limit full"
  warning; while paused, lists read "paused" and a banner says so. Paid users are no longer
  offered Buy again. Keyboard focus stays put after toggles, long hostnames wrap, and the dark
  theme's warning colours and native buttons are readable.
- **The popup and Settings are now fully translated**, including "Hide an element", "Site
  broken?", the dark-mode offer, the footer links, every screen-reader label, the element
  picker's hints, and the errors a purchase or a settings import can show. Pages announce their
  language to assistive tech, and list dates are shown in it.
- The picker tip shows the shortcut Chrome actually assigned, and is hidden when there is none.
- The site switch and repair steps are only offered where StampStack can keep them, and a change
  that did not take effect no longer asks you to reload. Chrome Web Store and chrome:// pages no
  longer claim "Blocking on this site" or "Dark mode on here".
- In an Incognito window, the popup says that a site switch set there also applies in normal
  windows: settings are shared, as in uBlock Origin. The privacy policy says so too.
- The page report calls a tracker "blocked" only when a list that blocks it outright is on, and
  "partly blocked" when a list blocks only some of its addresses. The "ad slots hidden" count
  counts each slot once, only when it is really hidden, and says it covers rules for that site.
- Breakage reports now include how many of your own filters apply to the site (never the filters
  themselves), dark mode, the YouTube switches, pause, and any list Chrome refused to load.
- **Faster.** Filter data is read from the package when it is needed instead of on every wake of
  StampStack's background worker: a wake that needs no element-hiding data answers in about 9 ms
  instead of 42 ms. Element hiding runs about 5 times faster on busy pages such as Facebook, and
  Google results pages no longer receive 14,000 exception rules on every search.
- A stuck tab (an open alert, a busy page) no longer holds up toggles. After an update, your
  pause and list choices are restored before the license check, which now times out. Tabs open
  during an install or update get StampStack back without a reload, and the old copy steps aside
  instead of running twice.
- Pages restored with Back pick up allowlist and filter changes, and a hiccup while refreshing no
  longer drops all hiding. A page Chrome loads ahead of time follows the settings of the site it
  belongs to, dark mode included.
- Security: web pages can no longer get StampStack to change settings or read its storage,
  dark-mode answers to pages no longer include the purchase email or the site list, and a
  future-dated license stamp is no longer trusted.
- Settings import keeps a setting whose value has the wrong type instead of erasing it, and
  updates open tabs. The size limit for My filters now cuts at a whole line. Re-verifying your
  purchase no longer switches dark mode back on after you turned it off, and "Refresh license"
  says when ExtensionPay cannot be reached.
- Pages a filter list switches off entirely, such as the ad-industry opt-out page, now also keep
  their elements visible. A few filters that also let a site's own scripts or images through
  (uptoplay.net, im9.eu) now do both.
- **SponsorBlock stops when you switch its last category off.** Unticking the last category in
  Settings used to leave the video you were watching still skipping until you moved on to
  another one.
- **SponsorBlock no longer gives up on a video after one failed lookup.** A slow or busy
  SponsorBlock server, or StampStack waking up just then, used to make the whole video play its
  sponsors. The lookup is now retried a few times, and every video gets its own retries.
- **One SponsorBlock request per video, and settings changes keep your skips.** 2.2.2 asked
  SponsorBlock three times for every video you opened. Any settings change, even on another
  site, threw away the skip data of every open YouTube tab until it was fetched again.
- **The skip notice gets out of the way.** After it faded, the "Skipped sponsor" notice still
  caught clicks along the bottom of the page, and a click there could jump the video back, even
  the next video. It now really goes away, and its Undo only ever affects the video it was shown
  for. In fullscreen, clicking Undo no longer pauses the video. The notice is also shown in
  Chinese and read out by screen readers.
- Undoing one skipped segment no longer lets other segments that overlap it play.
- **SponsorBlock keeps skipping in the miniplayer and on Shorts, and now also works in YouTube
  videos embedded on other sites, youtube-nocookie.com included.** An embedded video only asks
  SponsorBlock once you start it.
- SponsorBlock ignores a segment that covers most of a video, which is bad or vandalized data,
  instead of jumping to the end.
- If you picked SponsorBlock categories in 2.2.0 or earlier and update straight from that
  version, your choices keep the meaning they had then.
- **Ads in the Shorts feed are removed.** Up to one Short in three was an ad. They are now
  dropped from the feed, as uBlock Origin does.
- **Block Shorts no longer throws away the video you are watching.** Ctrl-, Cmd- or
  Shift-clicking a Shorts link replaced the current tab with the YouTube home page and removed
  it from history. Those clicks now open a new tab as usual, and a plain click on a Shorts link
  simply does nothing.
- **Dark mode: formulas and dark logos no longer disappear.** Math on Wikipedia and other images
  drawn in black on a transparent background are now shown in light ink. Photos are still never
  changed.
- **Dark mode: no more white boxes around embedded widgets.** Chat buttons, payment fields and
  comment boxes from other sites used to show as a white box with faint text on dark pages. They
  now stay transparent, and frames a page writes itself are darkened too.
- **Dark mode keeps up with the page.** Theme switches (your system going light or dark, or a
  site's own theme button), stylesheets that load late, menus and cards that change color on
  hover or focus, and content that appears later inside web components are now recolored too.
- **Dark mode leaves sites that are already dark alone.** Their own background and their colored
  buttons and badges are kept. Only large white panels are darkened.
- **Turning dark mode off restores pages exactly.** Some inline backgrounds and borders used to be
  lost until the page was reloaded.
- Dark mode now also recolors dividers, the text of search boxes that have an icon, list bullets,
  decorative fades, tooltip arrows and icons drawn with dark fills.
- Dark mode no longer slows down pages that animate while you scroll, and a page opened in a
  background tab is fully dark when you switch to it.
- **Dark mode no longer changes what you write.** In editors such as Gmail's compose window,
  blog and forum editors, or Wikipedia's editor, dark mode's colors could be saved with your
  text, so a post or email could go out with near-white text. Editors now keep the site's own
  colors and show as a light box on the dark page. Some editors copy their starting text from
  the page as they open, and that text can still carry dark mode's colors: switch dark mode off
  for such a site.
- **Pages that wait for Google Analytics or Tag Manager show up at once.** StampStack replaces
  these scripts with a stand-in that sends nothing. The stand-in now also runs what the page
  queued for the real scripts. Pages with an "anti-flicker" snippet no longer stay blank for
  several seconds, and links and forms that continue from an analytics callback work again.
- **Sites using Google's ad tag no longer break half way.** Its stand-in now covers Google's whole
  documented interface and reports every ad slot as empty. Page scripts run to the end, and
  content that waits for an ad slot appears.
- **Browser games that use Google's H5 ad placements start and resume again.** No ad is shown and
  no reward is granted.
- **AdSense placeholders look like unfilled ads, not blocked ones.** This is how uBlock Origin gets
  past some "please disable your ad blocker" walls.
- **uBlock Origin's Unbreak list is now on by default.** It carries uBlock Origin's own repairs
  for sites that other lists break. As in uBlock Origin, it also narrows a few blocks that were
  too broad: sites such as fullstory.com, chartbeat.com and smartadserver.com work again,
  while their trackers stay blocked on every other site.
- The uBlock Origin list is now called "uBlock Origin — Ads" in Options. It never contained
  uBlock Origin's privacy list.
- The attributions page now lists the libraries StampStack bundles and links their license
  texts, which now ship inside the extension. EasyList Cookie's license is shown correctly.

## 2.3.0

- **Pages that would not load now load.** Some filters are written to block one kind of
  content, such as a page's scripts or images. About 135 of them also blocked the page itself,
  so Chrome showed "This page has been blocked by an extension" instead. It happened on any
  page with `/reklame/` (Norwegian for "advertising") or `-banner-ads-` in its address, on
  advertiser sites such as ads.google.com, ads.microsoft.com and ads.tiktok.com, and on
  newsletter links that pass through a click-counting address first. An EasyList China filter
  for 57 sites also blocked every link leaving them. uBlock Origin does not block whole pages
  for these filters, and StampStack no longer does either.
- **Scam and malware blocks now stop the right page.** Some of them blocked links leaving a bad
  site instead of the bad site itself, and did nothing when you typed its address or opened it
  from a bookmark. A few blocked the real site they were written to protect: discord.gift would
  not open when typed or clicked on discord.com.
- **Fixed: many news sites broke because of StampStack.** A script patch meant to stop one ad
  script on arstechnica.com, nypost.com, nbcnews.com, howtogeek.com and about 2,400 other
  sites also took basic page functions away from every other script on the page, such as
  creating elements, reading cookies and listening for events. Those functions now keep
  working, and only the targeted script is stopped. Some rules also silently dropped a page's
  own "on load" handler. They no longer do.
- **Script patches now run before the page does.** Filter-list script patches that stop
  anti-adblock walls and popups, such as the one for worldfreeware.com, used to arrive 30 to
  200 milliseconds after a page started, and often after it had finished loading. By then most
  had nothing left to stop. Chrome now runs them before the page's first script, including in
  frames a page creates for itself and on pages opened while StampStack's background worker
  was asleep. Rules written for a site name across all its endings, such as `yts.*`, work this
  way too. Patches for frames from other sites still arrive a little later, because StampStack
  first checks whether you switched off the page they are on.
- Because script patches now also reach the blank frames a page makes for itself, Chrome's
  developer console can show "Blocked script execution in 'about:blank' because the document's
  frame is sandboxed" on pages whose blank frames are not allowed to run scripts: twice per such
  frame on YouTube, once on most other sites. The message comes from StampStack. Nothing is
  broken and nothing needs doing. Chrome gives extensions no way to skip those frames, so each
  set of patches now reaches a page as a single file to keep the message to one line per set.
- **Chinese installs keep their ad hiding.** With the Chinese filter list on, Chrome refused all
  of StampStack's element hiding, and the YouTube ad blocking with it. StampStack turns that
  list on by itself when the browser is set to Chinese. Adding a site such as `10.0.0` in
  Settings did the same on any install. The Chinese list's broken entry is now skipped, and if
  Chrome ever turns down an update, the previous working setup stays in place.
- **A new look.** The icon is now a postage stamp with a postmark, in the same green as the rest
  of StampStack. The old one was a small scene of "AD" cards under a "BLOCK" stamp, and at
  toolbar size it turned into a smudge. The new one still reads as a stamp at 16 pixels, on
  light and dark toolbars alike. The popup and Settings show it where the green dot used to be.
  In the popup it goes grey whenever the current site is not being filtered, because StampStack
  is paused or turned off for that site, just as the dot did. In Settings it goes grey while
  StampStack is paused.
- **Plainer words.** "Scriptlets" are now called script patches in the popup, in Settings and
  in the breakage report email. The Settings subtitle says what StampStack is rather than how
  it is built, and the filter-list notes say "element hiding" instead of "cosmetics". After the
  first repair step, the panel used to say "Ads and scriptlets are still active". It meant ad
  blocking, and now says so. Settings now calls the sponsor toggle "Skip sponsor segments", as
  the popup already did, instead of "SponsorBlock skip".
- The element picker highlights in StampStack's green instead of teal. Its outline now sits
  exactly on the element under the pointer. It used to spill 4 pixels past the right and bottom
  edges, so on a full-width bar the right-hand side of the outline was off-screen.
- StampStack's name and description on the extensions page now appear in Simplified or
  Traditional Chinese when your browser is set to either.
- **Turning StampStack off for a site now follows the page you are on.** Switching off
  youtube.com used to also unblock YouTube videos embedded on every other site, with their ads
  and trackers. The same went for comment boxes and social widgets. Embeds on other sites now
  get network blocking, YouTube ad blocking, site-specific hiding and script patches again,
  and frames on a site you switched off get none of these. The lighter breakage fixes work
  the same way. Two gaps remain because Chrome decides them by each frame's own address:
  general ad hiding inside a frame still follows the frame's own site, and a YouTube player
  on a site you switched off still has its ads blocked.
- If Chrome refuses to switch blocking off or back on for a site, the popup now says the change
  did not take effect and shows the site as it really is. It used to show the site as switched
  off while blocking carried on. Settings > Add a site says so too, and keeps the address you
  typed. This is rare.
- Settings > Add a site now says why it cannot use an entry, such as an incomplete address
  like `10.0.0` or `192.168.1`, and keeps what you typed so you can correct it. It used to
  clear the field and do nothing. A pasted web address now adds its site.
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
- Script patches no longer leave anything behind on the page that a site could use to spot
  StampStack or switch its patches off.
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

## 2.2.3

- StampStack's name in the Chrome Web Store and on the extensions page is now
  "StampStack — Ad & Tracker Blocker". Nothing else changed.

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
