import type { TranscriptSentence } from "../../utils/transcript";
import {
  checkpointAt,
  checkpointText,
  listeningCheckpoints,
  LISTEN_FIRST_KEY,
  type CheckResult,
  type ListeningCheckpoint,
} from "../../utils/listening";
import { page } from "./state";
import { hudIcon, updateImmersionHud } from "./hud";
import { getVideoIdFromLocation } from "./metadata";
import { isWatchOrShorts } from "./playback";
import { finishSentencePlayback, loadImmersionTranscript, playSentence } from "./sentences";
import { element, getTargetPlayerContainer, showImmersionToast } from "./toasts";

export interface ListenCheckState {
  videoId: string;
  checkpoints: ListeningCheckpoint[];
  sentences: TranscriptSentence[];
}

let listenNoTranscriptVideoId: string | null = null;
export let closeListenCard: ((resume: boolean) => void) | null = null;
export let handleListenCardKey: ((keyboardEvent: KeyboardEvent) => boolean) | null = null;
/** Lets the last word ring out before the pause, since sentence ends come from caption timing. */
const LISTEN_PAUSE_TAIL_SECONDS = 0.25;
/** A jump bigger than a tick is a seek, and seeking past a checkpoint should not stop on it. */
const LISTEN_SEEK_SECONDS = 1.5;

export function applyListenFirstClass(): void {
  document.documentElement.classList.toggle("sh-listen-first", page.listenFirst && isWatchOrShorts());
}

export async function prepareListenFirst(): Promise<ListenCheckState | null> {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return null;
  if (page.listenState?.videoId === videoId) return page.listenState;
  const loaded = await loadImmersionTranscript();
  if (!loaded || loaded.videoId !== videoId) {
    if (page.listenFirst && listenNoTranscriptVideoId !== videoId && page.pendingTranscript === null) {
      listenNoTranscriptVideoId = videoId;
      showImmersionToast("Listen first needs captions, and this video has none");
    }
    return null;
  }
  page.listenState = { videoId, checkpoints: listeningCheckpoints(loaded.sentences), sentences: loaded.sentences };
  return page.listenState;
}

export async function setListenFirst(enabled: boolean): Promise<void> {
  page.listenFirst = enabled;
  page.listenPreviousTime = null;
  applyListenFirstClass();
  updateImmersionHud();
  void browser.storage.local.set({ [LISTEN_FIRST_KEY]: enabled });
  if (!enabled) {
    closeListenCard?.(false);
    showImmersionToast("Listen first is off. Captions are back.");
    return;
  }
  const state = await prepareListenFirst();
  if (state) showImmersionToast("Listen first: captions hidden. The video stops after each bit of speech.");
}

export function checkListenFirst(videoElement: HTMLVideoElement): void {
  const currentTime = videoElement.currentTime;
  const previousTime = page.listenPreviousTime;
  page.listenPreviousTime = currentTime;
  if (!page.listenFirst || page.sentencePlayback || closeListenCard || page.closeOpenClozeModal || previousTime === null) return;
  const state = page.listenState;
  if (!state || state.videoId !== getVideoIdFromLocation()) {
    void prepareListenFirst();
    return;
  }
  if (currentTime <= previousTime || currentTime - previousTime > LISTEN_SEEK_SECONDS) return;
  const index = checkpointAt(state.checkpoints, previousTime - LISTEN_PAUSE_TAIL_SECONDS);
  const checkpoint = state.checkpoints[index];
  if (!checkpoint || currentTime < checkpoint.endSeconds + LISTEN_PAUSE_TAIL_SECONDS) return;
  videoElement.pause();
  showListenCard(state, index);
}

function replayCheckpoint(checkpoint: ListeningCheckpoint): void {
  playSentence({ text: "", startSeconds: checkpoint.startSeconds, endSeconds: checkpoint.endSeconds }, { pauseAtEnd: true });
}

function kbdHint(text: string): HTMLElement {
  return element("kbd", "sh-listen-kbd", text);
}

function listenCardButton(label: string, key: string, className = ""): HTMLButtonElement {
  const button = element("button", `sh-listen-btn${className ? ` ${className}` : ""}`);
  button.type = "button";
  button.append(element("span", "", label), kbdHint(key));
  return button;
}

