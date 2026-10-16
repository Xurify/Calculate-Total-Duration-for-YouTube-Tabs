/**
 * Content script that runs on YouTube watch/shorts pages.
 * Handles metadata caching, chapter extraction, transcript sentence navigation,
 * cloze capture, and in-player Mandala integration.
 */
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { resolveVideoLanguage, type VideoChannel } from "../utils/channelLanguage";
import { registerBridgeListener } from "../utils/webmcpBridge";
import { extractChaptersFromPlayerResponse } from "../utils/chapters";
import type { MandalaStatus, VideoChapter, StagedClozeCard } from "../utils/storage";
import {
  buildSentences,
  countWordFrequencies,
  maskSentence,
  pickClozeToken,
  segmentWords,
  sentenceIndexAt,
  type TranscriptSentence,
  type WordToken,
} from "../utils/transcript";
import { requestPageTranscript } from "../utils/youtubeTranscript";

const DEBOUNCE_MS = 150;

const perf = {
  totalMutations: 0,
  totalReads: 0,
  mutationsSinceLastRead: 0,
};

interface CachedMetadataPayload {
  videoId: string | null;
  title: string;
  channelName: string;
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

let lastMetadata: CachedMetadataPayload = {
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
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastReadTime = 0;
const MAX_WAIT_MS = 1000;

interface ImmersionTranscript {
  videoId: string;
  languageCode: string | null;
  punctuated: boolean;
  sentences: TranscriptSentence[];
  frequencies: Map<string, number>;
}

let immersionTranscript: ImmersionTranscript | null = null;
let pendingTranscript: { videoId: string; request: Promise<ImmersionTranscript | null> } | null = null;

let sessionWatchedSeconds = 0;
let lastWatchTickTimestamp = Date.now();
let watchedTimerInterval: ReturnType<typeof setInterval> | null = null;

let sentencePlayback: {
  startSeconds: number;
  endSeconds: number;
  restoreRate: number | null;
  pauseAtEnd: boolean;
} | null = null;

let closeOpenClozeModal: ((resume: boolean) => void) | null = null;
let handleClozeModalKey: ((keyboardEvent: KeyboardEvent) => boolean) | null = null;

let latestMandalaStatus: MandalaStatus = {
  connected: false,
  cached: false,
  pillars: [],
  savedPillarIndexes: [],
};

let isPillarPopoverOpen = false;
let currentWatchVideoId: string | null = null;

function getVideoIdFromLocation(): string | null {
  try {
    const pathname = window.location.pathname;
    const search = window.location.search;
    if (pathname.startsWith("/shorts/")) {
      const match = pathname.match(/\/shorts\/([^/?]+)/);
      return match ? match[1] : null;
    }
    if (pathname === "/watch" && search) {
      const searchParameters = new URLSearchParams(search);
      return searchParameters.get("v");
    }
  } catch {
    // Ignore URL parse failure
  }
  return null;
}

type PlayerResponseShape = Parameters<typeof detectLanguageFromPlayerResponse>[0] & {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    isLive?: boolean;
    lengthSeconds?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode: string;
        kind?: string;
      }>;
    };
  };
};

function readPlayerResponseFromPage(): PlayerResponseShape | null {
  try {
    const moviePlayerElement = document.getElementById("movie_player") as (HTMLElement & {
      getPlayerResponse?: () => PlayerResponseShape;
    }) | null;
    if (moviePlayerElement && typeof moviePlayerElement.getPlayerResponse === "function") {
      const playerResponse = moviePlayerElement.getPlayerResponse();
      if (playerResponse) return playerResponse;
    }
  } catch {
    // Ignore player element response failure
  }

  try {
    const fromWindow = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseShape })
      .ytInitialPlayerResponse;
    if (fromWindow) return fromWindow;
  } catch {
    // Ignore window read failure
  }

  try {
    for (const scriptElement of document.querySelectorAll("script:not([src])")) {
      const scriptContent = scriptElement.textContent;
      if (!scriptContent?.includes("ytInitialPlayerResponse")) continue;
      const playerResponseMatch =
        scriptContent.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
        scriptContent.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
      if (!playerResponseMatch) continue;
      return JSON.parse(playerResponseMatch[1]) as PlayerResponseShape;
    }
  } catch {
    // Ignore script parse failure
  }

  return null;
}

async function extractLanguageFromDom(): Promise<DetectedLanguage | undefined> {
  const playerResponse = readPlayerResponseFromPage();
  if (!playerResponse) return undefined;
  return resolveVideoLanguage(
    detectLanguageFromPlayerResponse(playerResponse),
    languageTextFromPlayerResponse(playerResponse),
    { channelName: playerResponse.videoDetails?.author, videoId: playerResponse.videoDetails?.videoId },
    document.documentElement.lang
  );
}

function parseDurationFromTimeText(durationText: string): number {
  const durationParts = durationText.trim().split(":").map((durationPart) => parseInt(durationPart, 10) || 0);
  if (durationParts.length === 3) return durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
  if (durationParts.length === 2) return durationParts[0] * 60 + durationParts[1];
  if (durationParts.length === 1) return durationParts[0];
  return 0;
}

