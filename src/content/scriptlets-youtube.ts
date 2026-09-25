// MAIN-world document_start boot for YouTube.
// Runs before the player bootstrap so adPlacements can be stripped in time.
// List scriptlets come separately, from the registered shard scripts (scriptlets-runtime.js).

import { installYoutubeEarlyHooks } from '../scriptlets/library.js';

try {
  installYoutubeEarlyHooks();
} catch {
  /* never break the page */
}
