import { VideoData } from "../../utils/storage";
import { formatDurationWords } from "../../utils/format";
import { languageCodeOf, languageFlagHtml } from "../../utils/languageFlags";
import { isGoal, languageKey, type LanguageTodayRow } from "../../utils/languageLimits";
import { escapeHtml as escapeText } from "../../utils/timeUi";
import { popup } from "./state";
import { updateVideoListCardsFromState } from "./video-list";
import { getEffectiveWatchedSeconds } from "./videos";

const POPUP_LANGUAGE_PALETTE = [
  "var(--section-coral)",
  "var(--section-amber)",
  "var(--section-lime)",
  "var(--section-teal)",
  "var(--section-sky)",
  "var(--section-indigo)",
  "var(--section-violet)",
  "var(--section-rose)",
];

export function popupLanguageLabel(video: VideoData): string | null {
  const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
  if (stripped) return stripped;
  if (video.language) return video.language.toUpperCase();
  return null;
}

interface PopupLanguageRow {
  key: string;
  label: string;
  flagSource: string;
  seconds: number;
  watched: number;
  today: LanguageTodayRow | null;
  color: string;
}

/** The queue and the watch log can name one language differently ("Slovak", "slovaki", "sk"), so rows meet on the code. */
function popupLanguageKey(label: string): string {
  return languageCodeOf(label) ?? languageKey(label);
}

let languageDisplayNames: Intl.DisplayNames | null = null;

