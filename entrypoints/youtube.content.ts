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
import { placeHudBelowNativeControls } from "../utils/hudLayout";

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
  const candidates = [
    document.getElementById("movie_player"),
    document.getElementById("shorts-player"),
    ...document.querySelectorAll(".html5-video-player"),
    document.querySelector("#player"),
  ].filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

  // Watch and Shorts pages keep each other's player in the DOM, hidden; the one with a size is in use.
  const shownPlayer = candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return shownPlayer ?? candidates[0] ?? document.body;
}

function showImmersionToast(messageText: string) {
  const existingToast = document.getElementById("study-harvester-hud-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const container = getTargetPlayerContainer();
  const toastElement = document.createElement("div");
  toastElement.id = "study-harvester-hud-toast";
  toastElement.textContent = messageText;

  container.appendChild(toastElement);
  requestAnimationFrame(() => {
    toastElement.style.opacity = "1";
    toastElement.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toastElement.style.opacity = "0";
    toastElement.style.transform = "translateY(4px)";
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

async function replaySentence(): Promise<void> {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;
  const currentTime = videoElement.currentTime;
  const loaded = await loadImmersionTranscript();

  if (!loaded) {
    playSentence({ text: "", startSeconds: Math.max(0, currentTime - 4), endSeconds: currentTime });
    showImmersionToast("Rewound 4s");
    return;
  }

  const sentence = loaded.sentences[sentenceIndexAt(loaded.sentences, currentTime)];
  playSentence(sentence);
  showImmersionToast(`“${truncateText(sentence.text, 60)}”`);
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
  headerRow.appendChild(createElement("span", "study-harvester-cloze-kicker", "Cloze card"));
  const sourceLine = createElement("span", "study-harvester-cloze-source");
  headerRow.appendChild(sourceLine);
  const closeButton = createElement("button", "study-harvester-cloze-close");
  closeButton.appendChild(hudIcon("close"));
  closeButton.type = "button";
  closeButton.title = "Close";
  headerRow.appendChild(closeButton);
  cardElement.appendChild(headerRow);

  const sentenceBox = createElement("div", "study-harvester-cloze-sentence");
  cardElement.appendChild(sentenceBox);

  if (capture.approximate) {
    cardElement.appendChild(
      createElement(
        "div",
        "study-harvester-cloze-note",
        "Auto-generated captions without punctuation: the sentence edges are a guess."
      )
    );
  }

  const toolbarRow = createElement("div", "study-harvester-cloze-toolbar");
  const navigationGroup = createElement("div", "study-harvester-cloze-nav");
  const previousButton = createElement("button", "study-harvester-cloze-nav-btn");
  previousButton.appendChild(hudIcon("previous"));
  previousButton.type = "button";
  previousButton.title = "Previous sentence";
  const listenButton = createElement("button", "study-harvester-cloze-nav-btn is-listen");
  const listenTime = createElement("span", "");
  listenButton.append(hudIcon("play", true), listenTime);
  listenButton.type = "button";
  listenButton.title = "Play this sentence";
  const nextButton = createElement("button", "study-harvester-cloze-nav-btn");
  nextButton.appendChild(hudIcon("next"));
  nextButton.type = "button";
  nextButton.title = "Next sentence";
  navigationGroup.append(previousButton, listenButton, nextButton);
  const answerLine = createElement("div", "study-harvester-cloze-pick");
  const translationInput = document.createElement("input");
  translationInput.type = "text";
  translationInput.className = "study-harvester-cloze-translation";
  translationInput.placeholder = "Translation (optional)";
  translationInput.title = "Leave it blank and an AI agent can fill it in later.";
  translationInput.setAttribute("aria-label", "Translation");
  const saveButton = createElement("button", "study-harvester-btn-save", "Save card");
  saveButton.type = "button";
  toolbarRow.append(navigationGroup, answerLine, translationInput, saveButton);
  cardElement.appendChild(toolbarRow);

  const renderAnswer = () => {
    answerLine.replaceChildren();
    if (!chosenToken) {
      answerLine.textContent = "Tap a word to blank it out";
      return;
    }
    answerLine.append(
      createElement("span", "study-harvester-cloze-pick-label", "Cloze"),
      createElement("span", "study-harvester-cloze-pick-word", chosenToken.text)
    );
  };

  const renderSentenceText = () => {
    sentenceBox.replaceChildren();
    const text = capture.sentences[sentenceIndex].text;
    let cursor = 0;
    for (const token of tokens) {
      if (!token.isWord) continue;
      if (token.index > cursor) sentenceBox.append(text.slice(cursor, token.index));
      const wordButton = createElement(
        "button",
        `study-harvester-cloze-word${token === chosenToken ? " is-blank" : ""}`,
        token.text
      );
      wordButton.type = "button";
      wordButton.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        chosenToken = token;
        renderSentenceText();
        renderAnswer();
      });
      sentenceBox.appendChild(wordButton);
      cursor = token.index + token.text.length;
    }
    if (cursor < text.length) sentenceBox.append(text.slice(cursor));
  };

  const renderSentence = () => {
    const sentence = capture.sentences[sentenceIndex];
    tokens = segmentWords(sentence.text, capture.languageCode);
    chosenToken =
      (preferredWord && tokens.find((token) => token.isWord && token.text.toLocaleLowerCase() === preferredWord)) ||
      pickClozeToken(tokens, capture.frequencies);
    const position = `${sentenceIndex + 1} of ${capture.sentences.length}`;
    sourceLine.textContent = lastMetadata.title ? `${truncateText(lastMetadata.title, 48)} · ${position}` : position;
    listenTime.textContent = formatTimestamp(sentence.startSeconds);
    previousButton.disabled = sentenceIndex === 0;
    nextButton.disabled = sentenceIndex === capture.sentences.length - 1;
    listenButton.disabled = capture.sentences.length === 1 && sentence.endSeconds <= sentence.startSeconds;
    renderSentenceText();
    renderAnswer();
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
      showImmersionToast("Pick a word to blank out first");
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
      showImmersionToast(`Saved «${card.targetWord}» for Clozemaster`);
      close(capture.resumeOnClose);
    } catch {
      showImmersionToast("Couldn't save the card");
    }
  };

  closeButton.addEventListener("click", () => close(capture.resumeOnClose));
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
    if (keyboardEvent.key === "Enter" && !keyboardEvent.isComposing) {
      void save();
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

  showImmersionToast("This video has no transcript to take a sentence from");
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
      showImmersionToast(response?.errorMessage || "Could not log time to Mandala");
      return;
    }
    sessionWatchedSeconds = 0;
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Logged ${watchedMinutes} min. It reaches Mandala next time you open it.`
        : `Logged ${watchedMinutes} min on “${truncateText(response.actionText || "", 40)}”`
    );
  } catch {
    showImmersionToast("Could not log time to Mandala");
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
      showImmersionToast(response?.errorMessage || "Failed to save to shelf");
      return;
    }
    latestMandalaStatus.savedPillarIndexes = [...new Set([...latestMandalaStatus.savedPillarIndexes, pillarIndex])].sort(
      (first, second) => first - second
    );
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Saved to ${pillarTitle}. It reaches Mandala next time you open it.`
        : `Saved to ${pillarTitle}'s shelf`
    );
    void checkMandalaStatusForCurrentPage();
  } catch {
    showImmersionToast("Failed to save to shelf");
  }
}

