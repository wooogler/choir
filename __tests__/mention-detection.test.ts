import { isBotMentioned, mpimMessageMentionsBot } from '../listeners/event-handlers/mention-detection';

const BOT = 'U0BOT';

describe('isBotMentioned', () => {
  it('trusts the explicit wasMention flag even when the markup was stripped', () => {
    // app_mention strips "<@U0BOT>" before routing, leaving plain text.
    expect(isBotMentioned('how do I deploy?', BOT, true)).toBe(true);
  });

  it('detects the bot user-id mention in the raw text', () => {
    expect(isBotMentioned('<@U0BOT> how do I deploy?', BOT, false)).toBe(true);
  });

  it('detects a literal @choir', () => {
    expect(isBotMentioned('hey @choir help', undefined, false)).toBe(true);
  });

  it('returns false for an un-mentioned reply (so anonymous relay still runs)', () => {
    expect(isBotMentioned('thanks, that worked!', BOT, false)).toBe(false);
    expect(isBotMentioned('thanks, that worked!', BOT)).toBe(false);
  });

  it('does not misfire on another user mention', () => {
    expect(isBotMentioned('<@U0SOMEONE> ping', BOT, false)).toBe(false);
  });
});

describe('mpimMessageMentionsBot', () => {
  it('is true when a group-DM message mentions the bot (app_mention owns it)', () => {
    expect(mpimMessageMentionsBot('<@U0BOT> question', BOT)).toBe(true);
  });

  it('is false for a plain thread reply (dm-handler relays it)', () => {
    expect(mpimMessageMentionsBot('thanks!', BOT)).toBe(false);
  });

  it('is false when the bot id is unknown', () => {
    expect(mpimMessageMentionsBot('<@U0BOT> question', undefined)).toBe(false);
  });
});