function popupLanguageName(row: PopupLanguageRow): string {
  const code = languageCodeOf(row.flagSource) ?? languageCodeOf(row.label);
  let name = row.label;
  if (code) {
    try {
      languageDisplayNames ??= new Intl.DisplayNames([navigator.language, "en"], { type: "language" });
      name = languageDisplayNames.of(code) ?? name;
    } catch {}
  }
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

const POPUP_LANGUAGE_ROWS = 4;

function popupLanguageRows(): PopupLanguageRow[] {
  const rows = new Map<string, PopupLanguageRow>();
  for (const video of popup.videoData) {
    if (video.excluded || video.isLive || video.seconds <= 0) continue;
    const label = popupLanguageLabel(video) ?? "Unknown";
    const key = label === "Unknown" ? "" : popupLanguageKey(video.language || label);
    const row = rows.get(key) ?? { key, label, flagSource: video.language || label, seconds: 0, watched: 0, today: null, color: "" };
    row.seconds += video.seconds;
    row.watched += getEffectiveWatchedSeconds(video);
    rows.set(key, row);
  }
  const queued = Array.from(rows.values()).sort((a, b) => b.seconds - a.seconds);
  let colorIndex = 0;
  for (const row of queued) {
    row.color = !row.key ? "var(--color-border-hover)" : POPUP_LANGUAGE_PALETTE[colorIndex++ % POPUP_LANGUAGE_PALETTE.length];
  }
  // Rules come first from the background, so a language with a goal or limit keeps that row over a plain one.
  for (const today of languageToday) {
    const key = popupLanguageKey(today.language);
    const row = rows.get(key);
    if (row) {
      row.today ??= today;
    } else {
      const extra = { key, label: today.language, flagSource: today.language, seconds: 0, watched: 0, today, color: "" };
      rows.set(key, extra);
      queued.push(extra);
    }
  }
  if (queued.length <= POPUP_LANGUAGE_ROWS) return queued;
  // A language with a rule stays visible so its warning colour isn't folded away.
  const keep = new Set(queued.filter((row) => row.today?.minutes != null).slice(0, POPUP_LANGUAGE_ROWS - 1));
  for (const row of queued) if (keep.size < POPUP_LANGUAGE_ROWS - 1) keep.add(row);
  const shown = queued.filter((row) => keep.has(row));
  const rest = queued.filter((row) => !shown.includes(row));
  const other: PopupLanguageRow = {
    key: "",
    label: `${rest.length} more`,
    flagSource: "",
    seconds: rest.reduce((sum, row) => sum + row.seconds, 0),
    watched: rest.reduce((sum, row) => sum + row.watched, 0),
    today: null,
    color: "var(--color-border-hover)",
  };
  const otherToday = rest.reduce((sum, row) => sum + (row.today?.usedSeconds ?? 0), 0);
  if (otherToday > 0) other.today = { language: other.label, usedSeconds: otherToday, level: null };
  return [...shown, other];
}

function popupTodayCellHtml(row: PopupLanguageRow): string {
  const today = row.today;
  if (!today || (today.minutes == null && today.usedSeconds < 60)) return `<span class="popup-langs-num text-text-muted" role="cell">–</span>`;
  if (today.minutes == null) return `<span class="popup-langs-num" role="cell">${formatDurationWords(today.usedSeconds)}</span>`;
  const used = Math.floor(today.usedSeconds / 60);
  const tone = today.level === "over" ? "text-danger" : today.level === "near" ? "text-warning" : today.level === "met" ? "text-success" : "";
  const what = isGoal(today) ? "goal" : "limit";
  return `<span class="popup-langs-num ${tone}" role="cell" title="${used} of ${today.minutes} min ${what} today">${used}<span class="text-text-muted font-normal">/${today.minutes} min</span></span>`;
}

/** One line per language: how much of the queue it is, what's left, and how long it played today. */
export function renderPopupLanguages(): void {
  const body = document.getElementById("popup-langs-body");
  if (!body) return;
  const rows = popupLanguageRows();
  const largest = Math.max(1, ...rows.map((row) => row.seconds));
  const html = rows
    .map((row) => {
      const name = row.flagSource ? popupLanguageName(row) : row.label;
      const safeName = escapeText(name);
      const flag = row.flagSource ? languageFlagHtml(row.flagSource, "lang-flag lang-flag--xs shrink-0") : "";
      const left = Math.max(0, row.seconds - row.watched);
      const leftText = row.seconds <= 0 ? "–" : left <= 0 ? "Done" : formatDurationWords(left);
      const bar = row.seconds > 0
        ? `<span class="popup-langs-fill" style="width: ${((row.seconds / largest) * 100).toFixed(1)}%; background: ${row.color}"><span class="popup-lang-done" style="width: ${((row.watched / row.seconds) * 100).toFixed(1)}%"></span></span>`
        : "";
      return `<div class="popup-langs-row" role="row"${row.seconds > 0 ? ` title="${safeName}: ${formatDurationWords(left)} left of ${formatDurationWords(row.seconds)}"` : ""}>
        <span class="flex items-center gap-1.5 min-w-0" role="cell">${flag}<span class="truncate text-text-primary">${safeName}</span></span>
        <span class="popup-langs-track" aria-hidden="true">${bar}</span>
        <span class="popup-langs-num ${row.seconds <= 0 ? "text-text-muted" : ""}" role="cell">${leftText}</span>
        ${popupTodayCellHtml(row)}
      </div>`;
    })
    .join("");
  if (html === lastLanguagesHtml && body.childElementCount > 0) return;
  lastLanguagesHtml = html;
  body.innerHTML = html;
}

let lastLanguagesHtml = "";

let languageToday: LanguageTodayRow[] = [];

export function loadLanguageToday(): void {
  void browser.runtime
    .sendMessage({ action: "get-language-today" })
    .then((response: { rows?: LanguageTodayRow[] } | undefined) => {
      languageToday = response?.rows ?? [];
      renderPopupLanguages();
      updateVideoListCardsFromState();
    })
    .catch(() => {});
}

export function isOverLimitToday(video: VideoData): boolean {
  const label = popupLanguageLabel(video);
  if (!label) return false;
  return languageToday.some((row) => row.level === "over" && !isGoal(row) && popupLanguageKey(row.language) === popupLanguageKey(video.language || label));
}
