/**
 * Manual language choices made on the desk. A video override beats a channel override,
 * and both beat whatever detection found.
 */

export interface LanguageOverride {
  code: string | null;
  name: string;
}

export interface LanguageOverrides {
  videos: Record<string, LanguageOverride>;
  channels: Record<string, LanguageOverride>;
}

const STORAGE_KEY = "languageOverrides";

export function emptyLanguageOverrides(): LanguageOverrides {
  return { videos: {}, channels: {} };
}

export async function loadLanguageOverrides(): Promise<LanguageOverrides> {
  if (!browser.storage?.local) return emptyLanguageOverrides();
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<LanguageOverrides> | undefined;
  return {
    videos: raw?.videos && typeof raw.videos === "object" ? { ...raw.videos } : {},
    channels: raw?.channels && typeof raw.channels === "object" ? { ...raw.channels } : {},
  };
}

export async function saveLanguageOverrides(overrides: LanguageOverrides): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [STORAGE_KEY]: overrides });
}

export function languageOverrideFor(
  overrides: LanguageOverrides,
  videoId: string | null | undefined,
  channelName: string | null | undefined
): LanguageOverride | null {
  if (videoId && overrides.videos[videoId]) return overrides.videos[videoId];
  const channel = channelName?.trim();
  if (channel && overrides.channels[channel]) return overrides.channels[channel];
  return null;
}
