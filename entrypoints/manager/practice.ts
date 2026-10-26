import { escapeHtml } from "../../utils/timeUi";
import { languageFlagHtml } from "../../utils/languageFlags";
import { daysUntil, dueSentences, isLearned, nextDueAt, splitAtWord, type BankSentence, type ReviewGrade } from "../../utils/sentenceBank";
import { caughtShare, checkCount, type ListeningSummary, type ListeningTotals } from "../../utils/listening";
import { clozemasterSectionHtml, wireClozemaster } from "./clozemasterSend";

/**
 * The desk's Practice page: saved sentences reviewed with the speaker's own voice, and the results of
 * listen-first checks on YouTube.
 */

interface PracticeResponse {
  bank: BankSentence[];
  listening: ListeningSummary;
  errorMessage?: string;
}

export interface PracticeHost {
  hero: (options: { kicker: string; title: string; value: string; suffix: string }) => void;
  stats: (text: string) => void;
  toast: (message: string, action?: { label: string; run: () => void | Promise<void> }) => void;
}

const LIST_PAGE = 30;
const RECENT_VIDEOS = 8;
/** Clips end with a short pause in the player; the button stays in "Playing" a moment past the clip. */
const PLAYING_GRACE_MS = 1200;

let data: PracticeResponse | null = null;
let queue: string[] = [];
let reviewedToday = 0;
let revealed = false;
let playedThisSession = false;
let playing: { id: string; timer: number } | null = null;
let clipMessage: { id: string; text: string } | null = null;
let listShown = LIST_PAGE;
let panelRef: HTMLElement | null = null;
let host: PracticeHost | null = null;
let wired = false;

const ICONS = {
  ear: `<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>`,
  list: `<path d="M12 12H3M16 6H3M12 18H3"/><path d="m16 12 5 3-5 3v-6z"/>`,
};

function iconHtml(name: keyof typeof ICONS, size: number, className = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 ${className}" aria-hidden="true">${ICONS[name]}</svg>`;
}

function sectionHeading(title: string, icon: keyof typeof ICONS, extra = ""): string {
  return `<div class="flex items-center gap-3 flex-wrap"><h2 class="font-display text-[22px] font-medium m-0 flex-1 flex items-center gap-2">${iconHtml(icon, 18, "text-text-muted")}${escapeHtml(title)}</h2>${extra}</div>`;
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

function videoUrl(sentence: Pick<BankSentence, "videoId" | "startSeconds">): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(sentence.videoId)}&t=${Math.floor(sentence.startSeconds)}s`;
}

function sentenceTextHtml(sentence: BankSentence): string {
  const parts = splitAtWord(sentence.text, sentence.clozeWord);
  if (!parts) return escapeHtml(sentence.text);
  return `${escapeHtml(parts.before)}<mark class="practice-word">${escapeHtml(parts.word)}</mark>${escapeHtml(parts.after)}`;
}

function languageHtml(language: string): string {
  if (!language) return "";
  return `<span class="inline-flex items-center gap-1.5">${languageFlagHtml(language)}${escapeHtml(language)}</span>`;
}

function sourceWords(sentence: BankSentence): string {
  return sentence.source === "cloze" ? "Cloze card" : "Listen first";
}

function dueWords(sentence: BankSentence, now: number): string {
  if (isLearned(sentence)) return "Learned";
  const days = daysUntil(sentence.dueAt, now);
  if (sentence.dueAt <= now || days <= 0) return "Due today";
  return days === 1 ? "Tomorrow" : `In ${days} days`;
}

function nextReviewWords(now: number): string {
  const next = data ? nextDueAt(data.bank, now) : null;
  if (next === null) return "";
  const days = daysUntil(next, now);
  const count = data!.bank.filter((sentence) => !isLearned(sentence) && daysUntil(sentence.dueAt, now) === days).length;
  return `${days <= 1 ? "Tomorrow" : `In ${days} days`}: ${plural(count, "sentence")}.`;
}

function currentSentence(): BankSentence | null {
  if (!data) return null;
  while (queue.length > 0) {
    const sentence = data.bank.find((item) => item.id === queue[0]);
    if (sentence) return sentence;
    queue.shift();
  }
  return null;
}

/** Word-shaped bars in place of the hidden text, so the sentence's length and rhythm show before the words do. */
function redactedHtml(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span class="practice-redacted-word" style="width:${Math.max(1, [...word].length * 0.5).toFixed(2)}em"></span>`)
    .join(" ");
}

