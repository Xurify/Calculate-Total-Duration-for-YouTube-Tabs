import type { CustomSelectHandle } from "./custom-select";
import { VideoData, type SavedSession, type LiveTabSectionsState } from "../../utils/storage";
import type { ChannelAvatars } from "../../utils/channelAvatars";
import type { ReadingListItem } from "../../utils/readingList";
import { emptyLanguageOverrides, type LanguageOverrides } from "../../utils/languageOverrides";

interface WindowGroup {
  id: number;
  tabs: VideoData[];
  duration: number;
  label: string;
}

export let selectedTabIds = new Set<number>();

/** Tab + video ids whose spoken language was read from the page player response. */
export const pageLanguageConfirmed = new Set<string>();

export let collapsedGroups = new Set<string>();

/** When viewing a saved session, URLs of tabs selected in the grid/list (for remove-from-session). */
export let selectedSessionTabUrls = new Set<string>();

interface AppState {
  allVideos: VideoData[];
  windowGroups: WindowGroup[];
  currentWindowId: number | 'all';
  isReadingListView: boolean;
  /** Top-nav "Saved sessions" view: lists sessions instead of the board. */
  isSessionsView: boolean;
  isTimeView: boolean;
  isPracticeView: boolean;
  savedSessionsCount: number;
  readingListItems: ReadingListItem[];
  selectedPlaybackSpeed: number;
  searchQuery: string;
  groupingMode: 'none' | 'channel' | 'language';
  layoutMode: 'list' | 'grid';
  thumbnailQuality: 'standard' | 'high';
  isSettingsOpen: boolean;
  sortOption: string;
  sortSelectHandle: CustomSelectHandle | null;
  restoreTargetSelect: CustomSelectHandle | null;
  saveSessionTargetSelect: CustomSelectHandle | null;
  showDuplicatesOnly: boolean;
  /** Video-id counts for the current view scope (all windows, one window, or saved session). */
  scopeVideoIdCounts: Map<string, number>;
  lastTabListFingerprint: string;
  skippedTabListDom: boolean;
  lastSidebarFingerprint: string;
  /** True when `#tab-list` `innerHTML` was replaced this `renderMain()` pass (not when fingerprint short-circuits). */
  tabListContainerInnerHtmlUpdated: boolean;
  lastSelectionRowSyncSig: string;
  lastMoveToSectionPopoverSig: string;
  sidebarContextTarget: { type: "all" | "window" | "session"; windowId?: number; sessionId?: string } | null;
  /** When set, main view shows this session's tab list instead of live windows. */
  selectedSession: SavedSession | null;
  sessionSidebarSearch: string;
  lastSavedSessionsFingerprint: string;
  liveTabSectionsState: LiveTabSectionsState;
  tabSectionContextTarget: { mode: "session"; url: string } | { mode: "live"; tabId: number } | null;
  sectionHeaderContextTarget: { sectionId: string } | null;
  deskChannelAvatars: ChannelAvatars;
  languageOverrides: LanguageOverrides;
  lastFacetRailHtml: string;
  planBudgetMinutes: number | null;
  focusedRowKey: string | null;
  channelLanguageFilter: string | null;
  timeViewShown: boolean;
}

/** Mutable values shared across modules; ES module bindings can't be reassigned by importers. */
export const app: AppState = {
  allVideos: [],
  windowGroups: [],
  currentWindowId: 'all',
  isReadingListView: false,
  isSessionsView: false,
  isTimeView: false,
  isPracticeView: false,
  savedSessionsCount: 0,
  readingListItems: [],
  selectedPlaybackSpeed: 1.0,
  searchQuery: "",
  groupingMode: 'none',
  layoutMode: 'list',
  thumbnailQuality: 'high',
  isSettingsOpen: false,
  sortOption: 'started-first',
  sortSelectHandle: null,
  restoreTargetSelect: null,
  saveSessionTargetSelect: null,
  showDuplicatesOnly: false,
  scopeVideoIdCounts: new Map<string, number>(),
  lastTabListFingerprint: "",
  skippedTabListDom: false,
  lastSidebarFingerprint: "",
  tabListContainerInnerHtmlUpdated: false,
  lastSelectionRowSyncSig: "",
  lastMoveToSectionPopoverSig: "",
  sidebarContextTarget: null,
  selectedSession: null,
  sessionSidebarSearch: "",
  lastSavedSessionsFingerprint: "",
  liveTabSectionsState: { sections: [], assignments: {} },
  tabSectionContextTarget: null,
  sectionHeaderContextTarget: null,
  deskChannelAvatars: {},
  languageOverrides: emptyLanguageOverrides(),
  lastFacetRailHtml: "",
  planBudgetMinutes: 45,
  focusedRowKey: null,
  channelLanguageFilter: null,
  timeViewShown: false,
};
