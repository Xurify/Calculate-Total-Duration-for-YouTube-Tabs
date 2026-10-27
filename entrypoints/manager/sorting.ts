import { VideoData, type SavedSessionTab } from "../../utils/storage";
import { app } from "./state";

function sortVideos(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => {
    switch (app.sortOption) {
      case 'index-asc': return a.index - b.index;
      case 'started-first': {
        const started = (video: VideoData) => (!video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds ? 1 : 0);
        return started(b) - started(a) || a.index - b.index;
      }
      case 'duration-desc': return b.seconds - a.seconds;
      case 'duration-asc': return a.seconds - b.seconds;
      case 'title-asc': return a.title.localeCompare(b.title);
      case 'channel-asc': return a.channelName.localeCompare(b.channelName);
      default: return 0;
    }
  });
}

export function videoGroupKey(video: VideoData): string {
  if (app.groupingMode === "channel") return video.channelName || "Unknown Channel";
  if (app.groupingMode === "language") {
    const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
    return stripped ? stripped : video.language ? video.language.toUpperCase() : "Unspecified";
  }
  return "";
}

export function sessionTabGroupKey(tab: SavedSessionTab): string {
  if (app.groupingMode === "channel") return tab.channelName ?? "Unknown Channel";
  if (app.groupingMode === "language") {
    const stripped = tab.languageName ? tab.languageName.split("(")[0].trim() : "";
    return stripped ? stripped : tab.language ? tab.language.toUpperCase() : "Unspecified";
  }
  return "";
}

export function sortVideosForDisplay(videos: VideoData[]): VideoData[] {
  return sortVideos(videos);
}

export function sortSessionTabsForDisplay(tabs: SavedSessionTab[]): SavedSessionTab[] {
  if (app.sortOption === "index-asc") return tabs;
  return sortSessionTabs(tabs);
}

export function orderLiveGroupEntries(groups: [string, VideoData[]][]): [string, VideoData[]][] {
  const entries = [...groups];
  if (app.sortOption === "channel-asc" || app.sortOption === "title-asc") {
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (app.sortOption === "duration-desc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      const durationB = b[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      return durationB - durationA;
    });
  }
  if (app.sortOption === "duration-asc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      const durationB = b[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      return durationA - durationB;
    });
  }
  return entries;
}

export function orderSessionGroupEntries(groups: [string, SavedSessionTab[]][]): [string, SavedSessionTab[]][] {
  const entries = [...groups];
  if (app.sortOption === "channel-asc" || app.sortOption === "title-asc") {
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (app.sortOption === "duration-desc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationB - durationA;
    });
  }
  if (app.sortOption === "duration-asc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationA - durationB;
    });
  }
  return entries;
}

function sortSessionTabs(tabs: SavedSessionTab[]): SavedSessionTab[] {
  return [...tabs].sort((a, b) => {
    const titleA = a.title ?? "";
    const titleB = b.title ?? "";
    const channelA = a.channelName ?? "";
    const channelB = b.channelName ?? "";
    const secA = a.seconds ?? 0;
    const secB = b.seconds ?? 0;
    switch (app.sortOption) {
      case "duration-desc": return secB - secA;
      case "duration-asc": return secA - secB;
      case "title-asc": return titleA.localeCompare(titleB);
      case "channel-asc": return channelA.localeCompare(channelB);
      case "index-asc": return 0;
      default: return secB - secA;
    }
  });
}
