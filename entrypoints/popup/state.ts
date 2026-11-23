import { VideoData } from "../../utils/storage";
import type { StoreState } from "../../utils/store";

export const LAST_PLAYING_SESSION_KEY = "lastPlayingByWindow";

interface PopupState {
  videoData: VideoData[];
  popupWindowId: number | null;
  lastPlayingTabId: number | null;
  resolvedNowPlayingTabIds: number[];
  pinnedNowPlayingTabId: number | null;
  storeState: StoreState;
  lastVideoListFingerprint: string;
  lastNowPlayingDetectAt: number;
  nowPlayingDetectPromise: Promise<VideoData[]> | null;
  nowPlayingRefineTimeout: ReturnType<typeof setTimeout> | null;
  siteBlockLoaded: boolean;
}

/** Mutable values shared across modules; ES module bindings can't be reassigned by importers. */
export const popup: PopupState = {
  videoData: [],
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
  siteBlockLoaded: false,
};
