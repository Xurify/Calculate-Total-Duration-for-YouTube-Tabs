import type { CachedMandalaAction } from "../../utils/storage";
import { page } from "./state";
import { hudIcon, updateImmersionHud } from "./hud";
import { pillarTitleAt, saveCurrentVideoToMandalaShelf } from "./mandala";

export function removeShelfPopover(): void {
  document.getElementById("study-harvester-shelf-popover")?.remove();
}

/** Fullscreen is its own layer, so the menu has to live inside it or it disappears. */
function shelfPopoverRoot(): HTMLElement {
  return document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.documentElement;
}

function placeShelfPopover(popover: HTMLElement): void {
  const anchor = document.getElementById("study-harvester-player-hud");
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const gap = 8;
  popover.style.top = `${Math.round(rect.bottom + gap)}px`;
  popover.style.right = `${Math.max(gap, Math.round(window.innerWidth - rect.right))}px`;
  popover.style.left = "auto";
}

export function mountShelfPopover(popover: HTMLElement): void {
  placeShelfPopover(popover);
  const root = shelfPopoverRoot();
  if (popover.parentElement !== root) root.appendChild(popover);
}

function popoverItem(icon: HTMLElement | SVGSVGElement, text: string, title: string, onClick: () => void, saved = false): HTMLButtonElement {
  const item = document.createElement("button");
  item.className = `study-harvester-pillar-item${saved ? " saved" : ""}`;
  item.type = "button";
  item.title = title;
  const label = document.createElement("span");
  label.textContent = text;
  item.append(icon, label);
  item.addEventListener("click", onClick);
  return item;
}

function popoverHeader(text: string): HTMLDivElement {
  const header = document.createElement("div");
  header.className = "study-harvester-shelf-header";
  header.textContent = text;
  return header;
}

/** Actions the time can go to: a milestone is reached, not worked on for minutes. */
function loggableActions(pillarIndex: number): CachedMandalaAction[] {
  const pillar = page.latestMandalaStatus.pillars.find((each) => each.index === pillarIndex);
  return (pillar?.actions ?? []).filter((action) => action.kind !== "milestone");
}

export function fillPillarList(popover: HTMLElement): void {
  popover.appendChild(popoverHeader("Save to shelf"));

  if (!page.latestMandalaStatus.connected && !page.latestMandalaStatus.cached) {
    const hint = document.createElement("div");
    hint.className = "study-harvester-shelf-hint";
    hint.textContent = "Open Mandala once so your pillar names show here.";
    popover.appendChild(hint);
  }

  const pillars =
    page.latestMandalaStatus.pillars.length > 0
      ? page.latestMandalaStatus.pillars
      : Array.from({ length: 8 }, (_item, pillarIndex) => ({ index: pillarIndex, title: `Pillar ${pillarIndex + 1}`, actionCount: 0 }));

  for (const pillar of pillars) {
    const isSaved = page.latestMandalaStatus.savedPillarIndexes.includes(pillar.index);
    const hasActions = loggableActions(pillar.index).length > 0;
    popover.appendChild(
      popoverItem(
        hudIcon(isSaved ? "check" : hasActions ? "next" : "plus"),
        pillar.title,
        hasActions ? `Pick which of ${pillar.title}'s actions this video's time goes to` : `Save to ${pillar.title}'s shelf`,
        () => {
          if (hasActions) {
            page.popoverPillarIndex = pillar.index;
            updateImmersionHud();
            return;
          }
          page.isPillarPopoverOpen = false;
          if (!isSaved) void saveCurrentVideoToMandalaShelf(pillar.index);
          else updateImmersionHud();
        },
        isSaved
      )
    );
  }
}

export function fillActionList(popover: HTMLElement, pillarIndex: number): void {
  const back = popoverItem(hudIcon("previous"), pillarTitleAt(pillarIndex), "Back to the pillars", () => {
    page.popoverPillarIndex = null;
    updateImmersionHud();
  });
  back.classList.add("is-back");
  popover.append(back, popoverHeader("Time goes to"));

  const savedLink = page.latestMandalaStatus.savedLinks?.find((link) => link.pillarIndex === pillarIndex);
  for (const action of loggableActions(pillarIndex)) {
    const isCurrent = savedLink?.action === action.id;
    const item = popoverItem(
      hudIcon(isCurrent ? "check" : "plus"),
      action.text,
      isCurrent ? "This video's time already goes here" : action.text,
      () => {
        page.isPillarPopoverOpen = false;
        page.popoverPillarIndex = null;
        void saveCurrentVideoToMandalaShelf(pillarIndex, action);
      },
      isCurrent
    );
    item.disabled = isCurrent;
    popover.appendChild(item);
  }
}
