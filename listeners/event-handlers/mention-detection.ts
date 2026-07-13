/**
 * Decides whether an incoming message should be treated as a direct address to
 * the bot (which bypasses the anonymous-thread relay).
 *
 * `wasMention` is an explicit signal from the app_mention handler: it strips the
 * `<@bot>` markup before routing, so the message text alone can no longer prove
 * it was a mention. Trusting the flag prevents a mentioned reply in an anonymous
 * thread from being misrouted to the original questioner. Falls back to scanning
 * the text for the bot's user-id mention or a literal "@choir".
 */
export function isBotMentioned(message: string, botUserId: string | undefined, wasMention?: boolean): boolean {
  if (wasMention) return true;
  if (botUserId && message.includes(`<@${botUserId}>`)) return true;
  return message.includes('@choir');
}

/** True when a group-DM (mpim) message text mentions the bot, so app_mention owns it. */
export function mpimMessageMentionsBot(text: string, botUserId: string | undefined): boolean {
  return !!botUserId && text.includes(`<@${botUserId}>`);
}
