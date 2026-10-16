/**
 * The list and add operations behind the Clozemaster WebMCP tools. They run in a Clozemaster
 * tab's MAIN world, whether an agent calls them there or from YouTube through the background.
 */
import {
  ClozemasterError,
  addCardsToCollection,
  createCollection,
  listMyCollections,
  type ClozeCardInput,
  type ClozemasterCollection,
} from "./clozemasterApi";
import { sendBridgeRequest } from "./webmcpBridge";

export const MAX_CARDS_PER_CALL = 50;

export interface AddSentencesInput {
  collectionId?: number | string;
  collectionName?: string;
  cards: ClozeCardInput[];
}

export const CARDS_INPUT_SCHEMA = {
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
} as const;

export const COLLECTION_TARGET_PROPERTIES = {
  collectionId: {
    type: ["number", "string"],
    description: "ID or slug of an existing collection, from list_clozemaster_collections, to add to it",
  },
  collectionName: {
    type: "string",
    description: "Collection name to add to; a new collection (deck) with this name is created if the user has none",
  },
} as const;

interface VisitedCollectionUrl {
  url: string;
  languagePair: string;
  slug: string;
  title: string;
}

/** Machine-readable failure: `reason` to branch on, `instruction` to show the person. */
async function failure(error: unknown) {
  if (!(error instanceof ClozemasterError)) {
    return {
      success: false,
      reason: "request_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      instruction: "Reload the Clozemaster page and try again.",
    };
  }
  const recentCollectionUrls =
    error.reason === "wrong_view"
      ? await sendBridgeRequest<Record<string, never>, VisitedCollectionUrl[]>("find-clozemaster-collection-urls", {}).catch(
          () => []
        )
      : [];
  return {
    success: false,
    reason: error.reason,
    errorMessage: error.message,
    instruction: error.instruction,
    ...(recentCollectionUrls.length > 0
      ? {
          recentCollectionUrls: recentCollectionUrls.map(({ url, languagePair, slug, title }) => ({
            url,
            languagePair,
            slug,
            title,
          })),
        }
      : {}),
  };
}

export async function listCollectionsResult() {
  try {
    const collections = await listMyCollections();
    return {
      success: true,
      collections: collections.map(({ id, slug, name, numSentences, playUrl }) => ({ id, slug, name, numSentences, playUrl })),
    };
  } catch (error) {
    return await failure(error);
  }
}

export async function addSentencesResult(input: AddSentencesInput) {
  const cards = Array.isArray(input.cards) ? input.cards : [];
  if (cards.length === 0) {
    return { success: false, reason: "invalid_input", errorMessage: "cards must contain at least one sentence." };
  }
  if (cards.length > MAX_CARDS_PER_CALL) {
    return {
      success: false,
      reason: "invalid_input",
      errorMessage: `Send at most ${MAX_CARDS_PER_CALL} sentences per call; split larger decks over several calls.`,
    };
  }

  try {
    const collections = await listMyCollections();
    const requestedName = input.collectionName?.trim();
    const requestedId = input.collectionId;
    let collection: ClozemasterCollection | undefined;
    let created = false;

    if (requestedId !== undefined && requestedId !== "") {
      collection = collections.find(
        (candidate) => String(candidate.id) === String(requestedId) || candidate.slug === String(requestedId)
      );
      if (!collection) {
        return {
          success: false,
          reason: "not_found",
          errorMessage: `No collection of yours has ID ${requestedId}.`,
          instruction: "Call list_clozemaster_collections and use one of the IDs it returns.",
        };
      }
    } else if (requestedName) {
      collection = collections.find((candidate) => candidate.name.trim().toLowerCase() === requestedName.toLowerCase());
      if (!collection) {
        collection = await createCollection(requestedName);
        created = true;
      }
    } else {
      return { success: false, reason: "invalid_input", errorMessage: "Pass collectionId or collectionName." };
    }

    const results = await addCardsToCollection(collection, cards);
    const addedCount = results.filter((result) => result.added).length;
    return {
      success: addedCount > 0,
      collection: { id: collection.id, slug: collection.slug, name: collection.name, playUrl: collection.playUrl, created },
      addedCount,
      failedCount: results.length - addedCount,
      results,
    };
  } catch (error) {
    return await failure(error);
  }
}
