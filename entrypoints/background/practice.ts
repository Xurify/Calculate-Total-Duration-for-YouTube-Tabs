import {
  loadStagedClozeCards,
  clearStagedClozeCards,
  removeStagedClozeCards,
  type StagedClozeCard,
} from "../../utils/storage";
import { getVideoIdFromUrl } from "../../utils/format";
import { buildApprovalRequest, isExtensionPageSender, requestApproval } from "../../utils/approvals";
import { languageLabelOf } from "../../utils/watchLog";
import { languageOverrideFor, loadLanguageOverrides, type LanguageOverrides } from "../../utils/languageOverrides";
import { addToBank, loadSentenceBank, saveSentenceBank, type NewBankSentence } from "../../utils/sentenceBank";
import { broadcastToClozemasterTabs } from "./clozemaster";

let practiceQueue: Promise<unknown> = Promise.resolve();

export function withPracticeStore<T>(work: () => Promise<T>): Promise<T> {
  const run = practiceQueue.then(work);
  practiceQueue = run.catch((error) => console.warn("[Study Harvester] practice:", error));
  return run;
}

export function videoLanguageLabel(overrides: LanguageOverrides, videoId: string, channelName: string, code: unknown, name: unknown): string {
  const override = languageOverrideFor(overrides, videoId, channelName);
  if (override) return override.name;
  return languageLabelOf(typeof name === "string" ? name : null, typeof code === "string" ? code : null);
}

function cleanNewSentence(raw: unknown, language: string, code: unknown): NewBankSentence | null {
  const sentence = raw as Partial<NewBankSentence> | null;
  if (!sentence || typeof sentence.text !== "string" || !sentence.text.trim() || typeof sentence.videoId !== "string") return null;
  if (typeof sentence.startSeconds !== "number" || typeof sentence.endSeconds !== "number" || sentence.endSeconds <= sentence.startSeconds) return null;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  return {
    text: text(sentence.text, 1000),
    clozeWord: text(sentence.clozeWord, 100) || null,
    translation: text(sentence.translation, 500),
    language,
    languageCode: typeof code === "string" && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(code) ? code : null,
    videoId: sentence.videoId,
    videoTitle: text(sentence.videoTitle, 300),
    channelName: text(sentence.channelName, 200),
    startSeconds: sentence.startSeconds,
    endSeconds: sentence.endSeconds,
    source: sentence.source === "cloze" ? "cloze" : "listening",
  };
}

export async function addSentenceToBank(raw: unknown, code: unknown, name: unknown): Promise<boolean> {
  const overrides = await loadLanguageOverrides();
  const partial = raw as Partial<NewBankSentence> | null;
  const language = videoLanguageLabel(overrides, String(partial?.videoId ?? ""), String(partial?.channelName ?? ""), code, name);
  const sentence = cleanNewSentence(raw, language, code);
  if (!sentence) return false;
  return withPracticeStore(async () => {
    const result = addToBank(await loadSentenceBank(), sentence);
    await saveSentenceBank(result.bank);
    return result.added;
  });
}

const CLIP_MESSAGE_ATTEMPTS = 30;
const CLIP_RETRY_MS = 500;
let clipWindowId: number | null = null;

async function sendClipToTab(tabId: number, clip: { videoId: string; startSeconds: number; endSeconds: number }): Promise<{ success: boolean; errorMessage?: string }> {
  let last: { success: boolean; errorMessage?: string } = { success: false, errorMessage: "YouTube did not answer." };
  for (let attempt = 0; attempt < CLIP_MESSAGE_ATTEMPTS; attempt++) {
    try {
      const response = (await browser.tabs.sendMessage(tabId, { action: "play-clip", ...clip })) as { success: boolean; errorMessage?: string } | undefined;
      if (response?.success) return response;
      if (response) last = response;
      // A tab still on its previous video answers "another video" until the new page takes over.
      if (response && response.errorMessage !== "This tab shows another video.") return response;
    } catch {
      // The content script is not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, CLIP_RETRY_MS));
  }
  return last;
}

/**
 * Plays a saved sentence with the speaker's own voice. A tab that already shows the video is used; otherwise a
 * small player window, kept for the next clip. Chrome does not load media in a tab that has never been shown,
 * so a hidden background tab would stay silent.
 */
export async function playClip(clip: { videoId: string; startSeconds: number; endSeconds: number }): Promise<{ success: boolean; errorMessage?: string }> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(clip.videoId)}&t=${Math.floor(clip.startSeconds)}s`;
  const open = await browser.tabs.query({ url: ["*://*.youtube.com/watch*"] });
  const showing = open.find((tab) => tab.id !== undefined && !tab.discarded && tab.windowId !== clipWindowId && getVideoIdFromUrl(tab.url ?? "") === clip.videoId);
  if (showing?.id !== undefined) {
    const result = await sendClipToTab(showing.id, clip);
    if (result.success) return result;
  }
  let tabId: number | undefined;
  if (clipWindowId !== null) {
    try {
      const window = await browser.windows.get(clipWindowId, { populate: true });
      const tab = window.tabs?.[0];
      if (tab?.id !== undefined) {
        tabId = tab.id;
        if (getVideoIdFromUrl(tab.url ?? "") !== clip.videoId) await browser.tabs.update(tab.id, { url });
      }
    } catch {
      clipWindowId = null;
    }
  }
  if (tabId === undefined) {
    const window = await browser.windows.create({ url, type: "popup", width: 560, height: 360, focused: false });
    clipWindowId = window?.id ?? null;
    tabId = window?.tabs?.[0]?.id;
  }
  if (tabId === undefined) return { success: false, errorMessage: "Could not open a YouTube player." };
  return sendClipToTab(tabId, clip);
}

export async function clearStagedCards(rawIds: unknown, sender: Browser.runtime.MessageSender) {
  if (rawIds !== undefined && rawIds !== null) {
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
      throw new Error("ids must be an array of card ids from the captured cards.");
    }
  }
  const requestedIds = Array.isArray(rawIds) ? new Set(rawIds as string[]) : null;
  const stagedCards = await loadStagedClozeCards();
  const targetCards = requestedIds ? stagedCards.filter((card) => requestedIds.has(card.id)) : stagedCards;
  if (targetCards.length === 0) {
    return { success: true, removedCount: 0, remainingCount: stagedCards.length };
  }

  if (!isExtensionPageSender(sender)) {
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Remove ${targetCards.length} captured ${targetCards.length === 1 ? "sentence" : "sentences"}?`,
        summary:
          "This page wants to remove these sentences from the queue you captured with the Cloze button. Do this once they are in Clozemaster; they cannot be brought back.",
        items: targetCards.map((card) => card.sentence),
        confirmLabel: "Remove sentences",
        destructive: true,
      })
    );
    if (!approved) throw new Error("The user declined to remove the captured sentences.");
  }

  let remainingCards: StagedClozeCard[] = [];
  if (requestedIds) {
    remainingCards = await removeStagedClozeCards(targetCards.map((card) => card.id));
  } else {
    await clearStagedClozeCards();
  }
  void broadcastToClozemasterTabs({ action: "staged-cloze-cards-changed" });
  return { success: true, removedCount: targetCards.length, remainingCount: remainingCards.length };
}