function playButtonHtml(sentence: BankSentence, className: string, label: string): string {
  const isPlaying = playing?.id === sentence.id;
  const words = isPlaying ? "Playing" : label;
  return `<button type="button" class="${className}${isPlaying ? " is-playing" : ""}" data-practice-action="play" data-id="${escapeHtml(sentence.id)}" aria-label="${escapeHtml(words)}" title="${escapeHtml(words)}">
    ${
      isPlaying
        ? `<span class="practice-bars" aria-hidden="true"><span></span><span></span><span></span></span>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`
    }
  </button>`;
}

function reviewCardHtml(now: number): string {
  if (!data) return "";
  const sentence = currentSentence();
  const total = reviewedToday + queue.length;
  if (!sentence) {
    if (data.bank.length === 0) {
      return `<section class="practice-card practice-card--empty">
        <h2 class="font-display text-2xl font-medium m-0">No sentences yet</h2>
        <p class="text-sm text-text-secondary m-0 max-w-[60ch]">Sentences land here in two ways on YouTube: press <kbd>N</kbd> “Still lost” in a Listen first check, or save a cloze card with <kbd>X</kbd>. Each one keeps the moment it was spoken, so you review it in the speaker's own voice.</p>
      </section>`;
    }
    const learned = data.bank.filter(isLearned).length;
    return `<section class="practice-card practice-card--empty">
      <h2 class="font-display text-2xl font-medium m-0">${reviewedToday > 0 ? "Done for today" : "Nothing to review today"}</h2>
      <p class="text-sm text-text-secondary m-0">${reviewedToday > 0 ? `${plural(reviewedToday, "review")} this sitting. ` : ""}${escapeHtml(nextReviewWords(now))}</p>
      <p class="text-xs text-text-muted m-0">${plural(data.bank.length, "sentence")} saved · ${learned} learned</p>
    </section>`;
  }

  const message = clipMessage?.id === sentence.id ? clipMessage.text : "";
  const status =
    playing?.id === sentence.id
      ? "Playing in YouTube…"
      : message || (playedThisSession ? "Space plays it again" : "Space plays it in a small YouTube window");
  const translation = sentence.translation ? `<p class="practice-translation">${escapeHtml(sentence.translation)}</p>` : "";
  return `<section class="practice-card" aria-label="Review">
    <div class="flex items-center gap-3 text-xs text-text-muted">
      <span class="practice-kicker">Review</span>
      <span class="tabular-nums">${reviewedToday + 1} of ${total}</span>
      <span class="flex-1"></span>
      ${languageHtml(sentence.language)}
      <span class="practice-source practice-source--${sentence.source}">${sourceWords(sentence)}</span>
    </div>
    <div class="practice-stage">
      ${playButtonHtml(sentence, "practice-play", "Play the sentence (Space)")}
      <div class="min-w-0 flex-1 flex flex-col gap-2">
        ${
          revealed
            ? `<p class="practice-text">${sentenceTextHtml(sentence)}</p>${translation}`
            : `<button type="button" class="practice-redacted" data-practice-action="reveal" aria-label="Text hidden. Show text (T)" title="Show text (T)">${redactedHtml(sentence.text)}</button>`
        }
        <p class="practice-status${message ? " text-danger" : ""}" role="status">
          <span>${escapeHtml(status)}</span>
          ${revealed ? "" : `<button type="button" class="link-btn" data-practice-action="reveal">Show text <kbd>T</kbd></button>`}
        </p>
      </div>
    </div>
    <div class="practice-actions">
      <a class="practice-origin" href="${escapeHtml(videoUrl(sentence))}" target="_blank" rel="noopener noreferrer" title="Open the video at this moment">
        <img src="https://i.ytimg.com/vi/${encodeURIComponent(sentence.videoId)}/mqdefault.jpg" alt="" loading="lazy" />
        <span class="min-w-0 flex flex-col"><span class="truncate text-text-primary">${escapeHtml(sentence.videoTitle || sentence.videoId)}</span><span class="text-text-muted tabular-nums">${formatClock(sentence.startSeconds)}${sentence.channelName ? ` · ${escapeHtml(sentence.channelName)}` : ""}</span></span>
      </a>
      <span class="flex-1"></span>
      <button type="button" class="practice-grade" data-practice-action="again" title="See it again tomorrow, and once more before this sitting ends">Again <kbd>A</kbd></button>
      <button type="button" class="practice-grade practice-grade--good" data-practice-action="good" title="Push it further out: 1, 3, 7, 16, then 35 days">Got it <kbd>G</kbd></button>
    </div>
  </section>`;
}

