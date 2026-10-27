import type { StagedClozeCard } from "../../utils/storage";
import {
  countWordFrequencies,
  maskSentence,
  pickClozeToken,
  segmentWords,
  sentenceIndexAt,
  type TranscriptSentence,
  type WordToken,
} from "../../utils/transcript";
import { page } from "./state";
import { hudIcon } from "./hud";
import { extractLiveCaptionText, getVideoIdFromLocation } from "./metadata";
import {
  finishSentencePlayback,
  formatTimestamp,
  loadImmersionTranscript,
  playSentence,
  truncateText,
} from "./sentences";
import { getTargetPlayerContainer, showImmersionToast } from "./toasts";

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
  page.closeOpenClozeModal?.(false);

  const modalWrapper = document.createElement("div");
  modalWrapper.id = "study-harvester-cloze-modal";
  const cardElement = document.createElement("div");
  cardElement.className = "study-harvester-cloze-card";
  cardElement.setAttribute("role", "dialog");
  cardElement.setAttribute("aria-modal", "true");
  cardElement.setAttribute("aria-label", "Make a cloze card");
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
  closeButton.setAttribute("aria-label", "Close");
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
  previousButton.setAttribute("aria-label", "Previous sentence");
  const listenButton = createElement("button", "study-harvester-cloze-nav-btn is-listen");
  const listenTime = createElement("span", "");
  listenButton.append(hudIcon("play", true), listenTime);
  listenButton.type = "button";
  listenButton.title = "Play this sentence";
  listenButton.setAttribute("aria-label", "Play this sentence");
  const nextButton = createElement("button", "study-harvester-cloze-nav-btn");
  nextButton.appendChild(hudIcon("next"));
  nextButton.type = "button";
  nextButton.title = "Next sentence";
  nextButton.setAttribute("aria-label", "Next sentence");
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
  cardElement.appendChild(
    createElement("div", "study-harvester-cloze-note", "← → word · ↑ ↓ sentence · Enter save · Esc close")
  );

  const renderAnswer = () => {
    answerLine.replaceChildren();
    if (!chosenToken) {
      answerLine.textContent = "Click a word, or use ← →, to blank it out";
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
      wordButton.setAttribute("aria-pressed", String(token === chosenToken));
      wordButton.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        chosenToken = token;
        renderSentenceText();
        renderAnswer();
        sentenceBox.querySelector<HTMLButtonElement>(".is-blank")?.focus();
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
    sourceLine.textContent = page.lastMetadata.title ? `${truncateText(page.lastMetadata.title, 48)} · ${position}` : position;
    listenTime.textContent = formatTimestamp(sentence.startSeconds);
    previousButton.disabled = sentenceIndex === 0;
    nextButton.disabled = sentenceIndex === capture.sentences.length - 1;
    listenButton.disabled = capture.sentences.length === 1 && sentence.endSeconds <= sentence.startSeconds;
    renderSentenceText();
    renderAnswer();
  };

  const moveChosenWord = (step: number) => {
    const words = tokens.filter((token) => token.isWord);
    if (words.length === 0) return;
    const current = chosenToken ? words.indexOf(chosenToken) : -1;
    chosenToken = words[Math.min(words.length - 1, Math.max(0, current + step))];
    preferredWord = null;
    renderSentenceText();
    renderAnswer();
    if (cardElement.contains(document.activeElement) && document.activeElement !== cardElement) {
      sentenceBox.querySelector<HTMLButtonElement>(".is-blank")?.focus();
    }
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
    page.closeOpenClozeModal = null;
    page.handleClozeModalKey = null;
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
      notes: [page.lastMetadata.title, videoId ? `https://youtu.be/${videoId}?t=${startSeconds}` : ""]
        .filter(Boolean)
        .join(" · "),
      language: capture.languageCode ?? page.lastMetadata.language ?? null,
      videoId,
      videoTitle: page.lastMetadata.title,
      timestampSeconds: startSeconds,
      createdAt: Date.now(),
    };

    try {
      const response = (await browser.runtime.sendMessage({ action: "stage-cloze-card", card })) as
        | { success?: boolean }
        | undefined;
      if (!response?.success) throw new Error("not saved");
      if (videoId && sentence.endSeconds > sentence.startSeconds) {
        void browser.runtime
          .sendMessage({
            action: "bank-add",
            sentence: {
              text: sentence.text,
              clozeWord: card.targetWord,
              translation: card.translation,
              language: "",
              videoId,
              videoTitle: page.lastMetadata.title,
              channelName: page.lastMetadata.channelName,
              startSeconds: sentence.startSeconds,
              endSeconds: sentence.endSeconds,
              source: "cloze",
            },
            languageCode: card.language,
            languageName: page.lastMetadata.languageName ?? null,
          })
          .catch(() => {});
      }
      showImmersionToast(`Saved «${card.targetWord}» for Clozemaster and Practice`);
      close(capture.resumeOnClose);
    } catch {
      showImmersionToast("Couldn't save the card. Try again.");
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

  page.closeOpenClozeModal = close;
  page.handleClozeModalKey = (keyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      close(capture.resumeOnClose);
      return true;
    }
    if (!(keyboardEvent.target instanceof HTMLInputElement)) {
      if (keyboardEvent.key === "ArrowUp" || keyboardEvent.key === "ArrowDown") {
        moveSentence(keyboardEvent.key === "ArrowUp" ? -1 : 1);
        return true;
      }
      if (keyboardEvent.key === "ArrowLeft" || keyboardEvent.key === "ArrowRight") {
        moveChosenWord(keyboardEvent.key === "ArrowLeft" ? -1 : 1);
        return true;
      }
    }
    // Enter on a focused button should press that button, not save the card.
    if (keyboardEvent.key === "Enter" && !keyboardEvent.isComposing && !(keyboardEvent.target instanceof HTMLButtonElement)) {
      void save();
      return true;
    }
    if (keyboardEvent.key === "Tab") {
      const focusable = Array.from(cardElement.querySelectorAll<HTMLElement>("button:not(:disabled), input"));
      if (focusable.length === 0) return false;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (keyboardEvent.shiftKey && (active === first || active === cardElement)) {
        last.focus();
        return true;
      }
      if (!keyboardEvent.shiftKey && active === last) {
        first.focus();
        return true;
      }
      if (!cardElement.contains(active)) {
        first.focus();
        return true;
      }
    }
    return false;
  };

  renderSentence();
  getTargetPlayerContainer().appendChild(modalWrapper);
  cardElement.focus({ preventScroll: true });
}

export async function triggerClozeCardCapture(): Promise<void> {
  if (page.closeOpenClozeModal) return;
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
      languageCode: page.lastMetadata.language ?? null,
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
