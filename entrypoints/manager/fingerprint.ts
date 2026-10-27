import { VideoData, type SavedSessionTab, type SavedSession } from "../../utils/storage";
import { app } from "./state";
import { nestedChannelCollapseKey } from "./section-render";
import {
  orderedSections,
  partitionLiveVideosBySection,
  partitionSessionTabsBySection,
  SECTION_COLLAPSE_PREFIX,
  UNSORTED_COLLAPSE_KEY,
  usesSectionLayoutForLive,
  usesSectionLayoutForSession,
} from "./sections";
import {
  orderLiveGroupEntries,
  orderSessionGroupEntries,
  sessionTabGroupKey,
  sortSessionTabsForDisplay,
  sortVideosForDisplay,
  videoGroupKey,
} from "./sorting";
import { collapsedGroups, selectedSessionTabUrls, selectedTabIds } from "./state";
import { filterSessionTabsForDisplay, filterVideosForDisplay, liveVideoStructurePart } from "./view-filter";

function fingerprintSessionTabsInner(tabs: SavedSessionTab[], collapseScopeId: string): string {
  if (tabs.length === 0) return "";
  if (app.groupingMode === "channel" || app.groupingMode === "language") {
    const groups = new Map<string, SavedSessionTab[]>();
    tabs.forEach((tab) => {
      const name = sessionTabGroupKey(tab);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(tab);
    });
    return orderSessionGroupEntries(Array.from(groups.entries()))
      .map(([groupName, tabList]) => {
        const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
        const collapsed = collapsedGroups.has(ck);
        const sortedTabs = sortSessionTabsForDisplay(tabList);
        const sig = sortedTabs
          .map((tab) => `${tab.url}|${tab.sectionId ?? ""}|${sessionTabGroupKey(tab)}`)
          .join(";");
        return `${ck}:${collapsed}:${sig}`;
      })
      .join("||");
  }
  return sortSessionTabsForDisplay(tabs)
    .map((tab) => `${tab.url}|${tab.sectionId ?? ""}`)
    .join(";");
}

