/**
 * The Korean catalog.
 *
 * Typed as a partial overlay so an untranslated feature ships English rather
 * than blocking a release: `t` resolves the fallback per key, not per file. The
 * `LocaleCatalog` annotation still makes a key that no longer exists in English
 * a compile error, which is how stale translations get caught.
 */

import type { LocaleCatalog } from '../../types';
import { appHome } from './app-home';
import { common } from './common';
import { conversation } from './conversation';
import { notifications } from './notifications';
import { qa } from './qa';
import { registration } from './registration';

export const ko: LocaleCatalog = {
  ...common,
  ...appHome,
  ...notifications,
  ...registration,
  ...qa,
  ...conversation,
};
