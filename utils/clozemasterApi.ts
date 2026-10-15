/**
 * Clozemaster's own JSON endpoints, called from the MAIN world with the user's session.
 *
 * The request shapes mirror what Clozemaster's "Add Sentence to Collection" modal sends,
 * so they can change whenever Clozemaster ships a new frontend. Custom collections need Pro.
 */

export interface ClozemasterCollection {
  id: number;
  name: string;
  numSentences: number | null;
  sentencesUrl: string;
}

export interface ClozeCardInput {
  sentence: string;
  translation: string;
  targetWord?: string;
  hint?: string;
  notes?: string;
  pronunciation?: string;
  alternativeAnswers?: string[];
}

export interface CardResult {
  index: number;
  text: string | null;
  added: boolean;
  error?: string;
}

interface RawCollection {
  id: number;
  name: string;
  numSentences?: number;
  collectionClozeSentencesUrl?: string;
  collectionClozeSentencesUpsertUrl?: string;
}

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Time-Zone-Offset-Hours": String(-new Date().getTimezoneOffset() / 60),
    ...extra,
  };
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: requestHeaders({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken() }),
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.errors) {
    const errors = data.errors;
    const message = Array.isArray(errors) ? errors.join(", ") : errors ? String(errors) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function findKeyDeep(value: unknown, key: string, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  for (const child of Object.values(record)) {
    const found = findKeyDeep(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Clozemaster renders its React views with react-rails, so the per-language collections
 * endpoint is embedded in each mount point's data-react-props JSON.
 */
export function findCollectionsUrl(): string | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-react-props]")) {
    try {
      const found = findKeyDeep(JSON.parse(element.dataset.reactProps ?? ""), "collectionsUrl");
      if (found) return found;
    } catch {
      // Not every mount point carries valid JSON props.
    }
  }
  return null;
}

function requireCollectionsUrl(): string {
  const collectionsUrl = findCollectionsUrl();
  if (!collectionsUrl) {
    throw new Error(
      "Couldn't find your Clozemaster collections on this page. Open the Clozemaster dashboard for the language you want, signed in, and try again."
    );
  }
  return collectionsUrl;
}

function toCollection(raw: RawCollection): ClozemasterCollection | null {
  const sentencesUrl = raw.collectionClozeSentencesUrl ?? raw.collectionClozeSentencesUpsertUrl;
  if (typeof raw.id !== "number" || !sentencesUrl) return null;
  return { id: raw.id, name: raw.name, numSentences: raw.numSentences ?? null, sentencesUrl };
}

export async function listMyCollections(): Promise<ClozemasterCollection[]> {
  const response = await fetch(`${requireCollectionsUrl()}?filter=mine&order=updatedAt`, {
    credentials: "same-origin",
    headers: requestHeaders(),
  });
  if (response.status === 401) throw new Error("You're not signed in to Clozemaster.");
  if (!response.ok) throw new Error(`Couldn't load your collections (HTTP ${response.status}).`);
  const data = (await response.json()) as { collections?: RawCollection[] };
  return (data.collections ?? []).map(toCollection).filter((c): c is ClozemasterCollection => c !== null);
}

export async function createCollection(name: string): Promise<ClozemasterCollection> {
  const data = await postJson(requireCollectionsUrl(), { collection: { name } });
  const collection = data.collection ? toCollection(data.collection as RawCollection) : null;
  if (!collection) throw new Error("Clozemaster didn't return the new collection.");
  return collection;
}

const CLOZE_PATTERN = /\{\{(.+?)\}\}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clozemaster expects exactly one {{word}} per sentence. Also accepts the older [word]
 * marking, or a plain sentence plus targetWord, and wraps the first whole-word match.
 */
export function buildClozeText(card: ClozeCardInput): string {
  const sentence = card.sentence.replace(/\s+/g, " ").trim();
  const clozeCount = sentence.match(CLOZE_PATTERN)?.length ?? 0;
  if (clozeCount === 1) return sentence;
  if (clozeCount > 1) throw new Error("Mark only one word with {{ }}.");

  const bracketed = sentence.match(/\[([^\]]+)\]/g);
  if (bracketed?.length === 1) return sentence.replace(/\[([^\]]+)\]/, "{{$1}}");

  const targetWord = card.targetWord?.trim();
  if (targetWord) {
    const wordPattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(targetWord)}(?![\\p{L}\\p{N}])`, "u");
    if (wordPattern.test(sentence)) return sentence.replace(wordPattern, `{{${targetWord}}}`);
    throw new Error(`"${targetWord}" isn't in the sentence.`);
  }
  throw new Error("Mark the cloze word with {{ }} or pass targetWord.");
}

export async function addCardsToCollection(
  collection: ClozemasterCollection,
  cards: ClozeCardInput[]
): Promise<CardResult[]> {
  const results: CardResult[] = [];
  // One at a time, like Clozemaster's own bulk add, to stay gentle on their API.
  for (const [index, card] of cards.entries()) {
    let text: string | null = null;
    try {
      text = buildClozeText(card);
      if (!card.translation?.trim()) throw new Error("translation is required.");
      await postJson(collection.sentencesUrl, {
        collection_cloze_sentence: {
          text,
          translation: card.translation.trim(),
          hint: card.hint?.trim() || undefined,
          notes: card.notes?.trim() || undefined,
          pronunciation: card.pronunciation?.trim() || undefined,
          alternative_answers: card.alternativeAnswers?.map((answer) => answer.trim()).filter(Boolean).join(", ") || undefined,
        },
      });
      results.push({ index, text, added: true });
    } catch (error) {
      results.push({ index, text, added: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
