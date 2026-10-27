import { avatarFromWatchHtml, loadChannelAvatars, recordChannelAvatars } from "../../utils/channelAvatars";

const avatarTried = new Set<string>();
let avatarFill: Promise<unknown> = Promise.resolve();
const AVATAR_MISSES_KEY = "channelAvatarMisses";
/** A watch page without an avatar is ~1 MB; the service worker restarts often, so misses are remembered for a week. */
const AVATAR_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Watch pages are big; a few per summary is enough to fill the gaps over time without hammering YouTube. */
const AVATAR_FETCHES_PER_RUN = 4;

/**
 * Channels watched before avatars were recorded, or only ever seen in a background tab, get their avatar from
 * one of their videos' watch pages. Each channel is tried once per service worker life.
 */
export function fillChannelAvatars(channels: { channelName: string; videoId: string }[]): void {
  avatarFill = avatarFill.then(async () => {
    const known = await loadChannelAvatars();
    const now = Date.now();
    const stored = (await browser.storage.local.get(AVATAR_MISSES_KEY))[AVATAR_MISSES_KEY] as Record<string, number> | undefined;
    const misses = Object.fromEntries(Object.entries(stored ?? {}).filter(([, at]) => now - at < AVATAR_RETRY_MS));
    const missing = channels
      .filter(
        (channel) =>
          channel.channelName &&
          channel.channelName !== "Unknown channel" &&
          !known[channel.channelName] &&
          !avatarTried.has(channel.channelName) &&
          misses[channel.channelName] === undefined
      )
      .slice(0, AVATAR_FETCHES_PER_RUN);
    if (missing.length === 0) return;
    const found: Record<string, string> = {};
    for (const channel of missing) {
      avatarTried.add(channel.channelName);
      try {
        const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(channel.videoId)}`);
        if (response.url.includes("/sorry")) break;
        const avatar = avatarFromWatchHtml(await response.text());
        if (avatar) found[channel.channelName] = avatar;
        else misses[channel.channelName] = now;
      } catch (error) {
        console.warn("[Study Harvester] channel avatar:", error);
      }
    }
    await recordChannelAvatars(found);
    await browser.storage.local.set({ [AVATAR_MISSES_KEY]: misses });
  }).catch(() => {});
}