async function readMetadataFromDom(): Promise<CachedMetadataPayload> {
  const videoId = getVideoIdFromLocation();
  const videoElement = document.querySelector("video");
  const currentTime = videoElement ? videoElement.currentTime : 0;
  let duration = 0;

  const videoDuration = videoElement?.duration;
  if (videoDuration != null && isFinite(videoDuration) && videoDuration > 0) {
    duration = videoDuration;
  }
  if (duration === 0) {
    const durationElement = document.querySelector(".ytp-time-duration");
    if (durationElement?.textContent) {
      duration = parseDurationFromTimeText(durationElement.textContent);
    }
  }

  const playerResponse = readPlayerResponseFromPage();
  if (duration === 0 && playerResponse?.videoDetails?.lengthSeconds) {
    duration = parseInt(playerResponse.videoDetails.lengthSeconds, 10) || 0;
  }

  let title =
    (document.querySelector("h1.ytd-watch-metadata yt-formatted-string") as HTMLElement)?.innerText ||
    (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
    (document.querySelector("ytd-watch-metadata h1") as HTMLElement)?.innerText ||
    playerResponse?.videoDetails?.title ||
    document.title;
  title = title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();

  const channelName =
    (document.querySelector("ytd-watch-metadata ytd-channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
    playerResponse?.videoDetails?.author ||
    "";

  let isLive = false;
  const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
  if (liveBadge && getComputedStyle(liveBadge).display !== "none") {
    isLive = true;
  }

  const detected = await extractLanguageFromDom();
  const language = detected?.language;
  const languageName = detected?.languageName;
  const volume = videoElement ? videoElement.volume : 1;
  const muted = videoElement ? videoElement.muted : false;
  const paused = videoElement ? videoElement.paused : true;

  const chapters = extractChaptersFromPlayerResponse(playerResponse, isLive ? 0 : duration);

  return {
    videoId,
    title: title || "YouTube Video",
    channelName,
    seconds: isLive ? 0 : duration,
    currentTime,
    isLive,
    language,
    languageName,
    paused,
    volume,
    muted,
    chapters: chapters.length > 0 ? chapters : undefined,
  };
}

function scheduleRead(context: { setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown }) {
  const now = Date.now();
  const timeSinceLastRead = now - lastReadTime;

  if (debounceTimer != null) {
    if (timeSinceLastRead > MAX_WAIT_MS) {
      return;
    }
    clearTimeout(debounceTimer as unknown as number);
  }
  debounceTimer = context.setTimeout(() => {
    debounceTimer = null;
    if (!isWatchOrShorts()) return;
    lastReadTime = Date.now();
    perf.totalReads++;
    perf.mutationsSinceLastRead = 0;
    void readMetadataFromDom().then((metadata) => {
      lastMetadata = metadata;
      updateImmersionHud();
    });
  }, DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>;
}

function isWatchOrShorts(): boolean {
  const pathname = window.location.pathname;
  return pathname.startsWith("/watch") || pathname.startsWith("/shorts/");
}

function getPlaybackState() {
  const videoElement = document.querySelector("video");
  if (!videoElement) {
    return { paused: true, volume: 1, muted: false, currentTime: 0 };
  }
  return {
    paused: videoElement.paused,
    volume: videoElement.volume,
    muted: videoElement.muted,
    currentTime: videoElement.currentTime,
  };
}

function togglePlayback() {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  if (videoElement.paused) {
    void videoElement.play();
  } else {
    videoElement.pause();
  }
  return getPlaybackState();
}

function setPlaybackVolume(volume: number) {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  const clampedVolume = Math.min(1, Math.max(0, volume));
  videoElement.volume = clampedVolume;
  if (clampedVolume > 0 && videoElement.muted) {
    videoElement.muted = false;
  }
  return getPlaybackState();
}

function extractLiveCaptionText(): string {
  const segmentElements = document.querySelectorAll(".ytp-caption-segment");
  if (segmentElements.length === 0) return "";
  const textParts: string[] = [];
  for (const segmentElement of segmentElements) {
    const textContent = segmentElement.textContent?.trim();
    if (textContent) {
      textParts.push(textContent);
    }
  }
  return textParts.join(" ").replace(/\s+/g, " ").trim();
}

function getTargetPlayerContainer(): HTMLElement {
  const playerContainer =
    document.getElementById("movie_player") ||
    document.querySelector(".html5-video-player") ||
    document.querySelector("#player");

  if (playerContainer && playerContainer instanceof HTMLElement) {
    return playerContainer;
  }
  return document.body;
}

function showImmersionToast(messageText: string, accentColor = "#e3aa50") {
  const existingToast = document.getElementById("study-harvester-hud-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const container = getTargetPlayerContainer();
  const toastElement = document.createElement("div");
  toastElement.id = "study-harvester-hud-toast";
  toastElement.textContent = messageText;
  toastElement.style.borderLeftColor = accentColor;

  container.appendChild(toastElement);
  requestAnimationFrame(() => {
    toastElement.style.opacity = "1";
    toastElement.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toastElement.style.opacity = "0";
    toastElement.style.transform = "translateY(8px)";
    window.setTimeout(() => toastElement.remove(), 250);
  }, 3200);
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

/** `allowOpeningPanel` may flash YouTube's transcript panel open, so only a user action passes it. */
async function loadImmersionTranscript(allowOpeningPanel = false): Promise<ImmersionTranscript | null> {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return null;
  if (immersionTranscript?.videoId === videoId) return immersionTranscript;
  if (pendingTranscript?.videoId === videoId) {
    const pending = await pendingTranscript.request;
    if (pending || !allowOpeningPanel) return pending;
  }

  const request = requestPageTranscript(videoId, { allowOpeningPanel }).then((pageTranscript) => {
    if (pendingTranscript?.videoId === videoId) pendingTranscript = null;
    if (!pageTranscript || getVideoIdFromLocation() !== videoId) return null;
    const { sentences, punctuated } = buildSentences(pageTranscript.segments);
    if (sentences.length === 0) return null;
    immersionTranscript = {
      videoId,
      languageCode: pageTranscript.languageCode,
      punctuated,
      sentences,
      frequencies: countWordFrequencies(sentences, pageTranscript.languageCode),
    };
    return immersionTranscript;
  });
  pendingTranscript = { videoId, request };
  return request;
}

function finishSentencePlayback(videoElement: HTMLVideoElement): void {
  if (!sentencePlayback) return;
  if (sentencePlayback.restoreRate !== null) videoElement.playbackRate = sentencePlayback.restoreRate;
  sentencePlayback = null;
}

function playSentence(
  sentence: TranscriptSentence,
  options: { rate?: number; pauseAtEnd?: boolean } = {}
): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  finishSentencePlayback(videoElement);
  videoElement.currentTime = sentence.startSeconds;
  if (options.rate || options.pauseAtEnd) {
    sentencePlayback = {
      startSeconds: sentence.startSeconds,
      // Sentence ends are interpolated from caption timing; a short tail avoids clipping the last word.
      endSeconds: sentence.endSeconds + 0.3,
      restoreRate: options.rate ? videoElement.playbackRate : null,
      pauseAtEnd: Boolean(options.pauseAtEnd),
    };
    if (options.rate) videoElement.playbackRate = options.rate;
  }
  if (videoElement.paused) void videoElement.play();
}

function checkSentencePlayback(videoElement: HTMLVideoElement): void {
  if (!sentencePlayback) return;
  const { startSeconds, endSeconds, pauseAtEnd } = sentencePlayback;
  if (videoElement.currentTime >= endSeconds) {
    if (pauseAtEnd) videoElement.pause();
    finishSentencePlayback(videoElement);
  } else if (videoElement.currentTime < startSeconds - 0.5) {
    finishSentencePlayback(videoElement);
  }
}

async function replaySentence(slow: boolean): Promise<void> {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;
  const currentTime = videoElement.currentTime;
  const loaded = await loadImmersionTranscript();
  const rate = slow ? 0.75 : undefined;

  if (!loaded) {
    playSentence({ text: "", startSeconds: Math.max(0, currentTime - 4), endSeconds: currentTime }, { rate });
    showImmersionToast(slow ? "Replaying the last 4s at 0.75×" : "Rewound 4s");
    return;
  }

  const sentence = loaded.sentences[sentenceIndexAt(loaded.sentences, currentTime)];
  playSentence(sentence, { rate });
  showImmersionToast(`${slow ? "0.75× " : ""}“${truncateText(sentence.text, 60)}”`);
}

async function skipToNextSentence(): Promise<void> {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;
  const currentTime = videoElement.currentTime;
  const loaded = await loadImmersionTranscript();
  const nextSentence = loaded?.sentences.find((sentence) => sentence.startSeconds > currentTime + 0.3);

  if (!nextSentence) {
    videoElement.currentTime = currentTime + 5;
    showImmersionToast("Skipped 5s");
    return;
  }
  playSentence(nextSentence);
  showImmersionToast(`“${truncateText(nextSentence.text, 60)}”`);
}

interface ClozeCaptureContext {
  sentences: TranscriptSentence[];
  index: number;
  languageCode: string | null;
  frequencies: Map<string, number>;
  approximate: boolean;
  preferredWord: string | null;
  resumeOnClose: boolean;
}

function showClozeCaptureModal(capture: ClozeCaptureContext): void {
  closeOpenClozeModal?.(false);

  const modalWrapper = document.createElement("div");
  modalWrapper.id = "study-harvester-cloze-modal";
  const cardElement = document.createElement("div");
  cardElement.className = "study-harvester-cloze-card";
  cardElement.tabIndex = -1;
  modalWrapper.appendChild(cardElement);

  let sentenceIndex = capture.index;
  let tokens: WordToken[] = [];
  let chosenToken: WordToken | null = null;
  let preferredWord = capture.preferredWord?.toLocaleLowerCase() ?? null;

  const createElement = <Tag extends keyof HTMLElementTagNameMap>(
    tagName: Tag,
    className: string,
    textContent = ""
  ): HTMLElementTagNameMap[Tag] => {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = textContent;
    return element;
  };

  const headerRow = createElement("div", "study-harvester-cloze-header");
  headerRow.appendChild(createElement("div", "study-harvester-cloze-title", "Clozemaster card"));
  const timePill = createElement("div", "study-harvester-cloze-time");
  headerRow.appendChild(timePill);
  const closeButton = createElement("button", "study-harvester-cloze-close", "×");
  closeButton.type = "button";
  closeButton.title = "Close (Esc)";
  headerRow.appendChild(closeButton);
  cardElement.appendChild(headerRow);

  const navigationRow = createElement("div", "study-harvester-cloze-nav");
  const previousButton = createElement("button", "study-harvester-cloze-nav-btn", "‹ Previous");
  previousButton.type = "button";
  previousButton.title = "Previous sentence (←)";
  const listenButton = createElement("button", "study-harvester-cloze-nav-btn", "▶ Listen");
  listenButton.type = "button";
  listenButton.title = "Play this sentence (Space)";
  const nextButton = createElement("button", "study-harvester-cloze-nav-btn", "Next ›");
  nextButton.type = "button";
  nextButton.title = "Next sentence (→)";
  navigationRow.append(previousButton, listenButton, nextButton);
  cardElement.appendChild(navigationRow);

  if (capture.approximate) {
    cardElement.appendChild(
      createElement(
        "div",
        "study-harvester-cloze-note",
        "These captions are auto-generated without punctuation, so sentence edges are a guess."
      )
    );
  }

  cardElement.appendChild(createElement("div", "study-harvester-cloze-label", "Click the word to blank out"));
  const chipsContainer = createElement("div", "study-harvester-chips-container");
  cardElement.appendChild(chipsContainer);
  const previewBox = createElement("div", "study-harvester-cloze-preview");
  cardElement.appendChild(previewBox);

  const translationGroup = createElement("label", "study-harvester-input-group");
  translationGroup.appendChild(createElement("span", "", "Translation"));
  const translationInput = document.createElement("input");
  translationInput.type = "text";
  translationInput.placeholder = "Optional. Leave blank and an agent can add it in Clozemaster.";
  translationGroup.appendChild(translationInput);
  cardElement.appendChild(translationGroup);

  const footerRow = createElement("div", "study-harvester-cloze-footer");
  const cancelButton = createElement("button", "study-harvester-btn-cancel", "Cancel");
  cancelButton.type = "button";
  const saveButton = createElement("button", "study-harvester-btn-save", "Save card (Enter)");
  saveButton.type = "button";
  footerRow.append(cancelButton, saveButton);
  cardElement.appendChild(footerRow);

  const renderPreview = () => {
    previewBox.replaceChildren();
    const text = capture.sentences[sentenceIndex].text;
    if (!chosenToken) {
      previewBox.textContent = text;
      return;
    }
    const blank = createElement("mark", "study-harvester-cloze-blank", chosenToken.text);
    previewBox.append(
      text.slice(0, chosenToken.index),
      blank,
      text.slice(chosenToken.index + chosenToken.text.length)
    );
  };

  const renderChips = () => {
    chipsContainer.replaceChildren();
    for (const token of tokens) {
      if (!token.isWord) continue;
      const chipButton = createElement(
        "button",
        `study-harvester-word-chip${token === chosenToken ? " active" : ""}`,
        token.text
      );
      chipButton.type = "button";
      chipButton.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        chosenToken = token;
        renderChips();
        renderPreview();
      });
      chipsContainer.appendChild(chipButton);
    }
  };

  const renderSentence = () => {
    const sentence = capture.sentences[sentenceIndex];
    tokens = segmentWords(sentence.text, capture.languageCode);
    chosenToken =
      (preferredWord && tokens.find((token) => token.isWord && token.text.toLocaleLowerCase() === preferredWord)) ||
      pickClozeToken(tokens, capture.frequencies);
    timePill.textContent = `▶ ${formatTimestamp(sentence.startSeconds)}`;
    previousButton.disabled = sentenceIndex === 0;
    nextButton.disabled = sentenceIndex === capture.sentences.length - 1;
    listenButton.disabled = capture.sentences.length === 1 && sentence.endSeconds <= sentence.startSeconds;
    renderChips();
    renderPreview();
  };

  const moveSentence = (step: number) => {
    const nextIndex = sentenceIndex + step;
    if (nextIndex < 0 || nextIndex >= capture.sentences.length) return;
    sentenceIndex = nextIndex;
    preferredWord = null;
    renderSentence();
  };

  const listen = () => {
    const sentence = capture.sentences[sentenceIndex];
    if (sentence.endSeconds > sentence.startSeconds) playSentence(sentence, { pauseAtEnd: true });
  };

  const close = (resume: boolean) => {
    modalWrapper.remove();
    closeOpenClozeModal = null;
    handleClozeModalKey = null;
    const videoElement = document.querySelector("video");
    if (videoElement) {
      finishSentencePlayback(videoElement);
      if (resume && videoElement.paused) void videoElement.play();
    }
  };

  const save = async () => {
    if (!chosenToken) {
      showImmersionToast("Pick a word to blank out first", "#e37050");
      return;
    }
    const sentence = capture.sentences[sentenceIndex];
    const videoId = getVideoIdFromLocation();
    const startSeconds = Math.floor(sentence.startSeconds);
    const card: StagedClozeCard = {
      id: crypto.randomUUID(),
      sentence: maskSentence(sentence.text, chosenToken),
      targetWord: chosenToken.text,
      translation: translationInput.value.trim(),
      notes: [lastMetadata.title, videoId ? `https://youtu.be/${videoId}?t=${startSeconds}` : ""]
        .filter(Boolean)
        .join(" · "),
      language: capture.languageCode ?? lastMetadata.language ?? null,
      videoId,
      videoTitle: lastMetadata.title,
      timestampSeconds: startSeconds,
      createdAt: Date.now(),
    };

    try {
      const response = (await browser.runtime.sendMessage({ action: "stage-cloze-card", card })) as
        | { success?: boolean }
        | undefined;
      if (!response?.success) throw new Error("not saved");
      showImmersionToast(`Saved «${card.targetWord}» for Clozemaster`, "#48b788");
      close(capture.resumeOnClose);
    } catch {
      showImmersionToast("Couldn't save the card", "#e37050");
    }
  };

  closeButton.addEventListener("click", () => close(capture.resumeOnClose));
  cancelButton.addEventListener("click", () => close(capture.resumeOnClose));
  saveButton.addEventListener("click", () => void save());
  previousButton.addEventListener("click", () => moveSentence(-1));
  nextButton.addEventListener("click", () => moveSentence(1));
  listenButton.addEventListener("click", listen);
  modalWrapper.addEventListener("click", (clickEvent) => {
    if (clickEvent.target === modalWrapper) close(capture.resumeOnClose);
  });

  closeOpenClozeModal = close;
  handleClozeModalKey = (keyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      close(capture.resumeOnClose);
      return true;
    }
    const inTextField = keyboardEvent.target === translationInput;
    if (keyboardEvent.key === "Enter" && !keyboardEvent.isComposing) {
      void save();
      return true;
    }
    if (inTextField) return false;
    if (keyboardEvent.key === "ArrowLeft") {
      moveSentence(-1);
      return true;
    }
    if (keyboardEvent.key === "ArrowRight") {
      moveSentence(1);
      return true;
    }
    if (keyboardEvent.code === "Space") {
      listen();
      return true;
    }
    return false;
  };

  renderSentence();
  getTargetPlayerContainer().appendChild(modalWrapper);
  cardElement.focus({ preventScroll: true });
}

async function triggerClozeCardCapture(): Promise<void> {
  if (closeOpenClozeModal) return;
  const videoElement = document.querySelector("video");
  const currentTime = videoElement?.currentTime ?? 0;
  const wasPlaying = Boolean(videoElement && !videoElement.paused);
  videoElement?.pause();

  const preferredWord = window.getSelection()?.toString().trim() || null;
  const loaded = await loadImmersionTranscript(true);

  if (loaded) {
    showClozeCaptureModal({
      sentences: loaded.sentences,
      index: sentenceIndexAt(loaded.sentences, currentTime),
      languageCode: loaded.languageCode,
      frequencies: loaded.frequencies,
      approximate: !loaded.punctuated,
      preferredWord,
      resumeOnClose: wasPlaying,
    });
    return;
  }

  const captionText = extractLiveCaptionText();
  if (captionText) {
    const sentences = [{ text: captionText, startSeconds: currentTime, endSeconds: currentTime }];
    showClozeCaptureModal({
      sentences,
      index: 0,
      languageCode: lastMetadata.language ?? null,
      frequencies: countWordFrequencies(sentences),
      approximate: true,
      preferredWord,
      resumeOnClose: wasPlaying,
    });
    return;
  }

  showImmersionToast("This video has no transcript to take a sentence from", "#e37050");
  if (wasPlaying) void videoElement?.play();
}

async function checkMandalaStatusForCurrentPage(): Promise<void> {
  try {
    const status = (await browser.runtime.sendMessage({
      action: "check-mandala-status",
      url: window.location.href,
    })) as MandalaStatus;

    if (status && typeof status === "object") {
      latestMandalaStatus = status;
      updateImmersionHud();
    }
  } catch {
    // Background unavailable or extension reloading
  }
}

function canonicalVideoUrl(): string {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return window.location.href;
  return window.location.pathname.startsWith("/shorts/")
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

function pillarTitleAt(pillarIndex: number): string {
  return (
    latestMandalaStatus.pillars.find((pillar) => pillar.index === pillarIndex)?.title || `Pillar ${pillarIndex + 1}`
  );
}

async function quickLogWatchedTimeToMandala(): Promise<void> {
  const watchedMinutes = Math.max(1, Math.floor(sessionWatchedSeconds / 60));

  try {
    const response = (await browser.runtime.sendMessage({
      action: "log-mandala-time",
      payload: {
        url: window.location.href,
        minutes: watchedMinutes,
        videoTitle: lastMetadata.title,
      },
    })) as { success: boolean; queued?: boolean; actionText?: string; errorMessage?: string };

    if (!response?.success) {
      showImmersionToast(response?.errorMessage || "Could not log time to Mandala", "#e37050");
      return;
    }
    sessionWatchedSeconds = 0;
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Logged ${watchedMinutes} min. It reaches Mandala next time you open it.`
        : `Logged ${watchedMinutes} min on “${truncateText(response.actionText || "", 40)}”`,
      "#48b788"
    );
  } catch {
    showImmersionToast("Could not log time to Mandala", "#e37050");
  }
}

async function saveCurrentVideoToMandalaShelf(pillarIndex: number): Promise<void> {
  const pillarTitle = pillarTitleAt(pillarIndex);
  try {
    const response = (await browser.runtime.sendMessage({
      action: "save-mandala-shelf-link",
      payload: {
        pillarIndex,
        url: canonicalVideoUrl(),
        title: lastMetadata.title || document.title,
        kind: "repeat",
      },
    })) as { success: boolean; queued?: boolean; errorMessage?: string };

    if (!response?.success) {
      showImmersionToast(response?.errorMessage || "Failed to save to shelf", "#e37050");
      return;
    }
    latestMandalaStatus.savedPillarIndexes = [...new Set([...latestMandalaStatus.savedPillarIndexes, pillarIndex])].sort(
      (first, second) => first - second
    );
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Saved to ${pillarTitle}. It reaches Mandala next time you open it.`
        : `Saved to ${pillarTitle}'s shelf`,
      "#48b788"
    );
    void checkMandalaStatusForCurrentPage();
  } catch {
    showImmersionToast("Failed to save to shelf", "#e37050");
  }
}

function injectImmersionStyles(): void {
  if (document.getElementById("study-harvester-immersion-styles")) return;

  const styleElement = document.createElement("style");
  styleElement.id = "study-harvester-immersion-styles";
  styleElement.textContent = `
    #study-harvester-player-hud {
      position: absolute;
      top: 14px;
      right: 70px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 2147483600;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: #efe7da;
      user-select: none;
      pointer-events: auto;
      transition: opacity 0.2s ease;
    }
    .ytp-autohide #study-harvester-player-hud:not(.is-open),
    .ad-showing #study-harvester-player-hud {
      opacity: 0;
      pointer-events: none;
    }
    .study-harvester-hud-btn {
      background-color: rgba(35, 31, 27, 0.92);
      backdrop-filter: blur(8px);
      color: #efe7da;
      border: 1px solid rgba(239, 231, 218, 0.2);
      padding: 6px 11px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 500;
      font-size: 11px;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
    }
    .study-harvester-hud-btn:hover {
      background-color: rgba(45, 40, 35, 0.98);
      border-color: rgba(227, 170, 80, 0.55);
      color: #ffffff;
      transform: translateY(-1px);
    }
    .study-harvester-hud-btn.active {
      background-color: rgba(72, 183, 136, 0.28);
      border-color: #48b788;
      color: #48b788;
      font-weight: 700;
    }
    .study-harvester-shelf-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      background-color: #231f1b;
      border: 1px solid rgba(239, 231, 218, 0.2);
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85);
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 220px;
      z-index: 2147483610;
    }
    .study-harvester-pillar-item {
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      color: #efe7da;
      text-align: left;
      border: none;
      background: transparent;
      transition: background-color 0.12s ease;
    }
    .study-harvester-pillar-item.saved {
      color: #48b788;
      cursor: default;
    }
    .study-harvester-shelf-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #e3aa50;
      padding: 4px 8px;
    }
    .study-harvester-shelf-hint {
      font-size: 11px;
      color: #a89e90;
      padding: 0 8px 4px;
    }
    .study-harvester-pillar-item:hover:not(:disabled) {
      background-color: rgba(227, 170, 80, 0.22);
      color: #ffffff;
    }
    #study-harvester-cloze-modal {
      position: absolute;
      inset: 0;
      background-color: rgba(18, 15, 12, 0.82);
      backdrop-filter: blur(8px);
      z-index: 2147483645;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      box-sizing: border-box;
      pointer-events: auto;
    }
    .study-harvester-cloze-card {
      background-color: #231f1b;
      border: 1px solid rgba(227, 170, 80, 0.4);
      border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9);
      width: 100%;
      max-width: 540px;
      padding: 22px;
      color: #efe7da;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .study-harvester-cloze-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .study-harvester-cloze-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #e3aa50;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .study-harvester-cloze-time {
      font-size: 12px;
      color: #a89e90;
      font-variant-numeric: tabular-nums;
    }
    .study-harvester-cloze-close {
      background: transparent;
      border: none;
      color: #a89e90;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .study-harvester-cloze-close:hover {
      color: #ffffff;
    }
    .study-harvester-cloze-nav {
      display: flex;
      gap: 8px;
    }
    .study-harvester-cloze-nav-btn {
      flex: 1;
      background-color: rgba(239, 231, 218, 0.08);
      border: 1px solid rgba(239, 231, 218, 0.16);
      color: #efe7da;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .study-harvester-cloze-nav-btn:hover:not(:disabled) {
      border-color: #e3aa50;
    }
    .study-harvester-cloze-nav-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .study-harvester-cloze-note {
      font-size: 11px;
      color: #e3aa50;
    }
    .study-harvester-cloze-blank {
      background-color: #e3aa50;
      color: #1a1612;
      border-radius: 4px;
      padding: 0 3px;
      font-weight: 700;
    }
    .study-harvester-cloze-card:focus {
      outline: none;
    }
    .study-harvester-cloze-label {
      font-size: 11px;
      color: #a89e90;
      margin-bottom: -4px;
    }
    .study-harvester-chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px;
      background-color: rgba(0, 0, 0, 0.3);
      border-radius: 10px;
      border: 1px solid rgba(239, 231, 218, 0.1);
      max-height: 120px;
      overflow-y: auto;
    }
    .study-harvester-word-chip {
      background-color: rgba(239, 231, 218, 0.08);
      border: 1px solid rgba(239, 231, 218, 0.16);
      color: #efe7da;
      padding: 5px 9px;
      border-radius: 7px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .study-harvester-word-chip:hover {
      background-color: rgba(227, 170, 80, 0.2);
      border-color: #e3aa50;
      color: #ffffff;
    }
    .study-harvester-word-chip.active {
      background-color: #e3aa50;
      color: #1a1612;
      font-weight: 700;
      border-color: #e3aa50;
      box-shadow: 0 0 10px rgba(227, 170, 80, 0.4);
    }
    .study-harvester-cloze-preview {
      background-color: rgba(0, 0, 0, 0.4);
      border: 1px dashed rgba(227, 170, 80, 0.4);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 15px;
      line-height: 1.5;
      color: #efe7da;
    }
    .study-harvester-input-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .study-harvester-input-group span {
      font-size: 11px;
      color: #a89e90;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .study-harvester-input-group input {
      background-color: #2a2520;
      border: 1px solid rgba(239, 231, 218, 0.18);
      border-radius: 8px;
      padding: 8px 12px;
      color: #efe7da;
      font-size: 13px;
      width: 100%;
      box-sizing: border-box;
      outline: none;
    }
    .study-harvester-input-group input:focus {
      border-color: #e3aa50;
    }
    .study-harvester-cloze-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 6px;
    }
    .study-harvester-btn-cancel {
      background: transparent;
      color: #a89e90;
      border: 1px solid rgba(239, 231, 218, 0.18);
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .study-harvester-btn-cancel:hover {
      color: #efe7da;
      border-color: rgba(239, 231, 218, 0.35);
    }
    .study-harvester-btn-save {
      background-color: #e3aa50;
      color: #1a1612;
      font-weight: 700;
      border: none;
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.15s ease;
    }
    .study-harvester-btn-save:hover {
      background-color: #f1b95f;
    }
    #study-harvester-hud-toast {
      position: absolute;
      bottom: 70px;
      right: 24px;
      background-color: #231f1b;
      color: #efe7da;
      padding: 12px 18px;
      border-radius: 10px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
      font-family: system-ui, -apple-system, sans-serif;
      z-index: 2147483647;
      border: 1px solid rgba(239, 231, 218, 0.16);
      border-left: 4px solid #e3aa50;
      transition: opacity 0.22s ease-out, transform 0.22s ease-out;
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
    }
  `;
  document.head.appendChild(styleElement);
}

function removeImmersionHud(): void {
  const existingHud = document.getElementById("study-harvester-player-hud");
  if (existingHud) {
    existingHud.remove();
  }
}

function updateImmersionHud(): void {
  if (!isWatchOrShorts()) {
    removeImmersionHud();
    return;
  }

  injectImmersionStyles();

  const playerContainer = getTargetPlayerContainer();
  let hudContainer = document.getElementById("study-harvester-player-hud");
  if (!hudContainer) {
    hudContainer = document.createElement("div");
    hudContainer.id = "study-harvester-player-hud";
    playerContainer.appendChild(hudContainer);
  }

  const savedPillarIndexes = latestMandalaStatus.savedPillarIndexes;
  const watchedMinutes = Math.floor(sessionWatchedSeconds / 60);

  hudContainer.replaceChildren();
  hudContainer.classList.toggle("is-open", isPillarPopoverOpen);

  const shelfButton = document.createElement("button");
  shelfButton.className = "study-harvester-hud-btn";
  shelfButton.type = "button";
  if (savedPillarIndexes.length > 0) {
    const savedTitles = savedPillarIndexes.map(pillarTitleAt);
    const extra = savedTitles.length > 1 ? ` +${savedTitles.length - 1}` : "";
    shelfButton.textContent = `🌿 ${savedTitles[0]}${extra}`;
    shelfButton.title = `On Mandala's shelves: ${savedTitles.join(", ")}`;
  } else {
    shelfButton.textContent = "+ Mandala shelf";
    shelfButton.title = "Save this video to a Mandala pillar's shelf";
  }
  shelfButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    isPillarPopoverOpen = !isPillarPopoverOpen;
    updateImmersionHud();
  });
  hudContainer.appendChild(shelfButton);

  if (isPillarPopoverOpen) {
    const popover = document.createElement("div");
    popover.className = "study-harvester-shelf-popover";
    popover.addEventListener("click", (clickEvent) => clickEvent.stopPropagation());

    const header = document.createElement("div");
    header.className = "study-harvester-shelf-header";
    header.textContent = "Save to a pillar's shelf";
    popover.appendChild(header);

    if (!latestMandalaStatus.connected && !latestMandalaStatus.cached) {
      const hint = document.createElement("div");
      hint.className = "study-harvester-shelf-hint";
      hint.textContent = "Open Mandala once so your pillar names show here.";
      popover.appendChild(hint);
    }

    const pillars =
      latestMandalaStatus.pillars.length > 0
        ? latestMandalaStatus.pillars
        : Array.from({ length: 8 }, (_item, pillarIndex) => ({
            index: pillarIndex,
            title: `Pillar ${pillarIndex + 1}`,
            actionCount: 0,
          }));

    for (const pillar of pillars) {
      const isSaved = savedPillarIndexes.includes(pillar.index);
      const pillarButton = document.createElement("button");
      pillarButton.className = `study-harvester-pillar-item${isSaved ? " saved" : ""}`;
      pillarButton.type = "button";
      pillarButton.textContent = `${isSaved ? "✓" : "+"} ${pillar.title}`;
      pillarButton.disabled = isSaved;
      pillarButton.title = isSaved ? "Already on this shelf" : `Save to ${pillar.title}'s shelf`;
      pillarButton.addEventListener("click", () => {
        isPillarPopoverOpen = false;
        void saveCurrentVideoToMandalaShelf(pillar.index);
      });
      popover.appendChild(pillarButton);
    }

    hudContainer.appendChild(popover);
  }

  if (watchedMinutes >= 1 && savedPillarIndexes.length > 0) {
    const logTimeButton = document.createElement("button");
    logTimeButton.className = "study-harvester-hud-btn";
    logTimeButton.type = "button";
    logTimeButton.textContent = `⏱️ Log ${watchedMinutes}m`;
    logTimeButton.title = `Log ${watchedMinutes} min to ${pillarTitleAt(savedPillarIndexes[0])} in Mandala`;
    logTimeButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      void quickLogWatchedTimeToMandala();
    });
    hudContainer.appendChild(logTimeButton);
  }

  const clozeButton = document.createElement("button");
  clozeButton.className = "study-harvester-hud-btn";
  clozeButton.type = "button";
  clozeButton.textContent = "🗂️ Cloze";
  clozeButton.title = "Make a Clozemaster card from the sentence just spoken (Alt+C)";
  clozeButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void triggerClozeCardCapture();
  });
  hudContainer.appendChild(clozeButton);
}