function listeningBarHtml(totals: ListeningTotals, className = "h-2"): string {
  const count = checkCount(totals);
  if (count === 0) return "";
  const segment = (value: number, kind: string) => (value > 0 ? `<span class="listen-seg listen-seg--${kind}" style="flex:${value} 1 0px"></span>` : "");
  return `<span class="listen-bar ${className}" role="img" aria-label="${escapeHtml(`${percent(totals.caught, count)} caught by ear, ${percent(totals.read, count)} after reading, ${percent(totals.missed, count)} missed`)}">${segment(totals.caught, "caught")}${segment(totals.read, "read")}${segment(totals.missed, "missed")}</span>`;
}

function listeningSectionHtml(): string {
  const listening = data?.listening;
  const heading = sectionHeading(
    "Listen first",
    "ear",
    `<span class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
      <span class="flex items-center gap-1.5"><span class="legend-swatch listen-seg--caught"></span>Caught by ear</span>
      <span class="flex items-center gap-1.5"><span class="legend-swatch listen-seg--read"></span>After reading</span>
      <span class="flex items-center gap-1.5"><span class="legend-swatch listen-seg--missed"></span>Missed</span>
    </span>`
  );
  if (!listening || listening.videos.length === 0) {
    return `<section class="flex flex-col gap-3">${heading}
      <p class="text-sm text-text-secondary m-0 max-w-[70ch]">On a YouTube video with captions, press <kbd>E</kbd> or the ear button. Captions hide, the video stops after each bit of speech, and you say whether you caught it. What you catch by ear shows up here, per language and per video.</p>
    </section>`;
  }
  const languages = listening.byLanguage
    .map(
      (row) => `<li class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <span class="truncate font-medium text-text-primary">${languageHtml(row.language) || "Unknown language"}</span>
        ${listeningBarHtml(row, "h-2.5")}
        <span class="text-text-secondary tabular-nums whitespace-nowrap"><span class="font-display text-lg text-text-primary">${percent(row.caught, checkCount(row))}</span> by ear <span class="text-text-muted">· ${plural(checkCount(row), "check")} · ${plural(row.videos, "video")}</span></span>
      </li>`
    )
    .join("");
  const videos = listening.videos
    .slice(0, RECENT_VIDEOS)
    .map(
      (video) => `<li class="grid grid-cols-[4rem_minmax(0,1fr)_8rem_4.5rem] items-center gap-3 text-sm">
        <img src="https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/mqdefault.jpg" alt="" loading="lazy" class="w-16 h-9 rounded object-cover bg-surface-hover" />
        <span class="min-w-0 flex flex-col">
          <a href="https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}" target="_blank" rel="noopener noreferrer" class="truncate text-text-primary no-underline hover:text-accent">${escapeHtml(video.title || video.videoId)}</a>
          <span class="truncate text-xs text-text-muted">${escapeHtml([video.channelName, video.language, plural(checkCount(video), "check")].filter(Boolean).join(" · "))}</span>
        </span>
        ${listeningBarHtml(video)}
        <span class="text-right tabular-nums text-text-secondary">${Math.round(caughtShare(video) * 100)}%</span>
      </li>`
    )
    .join("");
  return `<section class="flex flex-col gap-3">${heading}
    <ul class="m-0 p-0 list-none flex flex-col gap-2.5">${languages}</ul>
    <h3 class="text-xs font-semibold uppercase tracking-[0.1em] text-text-muted m-0 mt-2">Recent videos</h3>
    <ul class="m-0 p-0 list-none flex flex-col gap-2.5">${videos}</ul>
  </section>`;
}