function showListenCard(state: ListenCheckState, index: number): void {
  closeListenCard?.(false);
  const checkpoint = state.checkpoints[index];
  const text = checkpointText(state.sentences, checkpoint);
  let revealed = false;

  const card = element("div", "");
  card.id = "study-harvester-listen-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Listen first check");
  card.setAttribute("aria-live", "polite");

  const head = element("div", "sh-listen-head");
  const tallyText = () => {
    const total = page.listenVideoTally.caught + page.listenVideoTally.read + page.listenVideoTally.missed;
    return total > 0 ? `Caught ${page.listenVideoTally.caught} of ${total} by ear` : "First check in this video";
  };
  head.append(element("span", "sh-listen-kicker", "Listen first"), element("span", "sh-listen-meta", `${index + 1} of ${state.checkpoints.length} · ${tallyText()}`));
  const offButton = element("button", "sh-listen-off", "Turn off");
  offButton.type = "button";
  offButton.title = "Turn Listen first off and bring captions back (E)";
  head.append(offButton);

  const body = element("div", "sh-listen-body");
  const prompt = element("p", "sh-listen-prompt", "Did you catch that?");
  body.append(prompt);

  const actions = element("div", "sh-listen-actions");
  const replayButton = listenCardButton("Replay", "A");
  replayButton.prepend(hudIcon("replay"));
  const secondButton = listenCardButton("Show text", "S");
  const primaryButton = listenCardButton("Caught it", "↵", "is-accent");
  actions.append(replayButton, element("span", "sh-listen-spacer"), secondButton, primaryButton);
  card.append(head, body, actions);

  const close = (resume: boolean) => {
    card.remove();
    closeListenCard = null;
    handleListenCardKey = null;
    const videoElement = document.querySelector("video");
    if (videoElement) {
      finishSentencePlayback(videoElement);
      // Resume from the end of the checkpoint, so a replay does not make it ask again.
      if (resume) {
        if (videoElement.currentTime < checkpoint.endSeconds) videoElement.currentTime = checkpoint.endSeconds + LISTEN_PAUSE_TAIL_SECONDS;
        page.listenPreviousTime = null;
        void videoElement.play();
      }
    }
  };

  const record = (result: CheckResult) => {
    page.listenVideoTally[result] += 1;
    const videoId = state.videoId;
    const sentence =
      result === "caught"
        ? null
        : {
            text,
            clozeWord: null,
            translation: "",
            language: "",
            videoId,
            videoTitle: page.lastMetadata.title,
            channelName: page.lastMetadata.channelName,
            startSeconds: checkpoint.startSeconds,
            endSeconds: checkpoint.endSeconds,
            source: "listening" as const,
          };
    void browser.runtime
      .sendMessage({
        action: "listening-check",
        result,
        video: { videoId, title: page.lastMetadata.title, channelName: page.lastMetadata.channelName, language: page.lastMetadata.language ?? null, languageName: page.lastMetadata.languageName ?? null },
        sentence,
      })
      .catch(() => {});
    close(true);
    if (result !== "caught") showImmersionToast("Saved for review on the desk's Practice page");
  };

  const reveal = () => {
    if (revealed) return;
    revealed = true;
    prompt.remove();
    body.append(element("p", "sh-listen-text", text), element("p", "sh-listen-hint", "Listen again while you read."));
    secondButton.replaceChildren(element("span", "", "Still lost"), kbdHint("N"));
    primaryButton.replaceChildren(element("span", "", "Got it now"), kbdHint("↵"));
    replayCheckpoint(checkpoint);
  };

  replayButton.addEventListener("click", () => replayCheckpoint(checkpoint));
  secondButton.addEventListener("click", () => (revealed ? record("missed") : reveal()));
  primaryButton.addEventListener("click", () => record(revealed ? "read" : "caught"));
  offButton.addEventListener("click", () => void setListenFirst(false));

  closeListenCard = close;
  handleListenCardKey = (keyboardEvent) => {
    if (keyboardEvent.ctrlKey || keyboardEvent.metaKey || keyboardEvent.altKey) return false;
    const key = keyboardEvent.key.toLowerCase();
    if (key === "enter") {
      // A focused button presses itself; let the browser do it.
      if (keyboardEvent.target instanceof HTMLButtonElement && card.contains(keyboardEvent.target)) return false;
      primaryButton.click();
      return true;
    }
    if (key === "a") {
      replayCheckpoint(checkpoint);
      return true;
    }
    if ((key === "s" && !revealed) || (key === "n" && revealed)) {
      secondButton.click();
      return true;
    }
    if (key === "e") {
      void setListenFirst(false);
      return true;
    }
    if (key === "escape" || key === " ") {
      close(true);
      return true;
    }
    return false;
  };

  getTargetPlayerContainer().appendChild(card);
  requestAnimationFrame(() => card.classList.add("is-shown"));
  // Focus on the answer lets Tab reach the card's buttons and screen readers announce the question.
  primaryButton.focus({ preventScroll: true });
}
