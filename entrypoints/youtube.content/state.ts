import type { MandalaStatus, VideoChapter } from "../../utils/storage";
import type { TranscriptSentence } from "../../utils/transcript";
import type { ListenCheckState } from "./listen-first";

export const DEBOUNCE_MS = 150;

export const perf = {
  totalMutations: 0,
  totalReads: 0,
  mutationsSinceLastRead: 0,
};

export interface CachedMetadataPayload {
  videoId: string | null;
  title: string;
  channelName: string;
  channelAvatar?: string | null;
  seconds: number;
  currentTime: number;
  isLive: boolean;
  language?: string | null;
  languageName?: string | null;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  chapters?: VideoChapter[];
}

export const MAX_WAIT_MS = 1000;

export interface ImmersionTranscript {
  videoId: string;
  languageCode: string | null;
  punctuated: boolean;
  sentences: TranscriptSentence[];
  frequencies: Map<string, number>;
}

interface PageState {
  lastMetadata: CachedMetadataPayload;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastReadTime: number;
  immersionTranscript: ImmersionTranscript | null;
  pendingTranscript: { videoId: string; request: Promise<ImmersionTranscript | null> } | null;
  sessionWatchedSeconds: number;
  lastWatchTickTimestamp: number;
  lastWatchMediaTime: number | null;
  lastMandalaStatusCheck: number;
  watchedTimerInterval: ReturnType<typeof setInterval> | null;
  sentencePlayback: {
  startSeconds: number;
  endSeconds: number;
  restoreRate: number | null;
  pauseAtEnd: boolean;
} | null;
  closeOpenClozeModal: ((resume: boolean) => void) | null;
  handleClozeModalKey: ((keyboardEvent: KeyboardEvent) => boolean) | null;
  latestMandalaStatus: MandalaStatus;
  isPillarPopoverOpen: boolean;
  popoverPillarIndex: number | null;
  currentWatchVideoId: string | null;
  listenFirst: boolean;
  listenState: ListenCheckState | null;
  listenPreviousTime: number | null;
  listenVideoTally: { caught: number; read: number; missed: number; };
}

/** Mutable values shared across modules; ES module bindings can't be reassigned by importers. */
export const page: PageState = {
  lastMetadata: {
  videoId: null,
  title: "",
  channelName: "",
  seconds: 0,
  currentTime: 0,
  isLive: false,
  language: null,
  languageName: null,
  paused: true,
  volume: 1,
  muted: false,
  chapters: undefined,
},
  debounceTimer: null,
  lastReadTime: 0,
  immersionTranscript: null,
  pendingTranscript: null,
  sessionWatchedSeconds: 0,
  lastWatchTickTimestamp: Date.now(),
  lastWatchMediaTime: null,
  lastMandalaStatusCheck: 0,
  watchedTimerInterval: null,
  sentencePlayback: null,
  closeOpenClozeModal: null,
  handleClozeModalKey: null,
  latestMandalaStatus: {
  connected: false,
  cached: false,
  pillars: [],
  savedPillarIndexes: [],
},
  isPillarPopoverOpen: false,
  popoverPillarIndex: null,
  currentWatchVideoId: null,
  listenFirst: false,
  listenState: null,
  listenPreviousTime: null,
  listenVideoTally: { caught: 0, read: 0, missed: 0 },
};
