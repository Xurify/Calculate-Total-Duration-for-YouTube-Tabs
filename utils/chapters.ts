import type { VideoChapter } from "./storage";

export function parseTimestampToSeconds(timestampText: string): number {
  const parts = timestampText.trim().split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

interface ChapterRendererItem {
  chapterRenderer?: {
    title?: { simpleText?: string; runs?: Array<{ text: string }> };
    timeRangeStartMillis?: number;
  };
}

interface MarkersMapEntry {
  key?: string;
  value?: {
    chapters?: ChapterRendererItem[];
  };
}

export function extractChaptersFromPlayerResponse(
  playerResponse: unknown,
  totalDurationSeconds: number
): VideoChapter[] {
  if (!playerResponse || typeof playerResponse !== "object") {
    return [];
  }

  const responseRecord = playerResponse as {
    playerOverlays?: {
      playerOverlayRenderer?: {
        decoratedPlayerBarRenderer?: {
          decoratedPlayerBarRenderer?: {
            playerBar?: {
              multiMarkersPlayerBarRenderer?: {
                markersMap?: MarkersMapEntry[];
              };
            };
          };
        };
      };
    };
    videoDetails?: {
      shortDescription?: string;
    };
  };

  const markersMap =
    responseRecord.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
      ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;

  if (Array.isArray(markersMap)) {
    for (const markerEntry of markersMap) {
      const chaptersList = markerEntry.value?.chapters;
      if (Array.isArray(chaptersList) && chaptersList.length > 1) {
        const parsedChapters: VideoChapter[] = [];
        for (const chapterItem of chaptersList) {
          const renderer = chapterItem.chapterRenderer;
          if (!renderer) continue;
          const title =
            renderer.title?.simpleText ||
            renderer.title?.runs?.map((run) => run.text).join("") ||
            "Chapter";
          const startSeconds = Math.max(0, Math.floor((renderer.timeRangeStartMillis ?? 0) / 1000));
          parsedChapters.push({
            title: title.trim(),
            startSeconds,
          });
        }
        if (parsedChapters.length > 1) {
          return computeChapterDurations(parsedChapters, totalDurationSeconds);
        }
      }
    }
  }

  const description = responseRecord.videoDetails?.shortDescription;
  if (description) {
    const chaptersFromDescription = extractChaptersFromDescription(description, totalDurationSeconds);
    if (chaptersFromDescription.length > 1) {
      return chaptersFromDescription;
    }
  }

  return [];
}

export function extractChaptersFromDescription(
  descriptionText: string,
  totalDurationSeconds: number
): VideoChapter[] {
  if (!descriptionText) return [];

  const timestampRegex = /(?:^|\n)\s*(\d{1,2}:(?:\d{2}:)?\d{2})\s+([^\n\r]+)/g;
  const parsedChapters: VideoChapter[] = [];
  let match: RegExpExecArray | null;

  while ((match = timestampRegex.exec(descriptionText)) !== null) {
    const timestampString = match[1];
    const rawTitle = match[2].trim().replace(/^[-–—:]\s*/, "");
    if (!rawTitle) continue;

    const startSeconds = parseTimestampToSeconds(timestampString);
    parsedChapters.push({
      title: rawTitle,
      startSeconds,
    });
  }

  if (parsedChapters.length < 2) {
    return [];
  }

  parsedChapters.sort((firstChapter, secondChapter) => firstChapter.startSeconds - secondChapter.startSeconds);

  return computeChapterDurations(parsedChapters, totalDurationSeconds);
}

function computeChapterDurations(
  chapters: VideoChapter[],
  totalDurationSeconds: number
): VideoChapter[] {
  return chapters.map((currentChapter, chapterIndex) => {
    const nextChapter = chapters[chapterIndex + 1];
    let durationSeconds: number | undefined;

    if (nextChapter) {
      durationSeconds = Math.max(0, nextChapter.startSeconds - currentChapter.startSeconds);
    } else if (totalDurationSeconds > currentChapter.startSeconds) {
      durationSeconds = Math.max(0, totalDurationSeconds - currentChapter.startSeconds);
    }

    return {
      ...currentChapter,
      durationSeconds,
    };
  });
}
