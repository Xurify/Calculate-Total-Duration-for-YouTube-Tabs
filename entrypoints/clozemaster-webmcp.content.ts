/**
 * Clozemaster WebMCP Content Script (runs in MAIN world).
 * Exposes spaced-repetition study state and custom cloze card creation to browser AI agents.
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";

interface ClozeCardInput {
  sentence: string;
  targetWord: string;
  translation: string;
  hint?: string;
}

interface StagedClozeCollection {
  collectionName: string;
  timestamp: number;
  cards: ClozeCardInput[];
  tsvContent: string;
}

function detectClozemasterLanguage(): {
  languagePair: string | null;
  targetLanguage: string | null;
} {
  const pathname = window.location.pathname;

  // Pattern: /languages/slv-eng or /l/slv-eng
  const languageMatch = pathname.match(/\/(?:languages|l)\/([a-z]{3})-([a-z]{3})/i);
  if (languageMatch) {
    return {
      languagePair: `${languageMatch[1]}-${languageMatch[2]}`.toLowerCase(),
      targetLanguage: languageMatch[1].toLowerCase(),
    };
  }

  // Check language selector in navigation or breadcrumb
  const currentLanguageElement = document.querySelector(".current-language, [data-test='current-language']");
  if (currentLanguageElement?.textContent) {
    const text = currentLanguageElement.textContent.trim();
    return {
      languagePair: null,
      targetLanguage: text,
    };
  }

  return {
    languagePair: null,
    targetLanguage: null,
  };
}

function extractReviewsReadyCount(): number | null {
  const selectors = [
    ".reviews-count",
    "[data-test='reviews-count']",
    ".review-button .badge",
    ".dashboard-reviews-count",
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.textContent) {
      const parsedNumber = parseInt(element.textContent.replace(/[^0-9]/g, ""), 10);
      if (!isNaN(parsedNumber)) {
        return parsedNumber;
      }
    }
  }

  return null;
}

function extractActiveSentence(): {
  sentence: string | null;
  targetWord: string | null;
  translation: string | null;
} {
  const sentenceElement = document.querySelector(
    ".cloze-sentence, .sentence-text, [data-test='sentence']"
  );
  const targetWordElement = document.querySelector(
    ".cloze-word, .cloze-blank, [data-test='cloze-word']"
  );
  const translationElement = document.querySelector(
    ".translation-text, .sentence-translation, [data-test='translation']"
  );

  return {
    sentence: sentenceElement?.textContent?.trim() || null,
    targetWord: targetWordElement?.textContent?.trim() || null,
    translation: translationElement?.textContent?.trim() || null,
  };
}

function convertCardsToTsv(cards: ClozeCardInput[]): string {
  const lines = cards
    .filter((card) => Boolean(card && card.sentence && card.targetWord && card.translation))
    .map((card) => {
      const sanitizedSentence = (card.sentence || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedTranslation = (card.translation || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedTargetWord = (card.targetWord || "").replace(/\r?\n|\r|\t/g, " ").trim();
      const sanitizedHint = (card.hint || "").replace(/\r?\n|\r|\t/g, " ").trim();
      return `${sanitizedSentence}\t${sanitizedTranslation}\t${sanitizedTargetWord}\t${sanitizedHint}`;
    });

  return lines.join("\n");
}

export default defineContentScript({
  matches: ["*://*.clozemaster.com/*"],
  world: "MAIN",
  runAt: "document_idle",
  async main() {
    if (!isWebMcpSupported()) {
      return;
    }

    const abortController = new AbortController();

    const getClozemasterSessionSummaryTool: WebMcpToolDefinition<
      Record<string, unknown>,
      unknown
    > = {
      name: "get_clozemaster_session_summary",
      description:
        "Extracts the current Clozemaster study session context, including language pair, reviews ready count, active sentence, and study progress.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: () => {
        const { languagePair, targetLanguage } = detectClozemasterLanguage();
        const reviewsReadyCount = extractReviewsReadyCount();
        const activeSentence = extractActiveSentence();

        let stagedCollections: StagedClozeCollection[] = [];
        try {
          const rawStaged = window.localStorage.getItem("clozemaster_staged_harvest");
          if (rawStaged) {
            stagedCollections = JSON.parse(rawStaged) as StagedClozeCollection[];
          }
        } catch {
          // Ignore storage parse issues
        }

        return {
          url: window.location.href,
          languagePair,
          targetLanguage,
          reviewsReadyCount,
          activeSentence: activeSentence.sentence ? activeSentence : null,
          stagedHarvestCount: stagedCollections.length,
          lastStagedAt: stagedCollections[0]?.timestamp ?? null,
        };
      },
    };

    const stageClozeCardsTool: WebMcpToolDefinition<
      {
        collectionName?: string;
        cards: ClozeCardInput[];
      },
      unknown
    > = {
      name: "stage_cloze_cards",
      description:
        "Transforms harvested sentences from YouTube videos or study materials into formatted Clozemaster cloze flashcards and stages them for collection import (or injects them directly into the import textarea if on the import page).",
      inputSchema: {
        type: "object",
        properties: {
          collectionName: {
            type: "string",
            description: "Custom collection or deck name (defaults to 'YouTube Immersion')",
          },
          cards: {
            type: "array",
            description: "List of cloze sentences to stage",
            items: {
              type: "object",
              properties: {
                sentence: {
                  type: "string",
                  description:
                    "Sentence in the target language with the cloze word marked with {{clozeWord}} or [clozeWord]",
                },
                targetWord: {
                  type: "string",
                  description: "The specific word that was hidden / should be tested",
                },
                translation: {
                  type: "string",
                  description: "English translation of the full sentence",
                },
                hint: {
                  type: "string",
                  description: "Optional grammar note or clue (e.g. 'locative case', 'past tense')",
                },
              },
              required: ["sentence", "targetWord", "translation"],
            },
          },
        },
        required: ["cards"],
      },
      annotations: {
        readOnlyHint: false,
      },
      execute: (inputArguments) => {
        const collectionName = inputArguments.collectionName?.trim() || "YouTube Immersion";
        const cards = Array.isArray(inputArguments.cards) ? inputArguments.cards : [];
        const validCards = cards.filter(
          (card) => Boolean(card && card.sentence && card.targetWord && card.translation)
        );

        if (validCards.length === 0) {
          return {
            success: false,
            errorMessage: "No valid cards provided. Each card must include sentence, targetWord, and translation.",
          };
        }

        const tsvContent = convertCardsToTsv(validCards);

        // Check if an import textarea exists in the DOM to populate directly
        const importTextarea = document.querySelector(
          "textarea[name='sentences'], textarea.collection-import-input, #bulk-import-sentences"
        ) as HTMLTextAreaElement | null;

        let injectedIntoDom = false;
        if (importTextarea) {
          const previousValue = importTextarea.value;
          const nextValue = previousValue ? `${previousValue}\n${tsvContent}` : tsvContent;
          const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value"
          )?.set;
          if (typeof nativeTextareaValueSetter === "function") {
            nativeTextareaValueSetter.call(importTextarea, nextValue);
          } else {
            importTextarea.value = nextValue;
          }
          importTextarea.dispatchEvent(new Event("input", { bubbles: true }));
          importTextarea.dispatchEvent(new Event("change", { bubbles: true }));
          injectedIntoDom = true;
        }

        // Persist to local storage as safety net
        let stagedToStorage = false;
        try {
          const rawStaged = window.localStorage.getItem("clozemaster_staged_harvest");
          const stagedList: StagedClozeCollection[] = rawStaged ? JSON.parse(rawStaged) : [];
          stagedList.unshift({
            collectionName,
            timestamp: Date.now(),
            cards: validCards,
            tsvContent,
          });
          window.localStorage.setItem(
            "clozemaster_staged_harvest",
            JSON.stringify(stagedList.slice(0, 10))
          );
          stagedToStorage = true;
        } catch (storageError) {
          console.warn("[Clozemaster WebMCP] Could not persist staged cards to localStorage:", storageError);
        }

        return {
          success: true,
          collectionName,
          cardsCount: validCards.length,
          tsvContent,
          injectedIntoDom,
          stagedToStorage,
          preview: validCards.slice(0, 3),
          message: injectedIntoDom
            ? `Injected ${validCards.length} cards into Clozemaster import textarea and staged for collection "${collectionName}".`
            : `Staged ${validCards.length} cards for Clozemaster collection "${collectionName}" in local storage (ready to paste or import).`,
        };
      },
    };

    await Promise.all([
      registerWebMcpTool(getClozemasterSessionSummaryTool, abortController.signal),
      registerWebMcpTool(stageClozeCardsTool, abortController.signal),
    ]);
  },
});
