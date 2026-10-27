import { buildSentences, countWordFrequencies, sentenceIndexAt, type TranscriptSentence } from "../../utils/transcript";
import { requestPageTranscript } from "../../utils/youtubeTranscript";
import { page } from "./state";
import { getVideoIdFromLocation } from "./metadata";
import type { ImmersionTranscript } from "./state";
import { showImmersionToast } from "./toasts";

export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

/** `allowOpeningPanel` may flash YouTube's transcript panel open, so only a user action passes it. */
export async function loadImmersionTranscript(allowOpeningPanel = false): Promise<ImmersionTranscript | null> {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return null;
  if (page.immersionTranscript?.videoId === videoId) return page.immersionTranscript;
  if (page.pendingTranscript?.videoId === videoId) {
    const pending = await page.pendingTranscript.request;
    if (pending || !allowOpeningPanel) return pending;
  }

  const request = requestPageTranscript(videoId, { allowOpeningPanel }).then((pageTranscript) => {
    if (page.pendingTranscript?.videoId === videoId) page.pendingTranscript = null;
    if (!pageTranscript || getVideoIdFromLocation() !== videoId) return null;
    const { sentences, punctuated } = buildSentences(pageTranscript.segments);
    if (sentences.length === 0) return null;
    page.immersionTranscript = {
      videoId,
      languageCode: pageTranscript.languageCode,
      punctuated,
      sentences,
      frequencies: countWordFrequencies(sentences, pageTranscript.languageCode),
    };
    return page.immersionTranscript;
  });
  page.pendingTranscript = { videoId, request };
  return request;
}

export function finishSentencePlayback(videoElement: HTMLVideoElement): void {
  if (!page.sentencePlayback) return;
  if (page.sentencePlayback.restoreRate !== null) videoElement.playbackRate = page.sentencePlayback.restoreRate;
  page.sentencePlayback = null;
}

export function playSentence(
  sentence: TranscriptSentence,
  options: { rate?: number; pauseAtEnd?: boolean } = {}
): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  finishSentencePlayback(videoElement);
  videoElement.currentTime = sentence.startSeconds;
  if (options.rate || options.pauseAtEnd) {
    page.sentencePlayback = {
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

export function checkSentencePlayback(videoElement: HTMLVideoElement): void {
  if (!page.sentencePlayback) return;
  const { startSeconds, endSeconds, pauseAtEnd } = page.sentencePlayback;
  if (videoElement.currentTime >= endSeconds) {
    if (pauseAtEnd) videoElement.pause();
    finishSentencePlayback(videoElement);
  } else if (videoElement.currentTime < startSeconds - 0.5) {
    finishSentencePlayback(videoElement);
  }
}

export async function replaySentence(): Promise<void> {
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
  showImmersionToast(page.listenFirst ? "Replaying the sentence" : `“${truncateText(sentence.text, 60)}”`);
}

export async function skipToNextSentence(): Promise<void> {
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
  showImmersionToast(page.listenFirst ? "Next sentence" : `“${truncateText(nextSentence.text, 60)}”`);
}
