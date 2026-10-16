import { loadStagedClozeCards, type StagedClozeCard } from "../utils/storage";
import { registerBridgeListener } from "../utils/webmcpBridge";

const CLOZEMASTER_HARVEST_STORAGE_KEY = "clozemaster_staged_harvest";

interface StagedClozeCollection {
  collectionName: string;
  timestamp: number;
  cards: Array<{
    sentence: string;
    targetWord: string;
    translation: string;
    hint?: string;
    notes?: string;
    language?: string | null;
  }>;
  tsvContent: string;
}

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
  if (cards.length === 0) return;

  try {
    let stagedCollections: StagedClozeCollection[] = [];
    const rawStaged = window.localStorage.getItem(CLOZEMASTER_HARVEST_STORAGE_KEY);
    if (rawStaged) {
      stagedCollections = JSON.parse(rawStaged) as StagedClozeCollection[];
    }

    const collectionName = "YouTube Immersion";
    const existingIndex = stagedCollections.findIndex(
      (collection) => collection.collectionName === collectionName
    );

    const formattedCards = cards.map((card) => ({
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
    });

    const initialCards = await loadStagedClozeCards();
    syncCardsToClozemasterLocalStorage(initialCards);

    browser.runtime.onMessage.addListener((runtimeMessage, _sender, sendResponse) => {
      if (runtimeMessage.action === "new-cloze-card" && runtimeMessage.card) {
        void loadStagedClozeCards().then((updatedCards) => {
          syncCardsToClozemasterLocalStorage(updatedCards);
          sendResponse({ success: true, count: updatedCards.length });
        });
        return true;
      }
    });
  },
});