function injectImmersionStyles(): void {
  if (document.getElementById("study-harvester-immersion-styles")) return;

  const styleElement = document.createElement("style");
  styleElement.id = "study-harvester-immersion-styles";
  styleElement.textContent = `
    #study-harvester-player-hud {
      --sh-ink: #f4efe6;
      --sh-muted: rgba(244, 239, 230, 0.62);
      --sh-glass: rgba(14, 12, 11, 0.62);
      --sh-glass-strong: rgba(14, 12, 11, 0.86);
      --sh-line: rgba(255, 255, 255, 0.1);
      --sh-accent: #f0b65a;
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 60;
      font-family: "YouTube Sans", Roboto, Arial, sans-serif;
      color: var(--sh-ink);
      user-select: none;
      pointer-events: auto;
      transition: opacity 0.1s cubic-bezier(0.4, 0, 1, 1);
    }
    .ytp-autohide #study-harvester-player-hud:not(.is-open),
    .ad-showing #study-harvester-player-hud {
      opacity: 0;
      pointer-events: none;
      transition-duration: 0.5s;
    }
    .study-harvester-icon {
      width: 18px;
      height: 18px;
      flex: none;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .study-harvester-hud-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 36px;
      padding: 0 14px 0 11px;
      border: 1px solid var(--sh-line);
      border-radius: 999px;
      background-color: var(--sh-glass);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      box-shadow: 0 6px 20px -10px rgba(0, 0, 0, 0.8);
      color: var(--sh-ink);
      font: 500 13px/1 "YouTube Sans", Roboto, Arial, sans-serif;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .study-harvester-hud-btn:hover:not(:disabled) {
      background-color: rgba(40, 36, 32, 0.8);
      border-color: rgba(255, 255, 255, 0.22);
      transform: translateY(-1px);
    }
    .study-harvester-hud-btn:disabled {
      cursor: default;
      color: var(--sh-muted);
    }
    .study-harvester-hud-btn.is-icon {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .study-harvester-hud-btn.is-accent {
      border-color: transparent;
      background-color: var(--sh-accent);
      color: #1a1410;
      font-weight: 600;
      box-shadow: 0 8px 24px -8px rgba(240, 182, 90, 0.7);
    }
    .study-harvester-hud-btn.is-accent:hover:not(:disabled) {
      background-color: var(--sh-accent);
      filter: brightness(1.06);
    }
    .study-harvester-shelf-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 230px;
      padding: 8px;
      border-radius: 16px;
      border: 1px solid var(--sh-line);
      background-color: var(--sh-glass-strong);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 20px 50px -20px rgba(0, 0, 0, 0.9);
      display: flex;
      flex-direction: column;
      animation: study-harvester-rise 0.18s ease-out;
    }
    .study-harvester-shelf-header {
      padding: 6px 10px 8px;
      font: 600 11px Roboto, Arial, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sh-muted);
    }
    .study-harvester-shelf-hint {
      padding: 0 10px 8px;
      font: 400 12px/1.4 Roboto, Arial, sans-serif;
      color: var(--sh-muted);
    }
    .study-harvester-pillar-item {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 38px;
      padding: 0 10px;
      border: none;
      border-radius: 10px;
      background: transparent;
      color: var(--sh-ink);
      font: 400 14px Roboto, Arial, sans-serif;
      text-align: left;
      cursor: pointer;
    }
    .study-harvester-pillar-item .study-harvester-icon {
      width: 18px;
      height: 18px;
      opacity: 0.6;
    }
    .study-harvester-pillar-item.saved {
      cursor: default;
      color: var(--sh-accent);
    }
    .study-harvester-pillar-item.saved .study-harvester-icon {
      opacity: 1;
    }
    .study-harvester-pillar-item:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.08);
    }
    @keyframes study-harvester-rise {
      from { opacity: 0; transform: translateY(6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    #study-harvester-cloze-modal {
      --sh-ink: #f4efe6;
      --sh-muted: rgba(244, 239, 230, 0.58);
      --sh-line: rgba(255, 255, 255, 0.1);
      --sh-accent: #f0b65a;
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(10, 9, 8, 0.2) 0%, rgba(10, 9, 8, 0.55) 55%, rgba(10, 9, 8, 0.85) 100%);
      z-index: 2147483645;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: "YouTube Sans", Roboto, system-ui, sans-serif;
    }
    .study-harvester-cloze-card {
      width: 100%;
      max-width: 920px;
      padding: 14px 20px 16px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(16, 14, 13, 0.82);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: var(--sh-ink);
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: study-harvester-rise 0.22s ease-out;
    }
    .study-harvester-cloze-card:focus {
      outline: none;
    }
    .study-harvester-cloze-header {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 28px;
      font-size: 12px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-kicker {
      flex: none;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sh-accent);
    }
    .study-harvester-cloze-source {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .study-harvester-cloze-source::before {
      content: "·";
      margin-right: 10px;
    }
    .study-harvester-cloze-close {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: none;
      border-radius: 999px;
      background: transparent;
      border: none;
      color: var(--sh-muted);
      cursor: pointer;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    .study-harvester-cloze-close .study-harvester-icon {
      width: 16px;
      height: 16px;
    }
    .study-harvester-cloze-close:hover {
      background-color: rgba(255, 255, 255, 0.08);
      color: var(--sh-ink);
    }
    .study-harvester-cloze-sentence {
      padding: 2px 0 6px;
      font: 400 23px/1.5 Georgia, "Times New Roman", serif;
      color: var(--sh-ink);
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
    .study-harvester-cloze-word {
      display: inline;
      margin: 0 -3px;
      padding: 0 3px;
      border: none;
      border-radius: 5px 5px 0 0;
      background: transparent;
      box-shadow: inset 0 -2px 0 transparent;
      color: inherit;
      font: inherit;
      line-height: inherit;
      vertical-align: baseline;
      cursor: pointer;
      transition: background-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
    }
    .study-harvester-cloze-word:hover {
      background-color: rgba(240, 182, 90, 0.12);
      color: var(--sh-accent);
    }
    .study-harvester-cloze-word.is-blank {
      background-color: rgba(240, 182, 90, 0.14);
      box-shadow: inset 0 -2px 0 var(--sh-accent);
      color: var(--sh-accent);
    }
    .study-harvester-cloze-note {
      font-size: 12px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .study-harvester-cloze-nav {
      display: inline-flex;
      flex: none;
      gap: 2px;
      padding: 3px;
      border-radius: 12px;
      border: 1px solid var(--sh-line);
      background: rgba(255, 255, 255, 0.04);
    }
    .study-harvester-cloze-nav-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 30px;
      min-width: 30px;
      padding: 0 7px;
      border-radius: 9px;
      border: none;
      background: transparent;
      color: var(--sh-ink);
      font: 500 13px "YouTube Sans", Roboto, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    .study-harvester-cloze-nav-btn .study-harvester-icon {
      width: 16px;
      height: 16px;
    }
    .study-harvester-cloze-nav-btn:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.09);
    }
    .study-harvester-cloze-nav-btn.is-listen {
      padding: 0 10px 0 8px;
      color: var(--sh-accent);
    }
    .study-harvester-cloze-nav-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .study-harvester-cloze-pick {
      display: inline-flex;
      flex: none;
      align-items: baseline;
      gap: 8px;
      height: 38px;
      box-sizing: border-box;
      padding: 0 12px;
      line-height: 36px;
      border-radius: 12px;
      border: 1px solid rgba(240, 182, 90, 0.3);
      background: rgba(240, 182, 90, 0.08);
      font-size: 13px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-pick-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .study-harvester-cloze-pick-word {
      color: var(--sh-accent);
      font-weight: 600;
    }
    .study-harvester-cloze-translation {
      flex: 1 1 200px;
      min-width: 0;
      height: 38px;
      box-sizing: border-box;
      padding: 0 14px;
      border-radius: 12px;
      border: 1px solid var(--sh-line);
      background-color: rgba(0, 0, 0, 0.28);
      color: var(--sh-ink);
      font: 400 14px "YouTube Sans", Roboto, system-ui, sans-serif;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .study-harvester-cloze-translation::placeholder {
      color: rgba(244, 239, 230, 0.4);
    }
    .study-harvester-cloze-translation:focus {
      border-color: rgba(240, 182, 90, 0.7);
      box-shadow: 0 0 0 3px rgba(240, 182, 90, 0.15);
    }
    .study-harvester-btn-save {
      flex: none;
      margin-left: auto;
      height: 38px;
      padding: 0 18px;
      border-radius: 12px;
      border: none;
      background: var(--sh-accent);
      color: #1a1410;
      font: 600 13px "YouTube Sans", Roboto, system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 10px 28px -12px rgba(240, 182, 90, 0.9);
      transition: filter 0.15s ease, transform 0.15s ease;
    }
    .study-harvester-btn-save:hover {
      filter: brightness(1.06);
      transform: translateY(-1px);
    }
    #study-harvester-hud-toast {
      position: absolute;
      left: 12px;
      bottom: 64px;
      max-width: min(480px, 70%);
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(14, 12, 11, 0.82);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #f4efe6;
      font: 400 14px/20px Roboto, Arial, sans-serif;
      z-index: 61;
      transition: opacity 0.2s ease, transform 0.2s ease;
      opacity: 0;
      transform: translateY(4px);
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
  stopHudLayoutWatch();
}

const OWN_OVERLAY_SELECTOR = "#study-harvester-player-hud, #study-harvester-cloze-modal, #study-harvester-hud-toast";
// YouTube mounts the Shorts overlay a moment after the player, so the HUD looks again as the page settles.
const HUD_LAYOUT_RECHECK_DELAYS_MS = [400, 1500];

let hudLayoutFrame: number | null = null;
let hudLayoutTimers: number[] = [];
let hudPlayerResizeObserver: ResizeObserver | null = null;
let hudWatchedPlayer: HTMLElement | null = null;

function layoutHudAroundNativeControls(): void {
  const hudContainer = document.getElementById("study-harvester-player-hud");
  const playerContainer = hudContainer?.parentElement;
  if (!hudContainer || !playerContainer) return;
  placeHudBelowNativeControls(hudContainer, playerContainer, (element) => element.closest(OWN_OVERLAY_SELECTOR) !== null);
}

function scheduleHudLayout(): void {
  if (hudLayoutFrame !== null) return;
  hudLayoutFrame = requestAnimationFrame(() => {
    hudLayoutFrame = null;
    layoutHudAroundNativeControls();
  });
}

function watchPlayerForHudLayout(playerContainer: HTMLElement): void {
  if (hudWatchedPlayer !== playerContainer) {
    hudPlayerResizeObserver?.disconnect();
    hudPlayerResizeObserver ??= new ResizeObserver(() => scheduleHudLayout());
    hudPlayerResizeObserver.observe(playerContainer);
    hudWatchedPlayer = playerContainer;
  }
  for (const timer of hudLayoutTimers) clearTimeout(timer);
  hudLayoutTimers = HUD_LAYOUT_RECHECK_DELAYS_MS.map((delay) => window.setTimeout(scheduleHudLayout, delay));
  scheduleHudLayout();
}

function stopHudLayoutWatch(): void {
  if (hudLayoutFrame !== null) {
    cancelAnimationFrame(hudLayoutFrame);
    hudLayoutFrame = null;
  }
  for (const timer of hudLayoutTimers) clearTimeout(timer);
  hudLayoutTimers = [];
  hudPlayerResizeObserver?.disconnect();
  hudWatchedPlayer = null;
}

const HUD_ICON_PATHS = {
  shelf: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4.5l3 2",
  card: "M4 6h16v12H4zM8 12h3m3 0h2",
  check: "M5 12.5l4.5 4.5L19 7",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  play: "M8 5.5v13l11-6.5z",
  previous: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  replay: "M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5",
  skip: "M5 5l9 7-9 7zM18 5v14",
};

function hudIcon(name: keyof typeof HUD_ICON_PATHS, filled = false): SVGSVGElement {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("study-harvester-icon");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", HUD_ICON_PATHS[name]);
  if (filled) path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

function hudButton(icon: SVGSVGElement, label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = label ? "study-harvester-hud-btn" : "study-harvester-hud-btn is-icon";
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.appendChild(icon);
  if (label) {
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);
  }
  return button;
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
  }
  if (hudContainer.parentElement !== playerContainer) {
    playerContainer.appendChild(hudContainer);
  }

  const savedPillarIndexes = latestMandalaStatus.savedPillarIndexes;
  const watchedMinutes = Math.floor(sessionWatchedSeconds / 60);

  hudContainer.replaceChildren();
  hudContainer.classList.toggle("is-open", isPillarPopoverOpen);

  const savedTitles = savedPillarIndexes.map(pillarTitleAt);
  const shelfButton =
    savedTitles.length > 0
      ? hudButton(
          hudIcon("shelf", true),
          `${savedTitles[0]}${savedTitles.length > 1 ? ` +${savedTitles.length - 1}` : ""}`,
          `On Mandala's shelves: ${savedTitles.join(", ")}`
        )
      : hudButton(hudIcon("shelf"), "Save", "Save this video to a Mandala pillar's shelf");
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
    header.textContent = "Save to shelf";
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
      const label = document.createElement("span");
      label.textContent = pillar.title;
      pillarButton.append(hudIcon(isSaved ? "check" : "plus"), label);
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

  if (latestMandalaStatus.autoLogged && (watchedMinutes >= 1 || savedPillarIndexes.length > 0)) {
    const autoLabel = hudButton(
      hudIcon("clock"),
      watchedMinutes >= 1 ? `${watchedMinutes} min` : "Counting",
      "This video's time reaches Mandala on its own, through the time tracker"
    );
    autoLabel.disabled = true;
    hudContainer.appendChild(autoLabel);
  } else if (watchedMinutes >= 1 && savedPillarIndexes.length > 0) {
    const logTimeButton = hudButton(
      hudIcon("clock"),
      `Log ${watchedMinutes} min`,
      `Log ${watchedMinutes} min to ${pillarTitleAt(savedPillarIndexes[0])} in Mandala`
    );
    logTimeButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      void quickLogWatchedTimeToMandala();
    });
    hudContainer.appendChild(logTimeButton);
  }

  const replayButton = hudButton(hudIcon("replay"), "", "Replay the sentence just spoken");
  replayButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void replaySentence();
  });
  const skipButton = hudButton(hudIcon("skip"), "", "Skip to the next sentence");
  skipButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void skipToNextSentence();
  });
  hudContainer.append(replayButton, skipButton);

  const clozeButton = hudButton(
    hudIcon("card"),
    "Cloze",
    "Make a Clozemaster card from the sentence just spoken"
  );
  clozeButton.classList.add("is-accent");
  clozeButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void triggerClozeCardCapture();
  });
  hudContainer.appendChild(clozeButton);

  watchPlayerForHudLayout(playerContainer);
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
  if (!handleClozeModalKey) return;
  if (handleClozeModalKey(keyboardEvent)) {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  } else if (!isEditableTarget(keyboardEvent.target)) {
    // Keep YouTube's own shortcuts (seek, fullscreen, mute) from firing behind the open card.
    keyboardEvent.stopPropagation();
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
      "clozemaster-list": (payload) =>
        browser.runtime.sendMessage({ action: "clozemaster-remote", op: "list", payload }),
      "clozemaster-add": (payload) =>
        browser.runtime.sendMessage({ action: "clozemaster-remote", op: "add", payload }),
      "get-staged-cloze-cards": () => browser.runtime.sendMessage({ action: "get-staged-cloze-cards" }),
      "clear-staged-cloze-cards": (payload) =>
        browser.runtime.sendMessage({
          action: "clear-staged-cloze-cards",
          ids: (payload as { ids?: unknown })?.ids,
        }),
      "get-saved-sessions": () => browser.runtime.sendMessage({ action: "get-saved-sessions" }),
      "open-saved-session": (payload) => browser.runtime.sendMessage({ action: "open-saved-session", payload }),
      "mandala-status": () =>
        browser.runtime.sendMessage({ action: "mandala-remote", op: "status", payload: { url: window.location.href } }),
      "mandala-save": async (payload) => {
        const { pillarIndex, kind } = (payload ?? {}) as { pillarIndex?: unknown; kind?: unknown };
        const response = (await browser.runtime.sendMessage({
          action: "mandala-remote",
          op: "save",
          payload: { pillarIndex, kind, url: canonicalVideoUrl(), title: lastMetadata.title || document.title },
        })) as { success?: boolean } | undefined;
        if (response?.success) void checkMandalaStatusForCurrentPage();
        return response;
      },
      "mandala-log": async (payload) => {
        const requestedMinutes = (payload as { minutes?: unknown } | undefined)?.minutes;
        const fromThisTab = requestedMinutes === undefined || requestedMinutes === null;
        const watchedMinutes = Math.floor(sessionWatchedSeconds / 60);
        if (fromThisTab && watchedMinutes < 1) {
          return {
            success: false,
            errorMessage: "Less than a minute of this video has been watched in this tab. Pass minutes to log a specific amount.",
          };
        }
        const response = (await browser.runtime.sendMessage({
          action: "mandala-remote",
          op: "log",
          payload: {
            url: window.location.href,
            minutes: fromThisTab ? watchedMinutes : requestedMinutes,
            videoTitle: lastMetadata.title,
          },
        })) as { success?: boolean } | undefined;
        if (response?.success && fromThisTab) {
          sessionWatchedSeconds = 0;
          updateImmersionHud();
        }
        return response;
      },
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
