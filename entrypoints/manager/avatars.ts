import { getVideoIdFromUrl } from "../../utils/format";
import { app } from "./state";
import { escapeHtml } from "./util";

const avatarRequested = new Set<string>();

export function requestMissingChannelAvatars(): void {
  const missing = new Map<string, string>();
  for (const video of app.allVideos) {
    const videoId = getVideoIdFromUrl(video.url);
    const name = video.channelName?.trim();
    if (!name || !videoId || app.deskChannelAvatars[name] || avatarRequested.has(name) || missing.has(name)) continue;
    missing.set(name, videoId);
  }
  if (missing.size === 0) return;
  for (const name of missing.keys()) avatarRequested.add(name);
  void browser.runtime
    .sendMessage({ action: "fill-channel-avatars", channels: [...missing].map(([channelName, videoId]) => ({ channelName, videoId })) })
    .catch(() => {});
}

export function deskAvatarHtml(channelName: string | null | undefined, size = "w-4 h-4 text-[8px]"): string {
  const name = channelName?.trim();
  return name ? channelAvatarHtml(name, app.deskChannelAvatars[name] ?? null, size) : "";
}

export function channelLetterHtml(letter: string, size = "w-5 h-5 text-[10px]"): string {
  return `<span class="ui-avatar ${size}" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

export function channelAvatarHtml(channelName: string, avatarUrl: string | null, size = "w-5 h-5 text-[10px]"): string {
  const letter = Array.from(channelName.trim())[0]?.toUpperCase() ?? "?";
  if (!avatarUrl) return channelLetterHtml(letter, size);
  return `<img src="${escapeHtml(avatarUrl)}" alt="" class="channel-avatar ui-avatar ${size}" loading="lazy" referrerpolicy="no-referrer" data-letter="${escapeHtml(letter)}" data-size="${escapeHtml(size)}">`;
}
