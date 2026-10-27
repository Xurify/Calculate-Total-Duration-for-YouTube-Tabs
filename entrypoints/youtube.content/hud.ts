import { placeHudBelowNativeControls } from "../../utils/hudLayout";
import { page } from "./state";
import { triggerClozeCardCapture } from "./cloze";
import { setListenFirst } from "./listen-first";
import { pillarTitleAt, quickLogWatchedTimeToMandala } from "./mandala";
import { isWatchOrShorts } from "./playback";
import { replaySentence, skipToNextSentence } from "./sentences";
import { fillActionList, fillPillarList, mountShelfPopover, removeShelfPopover } from "./shelf-popover";
import { injectImmersionStyles } from "./styles";
import { getTargetPlayerContainer } from "./toasts";

export function removeImmersionHud(): void {
  const existingHud = document.getElementById("study-harvester-player-hud");
  if (existingHud) {
    existingHud.remove();
  }
  removeShelfPopover();
  stopHudLayoutWatch();
}

const OWN_OVERLAY_SELECTOR = "#study-harvester-player-hud, #study-harvester-cloze-modal, #study-harvester-hud-toast, #study-harvester-limit-card, #study-harvester-listen-card";
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
  const popover = document.getElementById("study-harvester-shelf-popover");
  if (popover instanceof HTMLElement) mountShelfPopover(popover);
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
  ear: "M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4",
};

export function hudIcon(name: keyof typeof HUD_ICON_PATHS, filled = false): SVGSVGElement {
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

export function updateImmersionHud(): void {
  if (!isWatchOrShorts()) {
    removeImmersionHud();
    return;
  }

  injectImmersionStyles();
  removeShelfPopover();

  const playerContainer = getTargetPlayerContainer();
  let hudContainer = document.getElementById("study-harvester-player-hud");
  if (!hudContainer) {
    hudContainer = document.createElement("div");
    hudContainer.id = "study-harvester-player-hud";
  }
  if (hudContainer.parentElement !== playerContainer) {
    playerContainer.appendChild(hudContainer);
  }

  const savedPillarIndexes = page.latestMandalaStatus.savedPillarIndexes;
  const watchedMinutes = Math.floor(page.sessionWatchedSeconds / 60);

  hudContainer.replaceChildren();
  hudContainer.classList.toggle("is-open", page.isPillarPopoverOpen);

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
    page.isPillarPopoverOpen = !page.isPillarPopoverOpen;
    page.popoverPillarIndex = null;
    updateImmersionHud();
  });
  hudContainer.appendChild(shelfButton);

  if (page.isPillarPopoverOpen) {
    const popover = document.createElement("div");
    popover.id = "study-harvester-shelf-popover";
    popover.className = "study-harvester-shelf-popover";
    popover.addEventListener("click", (clickEvent) => clickEvent.stopPropagation());

    if (page.popoverPillarIndex === null) fillPillarList(popover);
    else fillActionList(popover, page.popoverPillarIndex);

    mountShelfPopover(popover);
  }

  const trackedMinutes = Math.floor((page.latestMandalaStatus.trackedSeconds ?? 0) / 60);
  if (page.latestMandalaStatus.autoLogged && (trackedMinutes >= 1 || savedPillarIndexes.length > 0)) {
    const autoLabel = hudButton(
      hudIcon("clock"),
      trackedMinutes >= 1 ? `${trackedMinutes} min` : "Counting",
      "Time on this video today that reaches Mandala on its own: while this tab is in front, or playing with sound behind another"
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

  const listenButton = hudButton(
    hudIcon("ear"),
    page.listenFirst ? "Listen first" : "",
    page.listenFirst ? "Listen first is on: captions hidden, a check after each bit of speech. Click to turn off (E)" : "Listen first: hide captions and check what you caught (E)"
  );
  listenButton.classList.toggle("is-on", page.listenFirst);
  listenButton.setAttribute("aria-pressed", String(page.listenFirst));
  listenButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void setListenFirst(!page.listenFirst);
  });
  hudContainer.appendChild(listenButton);

  const replayButton = hudButton(hudIcon("replay"), "", "Replay the sentence just spoken (A)");
  replayButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void replaySentence();
  });
  const skipButton = hudButton(hudIcon("skip"), "", "Skip to the next sentence (D)");
  skipButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void skipToNextSentence();
  });
  hudContainer.append(replayButton, skipButton);

  const clozeButton = hudButton(
    hudIcon("card"),
    "Cloze",
    "Make a Clozemaster card from the sentence just spoken (X)"
  );
  clozeButton.classList.add("is-accent");
  clozeButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void triggerClozeCardCapture();
  });
  hudContainer.appendChild(clozeButton);

  watchPlayerForHudLayout(playerContainer);
}
