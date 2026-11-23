import type { LimitWarning } from "../../utils/languageLimits";
import type { Recommendation } from "../../utils/recommendations";
import { formatMinutesWords } from "../../utils/timeUi";

export function getTargetPlayerContainer(): HTMLElement {
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

/** Matches the opacity transition in styles.ts. */
const FADE_MS = 150;

export function showImmersionToast(messageText: string, durationMs = 3200) {
  const existingToast = document.getElementById("study-harvester-hud-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const container = getTargetPlayerContainer();
  const toastElement = document.createElement("div");
  toastElement.id = "study-harvester-hud-toast";
  toastElement.setAttribute("role", "status");
  toastElement.textContent = messageText;

  container.appendChild(toastElement);
  requestAnimationFrame(() => {
    toastElement.style.opacity = "1";
  });

  window.setTimeout(() => {
    toastElement.style.opacity = "0";
    window.setTimeout(() => toastElement.remove(), FADE_MS);
  }, durationMs);
}

export const LIMIT_TOAST_MS = 9000;
const LIMIT_CARD_ID = "study-harvester-limit-card";

export function limitNearText(warning: LimitWarning): string {
  return `${warning.language}: ${formatMinutesWords(warning.usedSeconds)} of your ${formatMinutesWords(warning.minutes * 60)} daily limit`;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function closeLimitCard(): void {
  const card = document.getElementById(LIMIT_CARD_ID);
  if (!card) return;
  card.classList.remove("is-shown");
  window.setTimeout(() => card.remove(), FADE_MS);
}

/** Built from DOM nodes, since titles come from YouTube and are shown as text. */
export function showLimitCard(warning: LimitWarning, recommendations: Recommendation[]): void {
  document.getElementById(LIMIT_CARD_ID)?.remove();
  const card = element("div", "");
  card.id = LIMIT_CARD_ID;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `${warning.language} limit reached`);

  const head = element("div", "sh-limit-head");
  head.append(element("strong", "sh-limit-title", `${warning.language} limit reached`), element("span", "sh-limit-used", `${formatMinutesWords(warning.usedSeconds)} of ${formatMinutesWords(warning.minutes * 60)}`));
  card.append(head);
  if (recommendations.length > 0) card.append(element("p", "sh-limit-note", "Switch to something from your history instead?"));

  const list = element("div", "sh-limit-list");
  for (const pick of recommendations) {
    const link = element("a", "sh-limit-pick");
    link.href = `/watch?v=${encodeURIComponent(pick.videoId)}${pick.resumeSeconds > 0 ? `&t=${pick.resumeSeconds}s` : ""}`;
    const thumb = element("img", "sh-limit-thumb");
    thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(pick.videoId)}/mqdefault.jpg`;
    thumb.alt = "";
    const body = element("span", "sh-limit-body");
    const where = pick.resumeSeconds > 0 ? `${formatMinutesWords(pick.durationSeconds - pick.resumeSeconds)} left` : formatMinutesWords(pick.durationSeconds);
    body.append(element("span", "sh-limit-pick-title", pick.title || pick.videoId), element("span", "sh-limit-meta", [pick.language, pick.channelName, where].filter(Boolean).join(" · ")));
    if (pick.forGoal) body.append(element("span", "sh-limit-goal", "Counts toward today's goal"));
    link.append(thumb, body);
    link.addEventListener("click", () => closeLimitCard());
    list.append(link);
  }
  card.append(list);

  const actions = element("div", "sh-limit-actions");
  const keep = element("button", "sh-limit-btn", "Keep watching");
  keep.type = "button";
  keep.addEventListener("click", closeLimitCard);
  const pause = element("button", "sh-limit-btn is-accent", "Pause here");
  pause.type = "button";
  pause.addEventListener("click", () => {
    document.querySelector("video")?.pause();
    closeLimitCard();
  });
  actions.append(keep, pause);
  card.append(actions);

  getTargetPlayerContainer().appendChild(card);
  requestAnimationFrame(() => card.classList.add("is-shown"));
}