function isEditableTarget(targetElement: EventTarget | null): boolean {
  if (!targetElement || !(targetElement instanceof HTMLElement)) return false;
  const tagName = targetElement.tagName.toLowerCase();
  return (
    targetElement.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function handleGlobalKeydown(keyboardEvent: KeyboardEvent): void {
  if (handleClozeModalKey) {
    if (handleClozeModalKey(keyboardEvent)) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
    } else if (!isEditableTarget(keyboardEvent.target)) {
      // Keep YouTube's own shortcuts (seek, fullscreen, mute) from firing behind the open card.
      keyboardEvent.stopPropagation();
    }
    return;
  }

  if (isEditableTarget(keyboardEvent.target)) {
    return;
  }

  if (keyboardEvent.altKey && !keyboardEvent.ctrlKey && !keyboardEvent.metaKey && keyboardEvent.code === "KeyC") {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    void triggerClozeCardCapture();
    return;
  }

  if (keyboardEvent.ctrlKey || keyboardEvent.altKey || keyboardEvent.metaKey || keyboardEvent.shiftKey) {
    return;
  }

  const sentenceActions: Record<string, () => Promise<void>> = {
    KeyA: () => replaySentence(false),
    KeyS: () => replaySentence(true),
    KeyD: () => skipToNextSentence(),
  };
  const action = sentenceActions[keyboardEvent.code];
  if (action) {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    void action();
  }
}

function initializeWatchPageFeatures(context: {
  setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown;
}): void {
  const videoId = getVideoIdFromLocation();
  if (currentWatchVideoId !== videoId) {
    currentWatchVideoId = videoId;
    sessionWatchedSeconds = 0;
    sentencePlayback = null;
    closeOpenClozeModal?.(false);
  }

  injectImmersionStyles();
  void loadImmersionTranscript();
  void checkMandalaStatusForCurrentPage();
  void readMetadataFromDom().then((metadata) => {
    lastMetadata = metadata;
    updateImmersionHud();
  });

  if (!watchedTimerInterval) {
    lastWatchTickTimestamp = Date.now();
    watchedTimerInterval = setInterval(() => {
      const videoElement = document.querySelector("video");
      const currentTimestamp = Date.now();
      const elapsedMilliseconds = currentTimestamp - lastWatchTickTimestamp;
      lastWatchTickTimestamp = currentTimestamp;

      if (videoElement && !videoElement.paused && elapsedMilliseconds > 0) {
        const minutesBefore = Math.floor(sessionWatchedSeconds / 60);
        sessionWatchedSeconds += elapsedMilliseconds / 1000;
        if (Math.floor(sessionWatchedSeconds / 60) !== minutesBefore) {
          updateImmersionHud();
        }

        checkSentencePlayback(videoElement);
      }
    }, 100);
  }

  updateImmersionHud();
  scheduleRead(context);
}

function teardownWatchPageFeatures(): void {
  removeImmersionHud();
  closeOpenClozeModal?.(false);
  sentencePlayback = null;
}

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  main(context) {
    registerBridgeListener({
      "get-open-tabs-catalog": () => browser.runtime.sendMessage({ action: "get-open-tabs-catalog" }),
      "stage-focused-study-queue": (payload) =>
        browser.runtime.sendMessage({ action: "stage-focused-study-queue", payload }),
      "refine-language": (payload) => {
        const { detected, text, channelName, videoId } = payload as VideoChannel & {
          detected: DetectedLanguage;
          text: string;
        };
        return resolveVideoLanguage(detected, text, { channelName, videoId }, document.documentElement.lang);
      },
    });

    browser.runtime.onMessage.addListener(
      (
        runtimeMessage: { action: string; reset?: boolean; volume?: number; refreshLanguage?: boolean },
        _sender: unknown,
        sendResponse: (responseResult: unknown) => void
      ) => {
        if (runtimeMessage?.action === "get-metadata") {
          const currentId = getVideoIdFromLocation();
          const needsRead =
            isWatchOrShorts() &&
            (currentId !== lastMetadata.videoId || runtimeMessage.refreshLanguage === true);
          if (!needsRead) {
            sendResponse(lastMetadata);
            return;
          }
          void readMetadataFromDom().then((metadata) => {
            lastMetadata = metadata;
            updateImmersionHud();
            sendResponse(metadata);
          });
          return true;
        }
        if (runtimeMessage?.action === "get-playback-state") {
          sendResponse(getPlaybackState());
          return;
        }
        if (runtimeMessage?.action === "toggle-play") {
          sendResponse(togglePlayback());
          return;
        }
        if (runtimeMessage?.action === "set-volume" && typeof runtimeMessage.volume === "number") {
          sendResponse(setPlaybackVolume(runtimeMessage.volume));
          return;
        }
        if (runtimeMessage?.action === "get-perf-stats") {
          const stats = {
            totalMutations: perf.totalMutations,
            totalReads: perf.totalReads,
            mutationsSinceLastRead: perf.mutationsSinceLastRead,
            debounceMs: DEBOUNCE_MS,
            ratio: perf.totalReads > 0 ? (perf.totalMutations / perf.totalReads).toFixed(1) : "—",
          };
          if (runtimeMessage.reset) {
            perf.totalMutations = 0;
            perf.totalReads = 0;
            perf.mutationsSinceLastRead = 0;
          }
          sendResponse(stats);
        }
      }
    );

    context.addEventListener(window, "keydown", handleGlobalKeydown, { capture: true });

    document.addEventListener("click", () => {
      if (isPillarPopoverOpen) {
        isPillarPopoverOpen = false;
        updateImmersionHud();
      }
    });

    const handleNavigation = () => {
      if (isWatchOrShorts()) {
        initializeWatchPageFeatures(context);
      } else {
        teardownWatchPageFeatures();
      }
    };

    context.addEventListener(window, "popstate", handleNavigation);
    context.addEventListener(window, "hashchange", handleNavigation);
    context.addEventListener(document, "yt-navigate-finish", handleNavigation);

    const target =
      document.querySelector("#primary") ||
      document.querySelector("#content") ||
      document.body;
    if (target) {
      const observer = new MutationObserver(() => {
        perf.totalMutations++;
        perf.mutationsSinceLastRead++;
        scheduleRead(context);
      });

      observer.observe(target, {
        childList: true,
        subtree: false,
      });
    }

    const titleElement = document.querySelector("title");
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        perf.totalMutations++;
        perf.mutationsSinceLastRead++;
        scheduleRead(context);
      });
      titleObserver.observe(titleElement, { childList: true });
    }

    context.addEventListener(document, "durationchange", () => scheduleRead(context), true);
    context.addEventListener(document, "loadedmetadata", () => scheduleRead(context), true);

    if (isWatchOrShorts()) {
      initializeWatchPageFeatures(context);
      perf.totalReads++;
      scheduleRead(context);
    }
  },
});
