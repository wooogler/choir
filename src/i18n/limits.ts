/**
 * Slack Block Kit truncates — or rejects the whole view — when a text field is
 * over its cap, and a translation is routinely 1.5x the English it replaces.
 * So each key declares how long it may be, and the catalog test enforces that
 * in every locale at build time instead of at 2am in a customer's workspace.
 *
 * Declaring the kind per key would mean a second parallel structure to keep in
 * sync, so the kind is read off the key name instead: a key is named after the
 * element it fills, and the naming scheme is already
 * `<feature>.<surface>.<element>[.<variant>]`.
 */

export const SLACK_LIMITS = {
  title: 24,
  button: 75,
  option: 75,
  placeholder: 150,
  text: 3000,
} as const;

export type SlackLengthKind = keyof typeof SLACK_LIMITS;

/**
 * Segment names that pin a key to a kind. `submit` and `close` are Slack's own
 * names for a modal's two footer buttons, so they share the button cap.
 */
const KIND_BY_SEGMENT: Readonly<Record<string, SlackLengthKind>> = {
  title: 'title',
  button: 'button',
  submit: 'button',
  close: 'button',
  option: 'option',
  placeholder: 'placeholder',
};

/**
 * Reads a key's length kind off its segments, most specific first: the last
 * matching segment wins, so `docs.option.title` is a title (24) while
 * `common.button.cancel` is a button (75). Anything unmarked is body text.
 */
export function kindOfKey(key: string): SlackLengthKind {
  const segments = key.split('.');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const kind = KIND_BY_SEGMENT[segments[index]];
    if (kind) return kind;
  }
  return 'text';
}

/**
 * Runtime guard for strings the catalog cannot vet — anything interpolated
 * from user or model input. It returns a boolean rather than throwing so a
 * caller can truncate; the catalog test is what turns a violation into a
 * failed build.
 */
export function assertWithinSlackLimit(kind: SlackLengthKind, value: string): boolean {
  return value.length <= SLACK_LIMITS[kind];
}
