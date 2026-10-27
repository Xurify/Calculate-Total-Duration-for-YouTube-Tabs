import { VideoData } from "../../utils/storage";
import { formatPlaybackRate } from "../../utils/playbackRate";
import { formatTime } from "../../utils/format";
import { app } from "./state";
import { updateSelectionUI } from "./selection";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { selectedTabIds } from "./state";
import { fetchTabs } from "./tabs";
import { showToast } from "./toast";
import { escapeHtml } from "./util";
import { filterVideosForDisplay } from "./view-filter";

export function openStudySessionModal(targetTabIds?: number[]): void {
  const modal = document.getElementById("study-session-modal");
  if (!modal) return;

  let queueTabIds: number[] = [];
  if (targetTabIds && targetTabIds.length > 0) {
    queueTabIds = targetTabIds;
  } else if (selectedTabIds.size > 0) {
    queueTabIds = Array.from(selectedTabIds);
  } else {
    let baseVideos: VideoData[] = [];
    if (app.currentWindowId === "all") {
      baseVideos = app.allVideos;
    } else {
      const group = app.windowGroups.find((windowGroup) => windowGroup.id === app.currentWindowId);
      if (group) baseVideos = group.tabs;
    }
    const visibleVideos = filterVideosForDisplay(baseVideos);
    queueTabIds = visibleVideos.map((video) => video.id);
  }

  if (queueTabIds.length === 0) {
    showToast("There are no YouTube tabs to study. Open a few videos first.");
    return;
  }

  const previewContainer = document.getElementById("study-queue-preview");
  const countBadge = document.getElementById("study-queue-count");
  if (countBadge) countBadge.textContent = `${queueTabIds.length} ${queueTabIds.length === 1 ? "video" : "videos"}`;

  if (previewContainer) {
    const queueVideos = queueTabIds
      .map((tabId) => app.allVideos.find((video) => video.id === tabId))
      .filter((video): video is VideoData => Boolean(video));

    if (queueVideos.length === 0) {
      previewContainer.innerHTML = `<li class="p-2 text-text-muted text-center">These tabs were closed. Pick other videos and try again.</li>`;
    } else {
      previewContainer.innerHTML = queueVideos
        .map(
          (video, index) => `
          <li class="flex items-center gap-2 p-1.5 rounded bg-surface-elevated/50 border border-border/40 text-xs text-text-primary" data-queue-tab-id="${video.id}">
            <span class="w-4 text-center tabular-nums text-[10px] text-text-muted shrink-0" aria-hidden="true">${index + 1}</span>
            <span class="truncate flex-1 font-medium" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</span>
            <span class="text-[10px] tabular-nums text-text-muted shrink-0 px-1.5 py-0.5 rounded bg-surface border border-border">${formatTime(video.seconds)}</span>
          </li>
        `
        )
        .join("");
    }
  }

  updateSpeedSelectorUI(app.selectedPlaybackSpeed);

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeStudySessionModal(): void {
  const modal = document.getElementById("study-session-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function updateSpeedSelectorUI(speed: number): void {
  app.selectedPlaybackSpeed = speed;
  const speedButtons = document.querySelectorAll(".study-speed-btn");
  speedButtons.forEach((button) => {
    const buttonSpeed = parseFloat(button.getAttribute("data-speed") || "1");
    const active = Math.abs(buttonSpeed - speed) < 0.01;
    button.setAttribute("aria-pressed", String(active));
    if (active) {
      button.classList.add("text-accent", "bg-surface-hover");
      button.classList.remove("text-text-muted");
    } else {
      button.classList.remove("text-accent", "bg-surface-hover");
      button.classList.add("text-text-muted");
    }
  });
}

async function handleLaunchStudyQueue(): Promise<void> {
  const previewElements = document.querySelectorAll("#study-queue-preview [data-queue-tab-id]");
  const orderedTabIds = Array.from(previewElements)
    .map((element) => parseInt(element.getAttribute("data-queue-tab-id") || "", 10))
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0);

  if (orderedTabIds.length === 0) {
    showToast("The queue is empty. Pick at least one video.");
    return;
  }

  const stashCheckbox = document.getElementById("study-stash-distractions") as HTMLInputElement | null;
  const stashDistractionTabs = stashCheckbox?.checked ?? false;
  const sessionNameInput = document.getElementById("study-session-name-input") as HTMLInputElement | null;
  const sessionName = sessionNameInput?.value.trim() || "Put away for later";

  try {
    const response = await browser.runtime.sendMessage({
      action: "stage-focused-study-queue",
      payload: {
        orderedTabIds,
        stashDistractionTabs,
        sessionName,
        playbackSpeed: app.selectedPlaybackSpeed,
      },
    });

    if (response?.success) {
      closeStudySessionModal();
      selectedTabIds.clear();
      updateSelectionUI();
      showToast(
        stashDistractionTabs && response.stashedCount > 0
          ? `Session started. ${response.stashedCount} other ${response.stashedCount === 1 ? "tab was" : "tabs were"} saved to "${sessionName}" and closed.`
          : `Session started at ${formatPlaybackRate(app.selectedPlaybackSpeed)}.`
      );
      await fetchTabs();
      await refreshSavedSessionsSidebar();
    } else {
      showToast(response?.errorMessage || "The session could not start. Check that the tabs are still open and try again.");
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The session could not start. Try again.");
  }
}

export function wireStudyModal() {
  document.getElementById("study-modal-close")?.addEventListener("click", closeStudySessionModal);
  document.getElementById("study-modal-cancel")?.addEventListener("click", closeStudySessionModal);

  document.getElementById("study-modal-submit")?.addEventListener("click", () => {
    void handleLaunchStudyQueue();
  });

  document.getElementById("study-session-modal")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id === "study-session-modal") {
      closeStudySessionModal();
    }
  });

  document.querySelectorAll(".study-speed-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const speed = parseFloat(button.getAttribute("data-speed") || "1");
      if (!isNaN(speed)) {
        updateSpeedSelectorUI(speed);
      }
    });
  });

  const stashCheckbox = document.getElementById("study-stash-distractions") as HTMLInputElement | null;
  const sessionNameWrap = document.getElementById("study-session-name-wrap");
  stashCheckbox?.addEventListener("change", () => {
    if (sessionNameWrap) {
      sessionNameWrap.classList.toggle("hidden", !stashCheckbox.checked);
    }
  });
}
