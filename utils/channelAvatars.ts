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

export async function recordChannelAvatar(channelName: string, url: string): Promise<void> {
  const name = channelName.trim();
  if (!name || !browser.storage?.local) return;
  const avatars = await loadChannelAvatars();
  if (avatars[name] === url) return;
  avatars[name] = url;
  await browser.storage.local.set({ [STORAGE_KEY]: avatars });
}