function fingerprintLiveVideosInner(videos: VideoData[], collapseScopeId: string): string {
  if (videos.length === 0) return "";
  if (app.groupingMode === "channel" || app.groupingMode === "language") {
    const groups = new Map<string, VideoData[]>();
    videos.forEach((video) => {
      const name = videoGroupKey(video);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(video);
    });
    return orderLiveGroupEntries(Array.from(groups.entries()))
      .map(([groupName, groupVideos]) => {
        const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
        const collapsed = collapsedGroups.has(ck);
        const sortedGroupVideos = sortVideosForDisplay(groupVideos);
        const allSelected = groupVideos.every((video) => selectedTabIds.has(video.id));
        const someSelected = !allSelected && groupVideos.some((video) => selectedTabIds.has(video.id));
        const vidSig = sortedGroupVideos.map((video) => liveVideoStructurePart(video)).join(";");
        return `${ck}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
      })
      .join("||");
  }
  return sortVideosForDisplay(videos)
    .map((video) => liveVideoStructurePart(video))
    .join(";");
}

function sessionSectionsFingerprintSig(session: SavedSession): string {
  return orderedSections(session.sections)
    .map((s) => `${s.id}:${s.name}:${s.order}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`)
    .join("|");
}

function liveAssignmentsFingerprintSig(): string {
  const entries = Object.entries(app.liveTabSectionsState.assignments).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([url, sid]) => `${url}→${sid}`).join(";");
}

export function tabListStructureFingerprint(): string {
  if (app.selectedSession) {
    const session = app.selectedSession;
    const tabsToShow = filterSessionTabsForDisplay(session.tabs ?? []);
    const state = [
      "session",
      session.id,
      session.name,
      String(tabsToShow.length),
      app.searchQuery,
      String(app.showDuplicatesOnly),
      app.groupingMode,
      app.layoutMode,
      app.sortOption,
      app.thumbnailQuality,
      [...collapsedGroups].sort().join(","),
      [...selectedSessionTabUrls].sort().join("|"),
      sessionSectionsFingerprintSig(session),
    ].join("\x1f");
    if (tabsToShow.length === 0 && !usesSectionLayoutForSession(session)) return `${state}\x1fempty`;
    if (usesSectionLayoutForSession(session)) {
      const secs = orderedSections(session.sections);
      const { blocks, unsorted } = partitionSessionTabsBySection(tabsToShow, secs);
      const parts: string[] = [];
      for (const { section, tabs } of blocks) {
        const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
        const collapsed = collapsedGroups.has(ck);
        parts.push(`${section.id}:${collapsed}:${fingerprintSessionTabsInner(tabs, section.id)}`);
      }
      const uCollapsed = collapsedGroups.has(UNSORTED_COLLAPSE_KEY);
      parts.push(`__unsorted:${uCollapsed}:${fingerprintSessionTabsInner(unsorted, "__unsorted")}`);
      return `${state}\x1fseclay:${app.layoutMode}:${parts.join("§")}`;
    }
    if (app.groupingMode === "channel" || app.groupingMode === "language") {
      const groups = new Map<string, SavedSessionTab[]>();
      tabsToShow.forEach((tab) => {
        const name = sessionTabGroupKey(tab);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(tab);
      });
      const groupSig = orderSessionGroupEntries(Array.from(groups.entries()))
        .map(([groupName, tabList]) => {
          const collapsed = collapsedGroups.has(groupName);
          const sortedTabs = sortSessionTabsForDisplay(tabList);
          const sig = sortedTabs
            .map((tab) => `${tab.url}|${tab.sectionId ?? ""}|${sessionTabGroupKey(tab)}`)
            .join(";");
          return `${groupName}:${collapsed}:${sig}`;
        })
        .join("||");
      return `${state}\x1fcg:${groupSig}`;
    }
    const sorted = sortSessionTabsForDisplay(tabsToShow);
    const vidSig = sorted.map((tab) => `${tab.url}|${tab.sectionId ?? ""}`).join(";");
    return `${state}\x1fflat:${vidSig}`;
  }

  let baseVideos: VideoData[] = [];
  if (app.currentWindowId === "all") {
    baseVideos = app.allVideos;
  } else {
    const group = app.windowGroups.find((windowGroup) => windowGroup.id === app.currentWindowId);
    baseVideos = group ? group.tabs : [];
  }
  const videosToShow = filterVideosForDisplay(baseVideos);
  const state = [
    "live",
    String(app.currentWindowId),
    app.searchQuery,
    String(app.showDuplicatesOnly),
    app.groupingMode,
    app.layoutMode,
    app.sortOption,
    app.thumbnailQuality,
    [...collapsedGroups].sort().join(","),
    [...selectedTabIds].sort((a, b) => a - b).join(","),
    orderedSections(app.liveTabSectionsState.sections)
      .map((s) => `${s.id}:${s.name}:${s.order}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`)
      .join("|"),
    liveAssignmentsFingerprintSig(),
    // Row offsets ("+21 min") and the plan badges come from durations, which arrive after the first render.
    videosToShow.map((video) => Math.round(video.seconds / 60)).join(","),
  ].join("\x1f");
  if (videosToShow.length === 0 && !usesSectionLayoutForLive()) return `${state}\x1fempty`;
  if (usesSectionLayoutForLive()) {
    const secs = orderedSections(app.liveTabSectionsState.sections);
    const { blocks, unsorted } = partitionLiveVideosBySection(
      videosToShow,
      secs,
      app.liveTabSectionsState.assignments
    );
    const parts: string[] = [];
    for (const { section, videos } of blocks) {
      const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
      const collapsed = collapsedGroups.has(ck);
      parts.push(`${section.id}:${collapsed}:${fingerprintLiveVideosInner(videos, section.id)}`);
    }
    const uCollapsed = collapsedGroups.has(UNSORTED_COLLAPSE_KEY);
    parts.push(`__unsorted:${uCollapsed}:${fingerprintLiveVideosInner(unsorted, "__unsorted")}`);
    return `${state}\x1flivesec:${app.layoutMode}:${parts.join("§")}`;
  }
  if (app.groupingMode === "none") {
    const sortedVideos = sortVideosForDisplay(videosToShow);
    const vidSig = sortedVideos.map((video) => liveVideoStructurePart(video)).join(";");
    return `${state}\x1fnone:${app.layoutMode}:${vidSig}`;
  }
  const groups = new Map<string, VideoData[]>();
  videosToShow.forEach((video) => {
    const name = videoGroupKey(video);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(video);
  });
  const groupSig = orderLiveGroupEntries(Array.from(groups.entries()))
    .map(([groupName, videos]) => {
      const collapsed = collapsedGroups.has(groupName);
      const sortedGroupVideos = sortVideosForDisplay(videos);
      const allSelected = videos.every((video) => selectedTabIds.has(video.id));
      const someSelected = !allSelected && videos.some((video) => selectedTabIds.has(video.id));
      const vidSig = sortedGroupVideos.map((video) => liveVideoStructurePart(video)).join(";");
      return `${groupName}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
    })
    .join("||");
  return `${state}\x1fgrp:${app.layoutMode}:${groupSig}`;
}