function sentenceListHtml(now: number): string {
  if (!data || data.bank.length === 0) return "";
  const sorted = [...data.bank].sort((first, second) => second.createdAt - first.createdAt);
  const rows = sorted
    .slice(0, listShown)
    .map(
      (sentence) => `<li class="practice-row">
        ${playButtonHtml(sentence, "practice-row-play", `Play “${sentence.text}”`)}
        <span class="min-w-0 flex flex-col gap-0.5">
          <span class="text-sm text-text-primary">${sentenceTextHtml(sentence)}</span>
          <span class="text-xs text-text-muted truncate">${escapeHtml([sentence.language, sentence.videoTitle, formatClock(sentence.startSeconds), sourceWords(sentence), sentence.clozemasterAt ? "In Clozemaster" : ""].filter(Boolean).join(" · "))}</span>
          ${clipMessage?.id === sentence.id ? `<span class="text-xs text-danger" role="status">${escapeHtml(clipMessage.text)}</span>` : ""}
        </span>
        <span class="practice-due${isLearned(sentence) ? " practice-due--learned" : ""}">${dueWords(sentence, now)}</span>
        <button type="button" class="queue-action" data-practice-action="delete" data-id="${escapeHtml(sentence.id)}" title="Delete this sentence" aria-label="Delete this sentence">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </li>`
    )
    .join("");
  const more = Math.min(LIST_PAGE, sorted.length - listShown);
  return `<section class="flex flex-col gap-3 pb-6">
    ${sectionHeading("Saved sentences", "list", `<span class="text-xs text-text-muted tabular-nums">${sorted.length}</span>`)}
    <ul class="m-0 p-0 list-none flex flex-col">${rows}</ul>
    ${more > 0 ? `<button type="button" class="chip h-8 text-xs self-start" data-practice-action="more">Show ${more} more</button>` : ""}
  </section>`;
}

const FOCUS_KEYS = ["practiceAction", "cmAction", "cmField", "id", "word"] as const;

/** The whole page is re-rendered on each change; this finds the same control again afterwards. */
function focusedControl(panel: HTMLElement): { selector: string; caret: number | null } | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !panel.contains(active)) return null;
  const parts = FOCUS_KEYS.filter((key) => active.dataset[key] !== undefined).map(
    (key) => `[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(active.dataset[key]!)}"]`
  );
  if (parts.length === 0) return null;
  return { selector: parts.join(""), caret: active instanceof HTMLInputElement && active.type === "text" ? active.selectionStart : null };
}

function restoreFocus(panel: HTMLElement, focus: ReturnType<typeof focusedControl>): void {
  if (!focus) return;
  const element = panel.querySelector<HTMLElement>(focus.selector);
  if (!element || (element as HTMLButtonElement).disabled) return;
  element.focus();
  if (focus.caret !== null && element instanceof HTMLInputElement) element.setSelectionRange(focus.caret, focus.caret);
}

function paint(): void {
  const panel = panelRef;
  if (!panel || !data) return;
  const now = Date.now();
  const due = queue.length;
  host?.hero({ kicker: "Practice", title: "", value: due > 0 ? String(due) : "No", suffix: due === 1 ? "sentence to review" : "sentences to review" });
  const learned = data.bank.filter(isLearned).length;
  const checks = data.listening.byLanguage.reduce((sum, row) => sum + checkCount(row), 0);
  host?.stats(
    data.bank.length === 0 && checks === 0
      ? ""
      : [plural(data.bank.length, "sentence") + " saved", `${learned} learned`, checks > 0 ? `${plural(checks, "listening check")}` : ""].filter(Boolean).join(" · ")
  );
  const focus = focusedControl(panel);
  panel.innerHTML = `${reviewCardHtml(now)}${clozemasterSectionHtml()}${listeningSectionHtml()}${sentenceListHtml(now)}`;
  panel.setAttribute("aria-busy", "false");
  restoreFocus(panel, focus);
  updatePracticeBadge(due);
}

export function updatePracticeBadge(due: number): void {
  const badge = document.getElementById("practice-badge");
  if (!badge) return;
  badge.textContent = String(due);
  badge.classList.toggle("hidden", due === 0);
}

