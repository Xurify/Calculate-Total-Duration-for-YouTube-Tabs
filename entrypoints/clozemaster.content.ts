import { loadStagedClozeCards, type StagedClozeCard } from "../utils/storage";
import { registerBridgeListener } from "../utils/webmcpBridge";
import { requestFromPage } from "../utils/pageService";

const CLOZEMASTER_HARVEST_STORAGE_KEY = "clozemaster_staged_harvest";

interface StagedClozeCollection {
  collectionName: string;
  timestamp: number;
  cards: Array<{
    id: string;
    sentence: string;
    targetWord: string;
    translation: string;
    hint?: string;
    notes?: string;
    language?: string | null;
  }>;
  tsvContent: string;
}

const HARVEST_COLLECTION_NAME = "YouTube Immersion";

function convertCardsToTsv(cards: StagedClozeCard[]): string {
  const lines = cards
    .filter((card) => Boolean(card && card.sentence && card.targetWord))
    .map((card) => {
      const sanitizedSentence = (card.sentence || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedTranslation = (card.translation || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedTargetWord = (card.targetWord || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedHint = (card.hint || "").replace(/\r?\n|\r|\t/g, " ").trim();
      return `${sanitizedSentence}\t${sanitizedTranslation}\t${sanitizedTargetWord}\t${sanitizedHint}`;
    });

  return lines.join("\n");
}

function syncCardsToClozemasterLocalStorage(cards: StagedClozeCard[]): void {
  try {
    let stagedCollections: StagedClozeCollection[] = [];
    const rawStaged = window.localStorage.getItem(CLOZEMASTER_HARVEST_STORAGE_KEY);
    if (rawStaged) {
      stagedCollections = JSON.parse(rawStaged) as StagedClozeCollection[];
    }

    const collectionName = HARVEST_COLLECTION_NAME;
    const existingIndex = stagedCollections.findIndex(
      (collection) => collection.collectionName === collectionName
    );

    if (cards.length === 0) {
      if (existingIndex < 0) return;
      stagedCollections.splice(existingIndex, 1);
      if (stagedCollections.length === 0) {
        window.localStorage.removeItem(CLOZEMASTER_HARVEST_STORAGE_KEY);
      } else {
        window.localStorage.setItem(CLOZEMASTER_HARVEST_STORAGE_KEY, JSON.stringify(stagedCollections));
      }
      return;
    }

    const formattedCards = cards.map((card) => ({
      id: card.id,
      sentence: card.sentence,
      targetWord: card.targetWord,
      translation: card.translation,
      hint: card.hint,
      notes: card.notes,
      language: card.language,
    }));

    const newCollection: StagedClozeCollection = {
      collectionName,
      timestamp: Date.now(),
      cards: formattedCards,
      tsvContent: convertCardsToTsv(cards),
    };

    if (existingIndex >= 0) {
      stagedCollections[existingIndex] = newCollection;
    } else {
      stagedCollections.unshift(newCollection);
    }

    window.localStorage.setItem(
      CLOZEMASTER_HARVEST_STORAGE_KEY,
      JSON.stringify(stagedCollections)
    );
  } catch (error) {
    console.warn("[Study Harvester] Failed to sync cards to Clozemaster storage:", error);
  }
}

export default defineContentScript({
  matches: ["*://*.clozemaster.com/*"],
  async main() {
    registerBridgeListener({
      "find-clozemaster-collection-urls": () =>
        browser.runtime.sendMessage({ action: "find-clozemaster-collection-urls" }),
      "clear-staged-cloze-cards": (payload) =>
        browser.runtime.sendMessage({
          action: "clear-staged-cloze-cards",
          ids: (payload as { ids?: unknown })?.ids,
        }),
    });

    const initialCards = await loadStagedClozeCards();
    syncCardsToClozemasterLocalStorage(initialCards);

    browser.runtime.onMessage.addListener((runtimeMessage, _sender, sendResponse) => {
      if (runtimeMessage.action === "clozemaster-op") {
        const { op, payload } = runtimeMessage as { op: "list" | "add"; payload?: unknown };
        // Adding many sentences goes one request at a time, so allow a few seconds per card.
        const cardCount = Array.isArray((payload as { cards?: unknown[] })?.cards)
          ? (payload as { cards: unknown[] }).cards.length
          : 0;
        void requestFromPage(`clozemaster:${op}`, payload ?? {}, 15_000 + cardCount * 3_000).then((result) =>
          sendResponse(result ?? { success: false, reason: "not_ready", errorMessage: "The Clozemaster tab didn't answer." })
        );
        return true;
      }
      if (
        (runtimeMessage.action === "new-cloze-card" && runtimeMessage.card) ||
        runtimeMessage.action === "staged-cloze-cards-changed"
      ) {
        void loadStagedClozeCards().then((updatedCards) => {
          syncCardsToClozemasterLocalStorage(updatedCards);
          sendResponse({ success: true, count: updatedCards.length });
        });
        return true;
      }
    });
  },
});
