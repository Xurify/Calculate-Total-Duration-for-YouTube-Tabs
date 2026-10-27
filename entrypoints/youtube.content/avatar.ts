import { cleanChannelAvatarUrl } from "../../utils/channelAvatars";

// Watch pages, Shorts and YouTube's newer view-model markup each put the uploader's avatar somewhere else.
const CHANNEL_AVATAR_SELECTORS = [
  "ytd-watch-metadata #owner #avatar img",
  "ytd-video-owner-renderer #avatar img",
  "ytd-watch-metadata #owner yt-img-shadow img",
  "ytd-reel-video-renderer[is-active] #channel-thumbnail img",
  "ytd-reel-video-renderer[is-active] yt-decorated-avatar-view-model img",
  "ytd-reel-video-renderer[is-active] .ytReelChannelBarViewModelChannelAvatar img",
];

const reportedAvatars = new Set<string>();

/** Desk tabs are read but often never played, so their avatar is passed on as soon as it is seen. */
export function reportChannelAvatar(channelName: string, avatar: string | null): void {
  const name = channelName.trim();
  if (!name || !avatar || reportedAvatars.has(name)) return;
  reportedAvatars.add(name);
  void browser.runtime.sendMessage({ action: "record-channel-avatars", avatars: { [name]: avatar } }).catch(() => reportedAvatars.delete(name));
}

/** Lazy images hold a blank data: URL until they load, so only a real avatar host counts. */
export function readChannelAvatar(): string | null {
  for (const selector of CHANNEL_AVATAR_SELECTORS) {
    for (const img of document.querySelectorAll<HTMLImageElement>(selector)) {
      const url = cleanChannelAvatarUrl(img.currentSrc || img.src);
      if (url) return url;
    }
  }
  return null;
}
