/**
 * Clozemaster WebMCP Content Script (runs in MAIN world).
 * Exposes spaced-repetition study state and custom cloze card creation to browser AI agents.
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import {
  addCardsToCollection,
  createCollection,
  listMyCollections,
  type ClozeCardInput,
  type ClozemasterCollection,
} from "../utils/clozemasterApi";

const MAX_CARDS_PER_CALL = 50;

interface StagedClozeCollection {
  collectionName: string;
  timestamp: number;
  cards: ClozeCardInput[];
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
        "Extracts the current Clozemaster study session context, including language pair, reviews ready count, active sentence, and the sentences the user captured from YouTube with Alt+C (capturedCards). Each captured card has its language code and a source note; send only the ones in the language open in Clozemaster to add_sentences_to_clozemaster_collection, and write a translation for any card whose translation is empty.",
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
          capturedCards: stagedCollections.flatMap((collection) => collection.cards).slice(0, 100),
          lastCapturedAt: stagedCollections[0]?.timestamp ?? null,
        };
      },
    };

    const listCollectionsTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "list_clozemaster_collections",
      description:
        "Lists the user's own Clozemaster collections for the language currently open in Clozemaster, with their IDs and sentence counts. Use it to pick a collection before add_sentences_to_clozemaster_collection.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: async () => {
        try {
          const collections = await listMyCollections();
          return {
            success: true,
            collections: collections.map(({ id, name, numSentences }) => ({ id, name, numSentences })),
          };
        } catch (error) {
          return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
        }
      },
    };

    const addSentencesTool: WebMcpToolDefinition<
      { collectionId?: number; collectionName?: string; cards: ClozeCardInput[] },
      unknown
    > = {
      name: "add_sentences_to_clozemaster_collection",
      description:
        `Adds cloze sentences to one of the user's Clozemaster collections, for the language currently open in Clozemaster. Pass collectionId to use an existing collection, or collectionName to use the collection with that name and create it if it doesn't exist. Each sentence must be in the target language with exactly one word wrapped in {{ }}, for example "Včera som {{ochutnal}} bryndzové halušky." At most ${MAX_CARDS_PER_CALL} sentences per call. Requires Clozemaster Pro. Confirm the sentences with the user first: this writes to their Clozemaster account.`,
      inputSchema: {
        type: "object",
        properties: {
          collectionId: {
            type: "number",
            description: "ID of an existing collection, from list_clozemaster_collections",
          },
          collectionName: {
            type: "string",
            description: "Collection name; created if the user has no collection with this name",
          },
          cards: {
            type: "array",
            maxItems: MAX_CARDS_PER_CALL,
            items: {
              type: "object",
              properties: {
                sentence: {
                  type: "string",
                  description: "Target-language sentence with exactly one {{clozeWord}}",
                },
                translation: { type: "string", description: "Translation of the full sentence" },
                targetWord: {
                  type: "string",
                  description: "Optional; used to mark the cloze word when the sentence has no {{ }}",
                },
                hint: { type: "string", description: "Shown before answering, e.g. 'past tense'" },
                notes: { type: "string", description: "Shown after answering, e.g. a grammar note or the video it came from" },
                pronunciation: { type: "string" },
                alternativeAnswers: {
                  type: "array",
                  items: { type: "string" },
                  description: "Other words accepted as correct",
                },
              },
              required: ["sentence", "translation"],
            },
          },
        },
        required: ["cards"],
      },
      annotations: {
        readOnlyHint: false,
      },
      execute: async (inputArguments) => {
        const cards = Array.isArray(inputArguments.cards) ? inputArguments.cards : [];
        if (cards.length === 0) {
          return { success: false, errorMessage: "cards must contain at least one sentence." };
        }
        if (cards.length > MAX_CARDS_PER_CALL) {
          return { success: false, errorMessage: `Send at most ${MAX_CARDS_PER_CALL} sentences per call.` };
        }

        try {
          const collections = await listMyCollections();
          const requestedName = inputArguments.collectionName?.trim();
          let collection: ClozemasterCollection | undefined;
          let created = false;

          if (typeof inputArguments.collectionId === "number") {
            collection = collections.find((candidate) => candidate.id === inputArguments.collectionId);
            if (!collection) {
              return { success: false, errorMessage: `No collection of yours has ID ${inputArguments.collectionId}.` };
            }
          } else if (requestedName) {
            collection = collections.find(
              (candidate) => candidate.name.trim().toLowerCase() === requestedName.toLowerCase()
            );
            if (!collection) {
              collection = await createCollection(requestedName);
              created = true;
            }
          } else {
            return { success: false, errorMessage: "Pass collectionId or collectionName." };
          }

          const results = await addCardsToCollection(collection, cards);
          const addedCount = results.filter((result) => result.added).length;
          return {
            success: addedCount > 0,
            collection: { id: collection.id, name: collection.name, created },
            addedCount,
            failedCount: results.length - addedCount,
            results,
          };
        } catch (error) {
          return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
        }
      },
    };

    await Promise.all([
      registerWebMcpTool(getClozemasterSessionSummaryTool, abortController.signal),
      registerWebMcpTool(listCollectionsTool, abortController.signal),
      registerWebMcpTool(addSentencesTool, abortController.signal),
    ]);
  },
});
