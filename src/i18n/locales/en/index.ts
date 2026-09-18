/**
 * The English catalog, and with it the set of keys the whole app may use.
 *
 * English is the source of truth: `MessageKey` is derived from this object, so
 * a feature ships its strings here first and every other locale is a partial
 * overlay on top of it. Feature catalogs stay in their own files and are
 * spread together here, which keeps merge conflicts inside one feature.
 */

import { appHome } from './app-home';
import { appHomeGithub } from './app-home-github';
import { common } from './common';
import { conversation } from './conversation';
import { dm } from './dm';
import { docUpdateActions } from './doc-update-actions';
import { docUpdateExtract } from './doc-update-extract';
import { docUpdateSuggestions } from './doc-update-suggestions';
import { errors } from './errors';
import { gdocs } from './gdocs';
import { importStrings } from './import';
import { indexManagement } from './index-management';
import { notifications } from './notifications';
import { qa } from './qa';
import { registration } from './registration';

export const en = {
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
  ...gdocs,
  ...importStrings,
} as const;
