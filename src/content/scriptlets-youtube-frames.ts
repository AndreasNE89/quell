// MAIN-world document_start boot for YouTube embeds.
// Registered for every frame, but acts only in subframes: top-level YouTube pages get the same
// hooks from scriptlets-youtube.ts, whose registration excludes allowlisted hosts. An embed must
// follow the page it sits on, as network blocking does, and excludeMatches is tested against
// the frame's own URL — switching off youtube.com would otherwise unhook every embed elsewhere.

import { installYoutubeEarlyHooks } from '../scriptlets/library.js';

try {
  if (window !== window.top) installYoutubeEarlyHooks();
} catch {
  /* never break the page */
}
