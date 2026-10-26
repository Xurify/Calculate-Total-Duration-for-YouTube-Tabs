const STORAGE_KEY = "channelAvatars";
const AVATAR_HOSTS = new Set(["yt3.ggpht.com", "yt3.googleusercontent.com"]);

/** channelName → avatar URL. Kept apart from the watch log so each sitting doesn't repeat the URL. */
export type ChannelAvatars = Record<string, string>;

export function cleanChannelAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AVATAR_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export async function loadChannelAvatars(): Promise<ChannelAvatars> {
  if (!browser.storage?.local) return {};
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  return raw && typeof raw === "object" ? (raw as ChannelAvatars) : {};
}

export function recordChannelAvatar(channelName: string, url: string): Promise<void> {
  return recordChannelAvatars({ [channelName]: url });
}

/** Avatars are shown at most 44 px wide, so 88 px keeps them sharp on 2× screens without fetching 900 px. */
export const AVATAR_PIXELS = 88;

/** yt3 URLs carry their size as `=s48-…` or `=s900-…`; any size can be asked for. */
export function sizedAvatarUrl(url: string, pixels = AVATAR_PIXELS): string {
  return url.replace(/=s\d+(-|$)/, `=s${pixels}$1`);
}

function decodeJsonString(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

/** The uploader's avatar from a watch page's ytInitialData. */
export function avatarFromWatchHtml(html: string): string | null {
  const match = html.match(/"videoOwnerRenderer":\{"thumbnail":\{"thumbnails":\[\{"url":"((?:[^"\\]|\\.)+)"/);
  const url = match ? cleanChannelAvatarUrl(decodeJsonString(match[1])) : null;
  return url ? sizedAvatarUrl(url) : null;
}

/** A channel page names its avatar as the og:image. */
export function avatarFromChannelHtml(html: string): string | null {
  const match = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const url = match ? cleanChannelAvatarUrl(match[1].replace(/&amp;/g, "&")) : null;
  return url ? sizedAvatarUrl(url) : null;
}

let avatarWrites: Promise<unknown> = Promise.resolve();

/** Writes are chained so two tabs reporting at once don't drop each other's avatar. */
export function recordChannelAvatars(found: Record<string, string>): Promise<void> {
  const run = avatarWrites.then(async () => {
    if (!browser.storage?.local) return;
    const avatars = await loadChannelAvatars();
    let changed = false;
    for (const [channelName, raw] of Object.entries(found)) {
      const name = channelName.trim();
      const url = cleanChannelAvatarUrl(raw);
      if (!name || !url || avatars[name] === sizedAvatarUrl(url)) continue;
      avatars[name] = sizedAvatarUrl(url);
      changed = true;
    }
    if (changed) await browser.storage.local.set({ [STORAGE_KEY]: avatars });
  });
  avatarWrites = run.catch(() => {});
  return run;
}

export const CHANNEL_AVATARS_KEY = STORAGE_KEY;
