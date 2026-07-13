// MAIN-world document_start boot for YouTube.
// Runs before the player bootstrap so adPlacements can be stripped in time.
// List-scoped scriptlets still apply later via scriptlets.js.

import { installYoutubeEarlyHooks } from '../scriptlets/library.js';

try {
  installYoutubeEarlyHooks();
} catch {
  /* never break the page */
}
