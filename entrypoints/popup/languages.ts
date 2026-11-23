import { VideoData } from "../../utils/storage";
import { languageCodeOf } from "../../utils/languageFlags";
import { isGoal, languageKey, type LanguageTodayRow } from "../../utils/languageLimits";
import { updateVideoListCardsFromState } from "./video-list";

export function popupLanguageLabel(video: VideoData): string | null {
  const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
  if (stripped) return stripped;
  if (video.language) return video.language.toUpperCase();
  return null;
}

/** The queue and the watch log can name one language differently ("Slovak", "slovaki", "sk"), so rows meet on the code. */
function popupLanguageKey(label: string): string {
  return languageCodeOf(label) ?? languageKey(label);
}

let languageToday: LanguageTodayRow[] = [];

export function loadLanguageToday(): Promise<void> {
  return browser.runtime
    .sendMessage({ action: "get-language-today" })
    .then((response: { rows?: LanguageTodayRow[] } | undefined) => {
      languageToday = response?.rows ?? [];
      updateVideoListCardsFromState();
    })
    .catch(() => {});
}

interface TodayWatchSummary {
  hasGoal: boolean;
  goalUsedSeconds: number;
  goalMinutes: number;
  usedSeconds: number;
}

/** Goals take the header line when any exist; otherwise it reports everything watched today. */
export function todayWatchSummary(): TodayWatchSummary {
  const goals = languageToday.filter(isGoal);
  return {
    hasGoal: goals.length > 0,
    goalUsedSeconds: goals.reduce((sum, row) => sum + row.usedSeconds, 0),
    goalMinutes: goals.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
    usedSeconds: languageToday.reduce((sum, row) => sum + row.usedSeconds, 0),
  };
}

export function isOverLimitToday(video: VideoData): boolean {
  const label = popupLanguageLabel(video);
  if (!label) return false;
  return languageToday.some((row) => row.level === "over" && !isGoal(row) && popupLanguageKey(row.language) === popupLanguageKey(video.language || label));
}
