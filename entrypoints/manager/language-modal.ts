import { getVideoIdFromUrl } from "../../utils/format";
import { englishLanguageName, languageCodeOf, languageFlagHtml } from "../../utils/languageFlags";
import { languageOverrideFor, saveLanguageOverrides, type LanguageOverride } from "../../utils/languageOverrides";
import { cardLanguageLabel } from "./cards";
import { app } from "./state";
import { render } from "./render";
import { showToast } from "./toast";
import { escapeHtml } from "./util";

// ───────────────────────── Language override modal ─────────────────────────

interface LanguageModalTarget {
  videoId: string | null;
  channelName: string;
  title: string;
  /** What the card shows now, so the dialog opens on it. */
  currentLabel: string;
}

let languageModalTarget: LanguageModalTarget | null = null;
let focusBeforeModal: HTMLElement | null = null;

function knownLanguagesForPicker(): { name: string; code: string | null }[] {
  const seen = new Map<string, string | null>();
  const add = (name: string | null | undefined, code: string | null | undefined) => {
    const stripped = name ? name.split("(")[0].trim() : "";
    const label = englishLanguageName(code) ?? englishLanguageName(stripped) ?? stripped;
    if (!label) return;
    if (!seen.has(label)) seen.set(label, code ?? null);
  };
  for (const video of app.allVideos) add(video.languageName, video.language);
  for (const session of [app.selectedSession]) for (const tab of session?.tabs ?? []) add(tab.languageName, tab.language);
  for (const override of Object.values(app.languageOverrides.videos)) add(override.name, override.code);
  for (const override of Object.values(app.languageOverrides.channels)) add(override.name, override.code);
  for (const key of app.focusLanguages) add(key, key);
  return Array.from(seen.entries())
    .map(([name, code]) => ({ name, code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function openLanguageModal(target: LanguageModalTarget): void {
  const modal = document.getElementById("language-modal");
  const list = document.getElementById("language-options");
  const titleEl = document.getElementById("language-modal-title");
  const channelLabel = document.getElementById("language-channel-label");
  const channelToggle = document.getElementById("language-apply-channel") as HTMLInputElement | null;
  const custom = document.getElementById("language-custom") as HTMLInputElement | null;
  if (!modal || !list || !titleEl) return;
  languageModalTarget = target;
  focusBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  titleEl.textContent = target.title;
  const current = languageOverrideFor(app.languageOverrides, target.videoId, target.channelName);
  const shown = englishLanguageName(target.currentLabel) ?? target.currentLabel;
  const options = knownLanguagesForPicker();
  list.innerHTML = options
    .map((option) => `
      <label class="language-option">
        <input type="radio" class="ui-radio" name="language-choice" value="${escapeHtml(option.name)}" data-code="${escapeHtml(option.code ?? "")}" ${option.name === shown || (current?.code != null && current.code === option.code) ? "checked" : ""} />
        ${languageFlagHtml(option.code || option.name)}
        <span>${escapeHtml(option.name)}</span>
        ${option.code ? `<span class="text-xs text-text-muted uppercase">${escapeHtml(option.code)}</span>` : ""}
      </label>`)
    .join("");
  if (custom) custom.value = "";
  if (channelLabel) channelLabel.textContent = target.channelName ? `Use this for every video from ${target.channelName}` : "Use this for the whole channel";
  if (channelToggle) {
    channelToggle.checked = Boolean(target.channelName) && Boolean(app.languageOverrides.channels[target.channelName]) && !target.videoId;
    channelToggle.disabled = !target.channelName;
  }
  document.getElementById("language-reset")?.classList.toggle("hidden", current == null);
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  // Arrow keys then move between languages and Enter saves.
  (list.querySelector<HTMLInputElement>('input[name="language-choice"]:checked') ?? custom ?? modal).focus();
}

function closeLanguageModal(): void {
  const modal = document.getElementById("language-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
  languageModalTarget = null;
  if (focusBeforeModal?.isConnected) focusBeforeModal.focus();
  focusBeforeModal = null;
}

async function applyLanguageChoice(choice: LanguageOverride | null): Promise<void> {
  const target = languageModalTarget;
  if (!target) return;
  const channelToggle = document.getElementById("language-apply-channel") as HTMLInputElement | null;
  const wholeChannel = Boolean(channelToggle?.checked) && Boolean(target.channelName);
  if (choice == null) {
    if (target.videoId) delete app.languageOverrides.videos[target.videoId];
    if (wholeChannel || !target.videoId) delete app.languageOverrides.channels[target.channelName];
  } else if (wholeChannel) {
    app.languageOverrides.channels[target.channelName] = choice;
    if (target.videoId) delete app.languageOverrides.videos[target.videoId];
  } else if (target.videoId) {
    app.languageOverrides.videos[target.videoId] = choice;
  }
  await saveLanguageOverrides(app.languageOverrides);
  closeLanguageModal();
  app.lastFacetRailHtml = "";
  app.lastTabListFingerprint = "";
  render();
  showToast(choice ? `Language set to ${choice.name}${wholeChannel ? " for the whole channel" : ""}.` : "Back to detected language.");
}

export function openLanguageModalFor(target: { mode: "session"; url: string } | { mode: "live"; tabId: number }): void {
  if (target.mode === "live") {
    const video = app.allVideos.find((candidate) => candidate.id === target.tabId);
    if (!video) return;
    openLanguageModal({
      videoId: getVideoIdFromUrl(video.url),
      channelName: video.channelName || "",
      title: video.title,
      currentLabel: cardLanguageLabel(video.url, video.channelName, video.languageName),
    });
    return;
  }
  const tab = (app.selectedSession?.tabs ?? []).find((candidate) => candidate.url === target.url);
  if (!tab) return;
  openLanguageModal({
    videoId: getVideoIdFromUrl(tab.url),
    channelName: tab.channelName || "",
    title: tab.title ?? tab.url,
    currentLabel: cardLanguageLabel(tab.url, tab.channelName, tab.languageName),
  });
}

export function wireLanguageModal() {
  document.getElementById("ctx-set-language")?.addEventListener("click", () => {
    const target = app.tabSectionContextTarget;
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    if (target) openLanguageModalFor(target);
  });
  document.getElementById("language-cancel")?.addEventListener("click", closeLanguageModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && languageModalTarget) closeLanguageModal();
  });
  document.getElementById("language-modal")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id === "language-modal") closeLanguageModal();
  });
  document.getElementById("language-reset")?.addEventListener("click", () => {
    void applyLanguageChoice(null);
  });
  const saveLanguageChoice = () => {
    const custom = (document.getElementById("language-custom") as HTMLInputElement | null)?.value.trim() ?? "";
    const picked = document.querySelector<HTMLInputElement>('input[name="language-choice"]:checked');
    let choice: LanguageOverride | null = null;
    if (custom) {
      const looksLikeCode = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(custom);
      const code = languageCodeOf(custom) ?? (looksLikeCode ? custom.toLowerCase() : null);
      const name = englishLanguageName(code) ?? (looksLikeCode ? custom.toUpperCase() : custom.charAt(0).toUpperCase() + custom.slice(1));
      choice = { code, name };
    } else if (picked) {
      choice = { code: picked.dataset.code || null, name: picked.value };
    }
    if (!choice) {
      showToast("Pick a language or type one.");
      return;
    }
    void applyLanguageChoice(choice);
  };
  document.getElementById("language-save")?.addEventListener("click", saveLanguageChoice);
  document.getElementById("language-options")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveLanguageChoice();
  });
  document.getElementById("language-custom")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveLanguageChoice();
    }
  });
}
