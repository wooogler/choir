/**
 * Milkdown/Crepe's own chrome, translated.
 *
 * Crepe has no i18n API: every label it renders is a default inside its feature
 * definitions. What it does have is `featureConfigs`, where each of those
 * defaults can be replaced — so translating the editor means handing it a
 * complete set of overrides rather than switching a locale on it. This module
 * is that set; everything Crepe shows that is a word rather than an icon is
 * listed here, and anything missing would silently stay English.
 *
 * NOTE: the slash menu filters on the *label*, so localizing the labels
 * localizes the shortcuts too — in Korean `/제목` matches "제목 1" and `/heading`
 * matches nothing. That is Crepe's behaviour (`getGroups()` does
 * `item.label.toLowerCase().includes(filter)`), not something this module can
 * decouple, and it is the reason the Korean labels keep the English words for
 * the two items people type in English anyway.
 */

import { Crepe } from '@milkdown/crepe';
import type { Locale } from './supported-locales';
import { createT } from './translate';

/**
 * The localized fragment of Crepe's `featureConfigs`. The caller merges its own
 * behavioural config (upload handlers, URL proxying) on top of the image-block
 * entry — see CrepeEditor.
 */
export function crepeFeatureConfigs(locale: Locale) {
  const t = createT(locale);

  return {
    [Crepe.Feature.Placeholder]: {
      text: t('editor.placeholder'),
    },
    [Crepe.Feature.BlockEdit]: {
      textGroup: {
        label: t('editor.slash.group.text'),
        text: { label: t('editor.slash.text') },
        h1: { label: t('editor.slash.h1') },
        h2: { label: t('editor.slash.h2') },
        h3: { label: t('editor.slash.h3') },
        h4: { label: t('editor.slash.h4') },
        h5: { label: t('editor.slash.h5') },
        h6: { label: t('editor.slash.h6') },
        quote: { label: t('editor.slash.quote') },
        divider: { label: t('editor.slash.divider') },
      },
      listGroup: {
        label: t('editor.slash.group.list'),
        bulletList: { label: t('editor.slash.bulletList') },
        orderedList: { label: t('editor.slash.orderedList') },
        taskList: { label: t('editor.slash.taskList') },
      },
      advancedGroup: {
        label: t('editor.slash.group.advanced'),
        image: { label: t('editor.slash.image') },
        codeBlock: { label: t('editor.slash.codeBlock') },
        table: { label: t('editor.slash.table') },
        math: { label: t('editor.slash.math') },
      },
    },
    [Crepe.Feature.ImageBlock]: {
      blockUploadButton: t('editor.image.uploadButton'),
      blockConfirmButton: t('editor.image.confirmButton'),
      blockCaptionPlaceholderText: t('editor.image.captionPlaceholder'),
      blockUploadPlaceholderText: t('editor.image.uploadPlaceholder'),
      inlineUploadButton: t('editor.image.uploadButtonInline'),
      inlineUploadPlaceholderText: t('editor.image.uploadPlaceholder'),
    },
    [Crepe.Feature.LinkTooltip]: {
      inputPlaceholder: t('editor.link.placeholder'),
    },
    [Crepe.Feature.CodeMirror]: {
      searchPlaceholder: t('editor.code.searchPlaceholder'),
      noResultText: t('editor.code.noResult'),
      copyText: t('editor.code.copy'),
      previewLabel: t('editor.code.previewLabel'),
      previewLoading: t('editor.code.previewLoading'),
      previewToggleText: (previewOnlyMode: boolean) =>
        previewOnlyMode ? t('editor.code.previewEdit') : t('editor.code.previewHide'),
    },
  } as const;
}
