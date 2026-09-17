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
import { appHomeGithub } from './app-home-github';
import { common } from './common';
import { conversation } from './conversation';
import { dm } from './dm';
import { docUpdateActions } from './doc-update-actions';
import { docUpdateExtract } from './doc-update-extract';
import { docUpdateSuggestions } from './doc-update-suggestions';
import { errors } from './errors';
import { indexManagement } from './index-management';
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
  ...dm,
  ...docUpdateExtract,
  ...docUpdateSuggestions,
  ...docUpdateActions,
  ...appHomeGithub,
  ...indexManagement,
  ...errors,
};
