/**
 * Clozemaster WebMCP Content Script (runs in MAIN world).
 * Exposes spaced-repetition study state and custom cloze card creation to browser AI agents.
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import type { ClozeCardInput } from "../utils/clozemasterApi";
import {
  CARDS_INPUT_SCHEMA,
  COLLECTION_TARGET_PROPERTIES,
  MAX_CARDS_PER_CALL,
  addSentencesResult,
  listCollectionsResult,
  type AddSentencesInput,
} from "../utils/clozemasterTools";
import { servePageRequests } from "../utils/pageService";

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
    // Serves the YouTube tab's Clozemaster tools, which reach this tab through the background.
    servePageRequests({
      "clozemaster:list": () => listCollectionsResult(),
      "clozemaster:add": (payload) => addSentencesResult(payload as AddSentencesInput),
    });

    if (!isWebMcpSupported()) {
      return;
    }

    const abortController = new AbortController();

    const getClozemasterSessionSummaryTool: WebMcpToolDefinition<
      Record<string, unknown>,
      unknown
    > = {
      name: "clozemaster_get_session",
      description:
        "Extracts the current Clozemaster study session context, including language pair, reviews ready count, active sentence, and the sentences the user captured from YouTube with Alt+C (capturedCards). Each captured card has its language code and a source note; send only the ones in the language open in Clozemaster to clozemaster_add_sentences, and write a translation for any card whose translation is empty.",
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
      name: "clozemaster_list_collections",
      description:
        "Lists the user's own Clozemaster collections for the language open in Clozemaster, with their IDs, slugs, play URLs and sentence counts. Use it to pick a collection before clozemaster_add_sentences. Works from any page of that language, including settings and play views. On failure it returns reason (signed_out, pro_required, wrong_view or request_failed) and an instruction to show the user; wrong_view also lists collection play URLs from the user's history.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: () => listCollectionsResult(),
    };

    const addSentencesTool: WebMcpToolDefinition<
      AddSentencesInput & Record<string, unknown>,
      unknown
    > = {
      name: "clozemaster_add_sentences",
      description:
        `Adds cloze sentences to one of the user's Clozemaster collections, for the language currently open in Clozemaster. Pass collectionId to use an existing collection, or collectionName to use the collection with that name and create it if it doesn't exist. Each sentence must be in the target language with exactly one word wrapped in {{ }}, for example "Včera som {{ochutnal}} bryndzové halušky." At most ${MAX_CARDS_PER_CALL} sentences per call. Requires Clozemaster Pro. Confirm the sentences with the user first: this writes to their Clozemaster account.`,
      inputSchema: {
        type: "object",
        properties: {
          ...COLLECTION_TARGET_PROPERTIES,
          cards: CARDS_INPUT_SCHEMA,
        },
        required: ["cards"],
      },
      annotations: {
        readOnlyHint: false,
      },
      execute: (inputArguments) => addSentencesResult(inputArguments),
    };

    await Promise.all([
      registerWebMcpTool(getClozemasterSessionSummaryTool, abortController.signal),
      registerWebMcpTool(listCollectionsTool, abortController.signal),
      registerWebMcpTool(addSentencesTool, abortController.signal),
    ]);
  },
});
