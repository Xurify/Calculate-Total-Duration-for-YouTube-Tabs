import "./style.css";
import { initTheme } from "../../utils/theme";
import { isStoreUpdatedMessage } from "../../utils/store";
import { closeAllCustomSelects } from "../manager/custom-select";
import { installDialogs, installTooltips } from "../../utils/controls";
import { loadChannelAvatars } from "../../utils/channelAvatars";
import { popup } from "./state";
import { loadReadingCount } from "./header";
import { loadLanguageToday } from "./languages";
import { livePlaybackTick, startLiveTick, stopLiveTick } from "./live-tick";
import { flushProbeRender, scheduleProbeRender } from "./render";
import { getYouTubeTabs } from "./tabs";
import { updateVideoListCardsFromState } from "./video-list";
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
  installDialogs();
  // A stale avatar URL just hides; the channel name is still there.
  document.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLImageElement && event.target.classList.contains("meta-avatar")) event.target.style.display = "none";
    },
    true
  );
  document.addEventListener("click", closeAllCustomSelects);
  void getYouTubeTabs();
  loadReadingCount();
  loadLanguageToday();
  void loadChannelAvatars()
    .then((avatars) => {
      popup.popupChannelAvatars = avatars;
      updateVideoListCardsFromState();
    })
    .catch(() => {});
});
window.addEventListener("pagehide", stopLiveTick);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopLiveTick();
  } else if (popup.currentView === "dashboard" && document.getElementById("stat-remaining")) {
    startLiveTick();
    void livePlaybackTick();
  }
});
