import { VideoData } from "../../utils/storage";
import type { StoreState } from "../../utils/store";
import type { ChannelAvatars } from "../../utils/channelAvatars";

export const LAST_PLAYING_SESSION_KEY = "lastPlayingByWindow";

interface PopupState {
  popupChannelAvatars: ChannelAvatars;
  videoData: VideoData[];
  sortByDuration: boolean;
  currentView: "dashboard" | "settings";
  popupWindowId: number | null;
  lastPlayingTabId: number | null;
  resolvedNowPlayingTabIds: number[];
  pinnedNowPlayingTabId: number | null;
  storeState: StoreState;
  lastVideoListFingerprint: string;
  lastNowPlayingDetectAt: number;
  nowPlayingDetectPromise: Promise<VideoData[]> | null;
  nowPlayingRefineTimeout: ReturnType<typeof setTimeout> | null;
  lastVolumeInputTime: number;
  siteBlockLoaded: boolean;
}

/** Mutable values shared across modules; ES module bindings can't be reassigned by importers. */
export const popup: PopupState = {
  popupChannelAvatars: {},
  videoData: [],
  sortByDuration: false,
  currentView: "dashboard",
  popupWindowId: null,
  lastPlayingTabId: null,
  resolvedNowPlayingTabIds: [],
  pinnedNowPlayingTabId: null,
  storeState: {
  prefs: {
    sortByDuration: false,
    excludedUrls: [],
    thumbnailQuality: "high",
    layoutMode: "grid",
    groupingMode: "none",
    sortOption: "duration-desc",
  },
  metadataCache: {},
},
  lastVideoListFingerprint: "",
  lastNowPlayingDetectAt: 0,
  nowPlayingDetectPromise: null,
  nowPlayingRefineTimeout: null,
  lastVolumeInputTime: 0,
  siteBlockLoaded: false,
};
