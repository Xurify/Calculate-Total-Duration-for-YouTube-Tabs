import "./style.css";
import { initTheme } from "../../utils/theme";
import { isStoreUpdatedMessage } from "../../utils/store";
import { closeAllCustomSelects } from "../manager/custom-select";
import { installTooltips } from "../../utils/controls";
import { popup } from "./state";
import { loadLanguageToday } from "./languages";
import { livePlaybackTick, startLiveTick, stopLiveTick } from "./live-tick";
import { flushProbeRender, refreshQueueStatsFromState, scheduleProbeRender } from "./render";
import { getYouTubeTabs } from "./tabs";
import { applyProbedMetadataToVideo, handleStoreUpdated } from "./videos";

initTheme();

// Global listener for background cache updates (content script + auto sync for suspended tabs)
browser.runtime.onMessage.addListener((message) => {
  if (isStoreUpdatedMessage(message)) {
    handleStoreUpdated(message);
    return;
  }
  if (message.action === "tab-synced") {
    const video = popup.videoData.find((v) => v.id === message.tabId);
    if (video) {
      applyProbedMetadataToVideo(video, {
        title: message.metadata.title,
        channelName: message.metadata.channelName,
        seconds: message.metadata.seconds,
        isLive: message.metadata.isLive || false,
      });
      video.suspended = false;
      scheduleProbeRender();
    }
  }
  if (message.action === "sync-complete") {
    flushProbeRender();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  installTooltips();
  document.addEventListener("click", closeAllCustomSelects);
  void getYouTubeTabs();
  void loadLanguageToday().then(refreshQueueStatsFromState);
});
window.addEventListener("pagehide", stopLiveTick);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopLiveTick();
  } else if (document.getElementById("stat-remaining")) {
    startLiveTick();
    void livePlaybackTick();
  }
});
