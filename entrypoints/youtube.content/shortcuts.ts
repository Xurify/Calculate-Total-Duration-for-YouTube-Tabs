import { page } from "./state";
import { triggerClozeCardCapture } from "./cloze";
import { handleListenCardKey, setListenFirst } from "./listen-first";
import { isWatchOrShorts } from "./playback";
import { replaySentence, skipToNextSentence } from "./sentences";

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

// YouTube leaves these letters unbound; Language Reactor users already know A and D for sentences.
const PLAYER_SHORTCUTS: Record<string, () => void> = {
  a: () => void replaySentence(),
  d: () => void skipToNextSentence(),
  x: () => void triggerClozeCardCapture(),
  e: () => void setListenFirst(!page.listenFirst),
};

function handlePlayerShortcut(keyboardEvent: KeyboardEvent): void {
  if (keyboardEvent.ctrlKey || keyboardEvent.metaKey || keyboardEvent.altKey || keyboardEvent.shiftKey) return;
  if (keyboardEvent.repeat || keyboardEvent.isComposing || isEditableTarget(keyboardEvent.target)) return;
  if (!isWatchOrShorts() || !document.getElementById("study-harvester-player-hud")) return;
  const run = PLAYER_SHORTCUTS[keyboardEvent.key.toLowerCase()];
  if (!run) return;
  keyboardEvent.preventDefault();
  keyboardEvent.stopPropagation();
  run();
}

export function handleGlobalKeydown(keyboardEvent: KeyboardEvent): void {
  if (handleListenCardKey && !page.handleClozeModalKey && !isEditableTarget(keyboardEvent.target)) {
    if (handleListenCardKey(keyboardEvent)) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      return;
    }
  }
  if (!page.handleClozeModalKey) {
    handlePlayerShortcut(keyboardEvent);
    return;
  }
  if (page.handleClozeModalKey(keyboardEvent)) {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  } else if (!isEditableTarget(keyboardEvent.target)) {
    // Keep YouTube's own shortcuts (seek, fullscreen, mute) from firing behind the open card.
    keyboardEvent.stopPropagation();
  }
}