async function play(id: string): Promise<void> {
  const sentence = data?.bank.find((item) => item.id === id);
  if (!sentence) return;
  if (playing) clearTimeout(playing.timer);
  clipMessage = null;
  playedThisSession = true;
  playing = { id, timer: 0 };
  paint();
  let response: { success?: boolean; errorMessage?: string } | undefined;
  try {
    response = (await browser.runtime.sendMessage({ action: "play-clip", videoId: sentence.videoId, startSeconds: sentence.startSeconds, endSeconds: sentence.endSeconds })) as typeof response;
  } catch (error) {
    response = { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
  if (playing?.id !== id) return;
  if (!response?.success) {
    playing = null;
    clipMessage = { id, text: `Couldn't play it: ${response?.errorMessage ?? "no answer from YouTube."}` };
    paint();
    return;
  }
  const length = (sentence.endSeconds - sentence.startSeconds) * 1000 + PLAYING_GRACE_MS;
  playing.timer = window.setTimeout(() => {
    if (playing?.id !== id) return;
    playing = null;
    paint();
  }, length);
}

async function grade(gradeValue: ReviewGrade): Promise<void> {
  const sentence = currentSentence();
  if (!sentence || !data) return;
  queue.shift();
  // "Again" also comes back once more in this sitting, so it is heard twice before tomorrow.
  if (gradeValue === "again" && !queue.includes(sentence.id)) queue.push(sentence.id);
  reviewedToday += 1;
  revealed = false;
  const response = (await browser.runtime.sendMessage({ action: "bank-review", id: sentence.id, grade: gradeValue })) as { bank?: BankSentence[] } | undefined;
  if (response?.bank) data.bank = response.bank;
  paint();
  const next = currentSentence();
  if (next && playedThisSession) void play(next.id);
}

async function remove(id: string): Promise<void> {
  if (!data) return;
  const removed = data.bank.find((sentence) => sentence.id === id);
  const queuePosition = queue.indexOf(id);
  const response = (await browser.runtime.sendMessage({ action: "bank-delete", id })) as { bank?: BankSentence[] } | undefined;
  if (response?.bank) data.bank = response.bank;
  queue = queue.filter((queued) => queued !== id);
  paint();
  if (!removed) return;
  host?.toast("Sentence deleted", {
    label: "Undo",
    run: async () => {
      const restored = (await browser.runtime.sendMessage({ action: "bank-restore", sentence: removed })) as { bank?: BankSentence[] } | undefined;
      if (!data || !restored?.bank) return;
      data.bank = restored.bank;
      if (queuePosition !== -1 && !queue.includes(id)) queue.splice(Math.min(queuePosition, queue.length), 0, id);
      paint();
    },
  });
}

function reveal(): void {
  if (revealed || !currentSentence()) return;
  revealed = true;
  paint();
}

function wire(panel: HTMLElement): void {
  if (wired) return;
  wired = true;
  wireClozemaster(panel, {
    bank: () => data?.bank ?? [],
    setBank: (bank) => {
      if (data) data.bank = bank;
    },
    repaint: paint,
  });
  panel.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-practice-action]");
    if (!button) return;
    const action = button.dataset.practiceAction;
    if (action === "play" && button.dataset.id) void play(button.dataset.id);
    else if (action === "reveal") reveal();
    else if (action === "again") void grade("again");
    else if (action === "good") void grade("good");
    else if (action === "delete" && button.dataset.id) void remove(button.dataset.id);
    else if (action === "more") {
      listShown += LIST_PAGE;
      paint();
    }
  });
}

export async function renderPracticePanel(panel: HTMLElement, practiceHost: PracticeHost): Promise<void> {
  panelRef = panel;
  host = practiceHost;
  wire(panel);
  if (!data) panel.setAttribute("aria-busy", "true");
  let response: PracticeResponse | undefined;
  try {
    response = (await browser.runtime.sendMessage({ action: "get-practice" })) as PracticeResponse | undefined;
    if (!response || response.errorMessage) throw new Error(response?.errorMessage || "No answer");
  } catch (error) {
    panel.innerHTML = `<div class="flex flex-col items-start gap-3">
      <p class="text-sm text-text-secondary m-0">Your sentences could not be loaded. Nothing was lost. Try again in a moment.</p>
      <p class="text-xs text-text-muted m-0">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
    </div>`;
    panel.setAttribute("aria-busy", "false");
    return;
  }
  data = response;
  const due = dueSentences(data.bank).map((sentence) => sentence.id);
  // Keep the sitting's order, add anything that came due meanwhile.
  queue = [...queue.filter((id) => data!.bank.some((sentence) => sentence.id === id)), ...due.filter((id) => !queue.includes(id))];
  paint();
}

export async function refreshPracticeBadge(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({ action: "get-practice" })) as PracticeResponse | undefined;
    if (response?.bank) updatePracticeBadge(dueSentences(response.bank).length);
  } catch {
    // The badge is a hint; the page shows the real count.
  }
}

/** Space plays, T shows the text, A and G grade. Number keys stay free for switching views. */
export function handlePracticeKeydown(event: KeyboardEvent): boolean {
  const sentence = currentSentence();
  if (!sentence) return false;
  if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter")) return false;
  switch (event.key) {
    case " ":
      void play(sentence.id);
      return true;
    case "t":
      reveal();
      return true;
    case "a":
      void grade("again");
      return true;
    case "g":
      void grade("good");
      return true;
  }
  return false;
}
