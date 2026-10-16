/**
 * Clozemaster's own JSON endpoints, called from the MAIN world with the user's session.
 *
 * The request shapes mirror what Clozemaster's "Add Sentence to Collection" modal sends,
 * so they can change whenever Clozemaster ships a new frontend. Custom collections need Pro.
 */

import { sendBridgeRequest } from "./webmcpBridge";

export interface ClozemasterCollection {
  /** Clozemaster sends numbers or strings here; its own modal compares them as strings. */
  id: number | string;
  /** The `<name>-<uuid>` part of the collection's play URL. */
  slug: string | null;
  name: string;
  numSentences: number | null;
  sentencesUrl: string;
  playUrl: string | null;
}

export type ClozemasterFailureReason = "signed_out" | "pro_required" | "wrong_view" | "request_failed";

/** Thrown with a reason a tool can branch on and an instruction a person can follow. */
export class ClozemasterError extends Error {
  constructor(
    readonly reason: ClozemasterFailureReason,
    message: string,
    readonly instruction: string
  ) {
    super(message);
  }
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
  id: number | string;
  slug?: string;
  playUrl?: string;
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

function findValueDeep(value: unknown, key: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  if (key in record && record[key] !== null && record[key] !== undefined) return record[key];
  for (const child of Object.values(record)) {
    const found = findValueDeep(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Clozemaster renders its views with react-rails, so page data sits in each mount point's data-react-props JSON. */
function readReactProps(root: ParentNode): unknown[] {
  const props: unknown[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-react-props]")) {
    try {
      props.push(JSON.parse(element.dataset.reactProps ?? ""));
    } catch {
      // Not every mount point carries valid JSON props.
    }
  }
  return props;
}

function propValue(allProps: unknown[], key: string): unknown {
  for (const props of allProps) {
    const found = findValueDeep(props, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

interface PageState {
  collectionsUrl: string | null;
  /** DashboardV5 keeps collectionsUrl out of its props and loads it from this JSON endpoint. */
  languagePairingUrl: string | null;
  isSignedIn: boolean | null;
  isPro: boolean | null;
  dashboardPath: string | null;
}

function languagePairFromPath(pathname: string): string | null {
  return pathname.match(/^\/l\/([a-z]{3}-[a-z]{3})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null;
}

function readPageState(root: ParentNode, pathname: string): PageState {
  const allProps = readReactProps(root);
  const collectionsUrl = propValue(allProps, "collectionsUrl");
  const languagePairingUrl = propValue(allProps, "languagePairingUrl");
  const isSignedIn = propValue(allProps, "isSignedIn");
  const isPro = propValue(allProps, "isPro");
  const webUrl = propValue(allProps, "languagePairingWebUrl");
  const pair = languagePairFromPath(pathname);
  let dashboardPath: string | null = null;
  if (typeof webUrl === "string" && webUrl.startsWith("/")) dashboardPath = webUrl;
  else if (pair) dashboardPath = `/l/${pair}`;
  return {
    collectionsUrl: typeof collectionsUrl === "string" ? collectionsUrl : null,
    languagePairingUrl: typeof languagePairingUrl === "string" ? languagePairingUrl : null,
    isSignedIn: typeof isSignedIn === "boolean" ? isSignedIn : null,
    isPro: typeof isPro === "boolean" ? isPro : null,
    dashboardPath,
  };
}

function looksSignedOut(root: Document): boolean {
  return Boolean(root.querySelector('form[action*="sign_in"], form[action*="login"], input[type="password"]'));
}

const SIGN_IN_INSTRUCTION = "Sign in at https://www.clozemaster.com/login, then open your language's dashboard and try again.";

/** The same request DashboardV5 makes on load; its languagePairing carries collectionsUrl. */
async function fromLanguagePairing(
  state: PageState
): Promise<{ collectionsUrl: string; isPro: boolean | null } | null> {
  if (state.collectionsUrl) return { collectionsUrl: state.collectionsUrl, isPro: state.isPro };
  if (!state.languagePairingUrl) return null;
  const response = await fetch(state.languagePairingUrl, { credentials: "same-origin", headers: requestHeaders() }).catch(
    () => null
  );
  if (response?.status === 401) {
    throw new ClozemasterError("signed_out", "You're not signed in to Clozemaster.", SIGN_IN_INSTRUCTION);
  }
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    languagePairing?: { collectionsUrl?: string };
    user?: { isPro?: boolean };
  } | null;
  const collectionsUrl = data?.languagePairing?.collectionsUrl;
  if (typeof collectionsUrl !== "string") return null;
  const isPro = data?.user?.isPro;
  return { collectionsUrl, isPro: typeof isPro === "boolean" ? isPro : state.isPro };
}

interface VisitedCollectionUrl {
  url: string;
  languagePair: string;
}

/**
 * Finds the collections endpoint: in the page props, or through the languagePairingUrl the
 * dashboard loads it from. Settings and play views can lack both, so this falls back to
 * pages Clozemaster itself links to (the language dashboard and its collections tab) and to
 * collection play pages from the person's history, fetching each and reading its props.
 * Nothing is navigated to, and only a page that actually carries the endpoint counts.
 */
async function resolveCollectionsUrl(): Promise<{ collectionsUrl: string; isPro: boolean | null }> {
  const here = readPageState(document, window.location.pathname);
  if (here.isSignedIn === false || (here.isSignedIn === null && looksSignedOut(document))) {
    throw new ClozemasterError("signed_out", "You're not signed in to Clozemaster.", SIGN_IN_INSTRUCTION);
  }
  const fromHere = await fromLanguagePairing(here);
  if (fromHere) return fromHere;

  const candidates: string[] = [];
  if (here.dashboardPath) candidates.push(here.dashboardPath, `${here.dashboardPath}?tab=collections`);
  const pair = languagePairFromPath(here.dashboardPath ?? window.location.pathname);
  const visited = await sendBridgeRequest<Record<string, never>, VisitedCollectionUrl[]>(
    "find-clozemaster-collection-urls",
    {}
  ).catch(() => []);
  for (const entry of visited) {
    if (!pair || entry.languagePair === pair) candidates.push(entry.url);
    if (candidates.length >= 4) break;
  }

  const currentUrl = window.location.pathname + window.location.search;
  for (const candidate of new Set(candidates)) {
    if (candidate === currentUrl) continue;
    const response = await fetch(candidate, { credentials: "same-origin" }).catch(() => null);
    if (!response) continue;
    const landedOn = new URL(response.url);
    if (/\/(sign-up|login|users\/sign_in)/.test(landedOn.pathname)) {
      throw new ClozemasterError("signed_out", "You're not signed in to Clozemaster.", SIGN_IN_INSTRUCTION);
    }
    if (!response.ok) continue;
    const page = new DOMParser().parseFromString(await response.text(), "text/html");
    const there = readPageState(page, landedOn.pathname);
    if (there.isSignedIn === false) {
      throw new ClozemasterError("signed_out", "You're not signed in to Clozemaster.", SIGN_IN_INSTRUCTION);
    }
    const fromThere = await fromLanguagePairing(there);
    if (fromThere) return { collectionsUrl: fromThere.collectionsUrl, isPro: fromThere.isPro ?? here.isPro };
  }

  const where = here.dashboardPath
    ? `https://www.clozemaster.com${here.dashboardPath}?tab=collections`
    : "https://www.clozemaster.com/dashboard, then pick the language you study";
  throw new ClozemasterError(
    "wrong_view",
    "This Clozemaster page doesn't show your collections.",
    `Open ${where} while signed in, and try again.`
  );
}

function toCollection(raw: RawCollection): ClozemasterCollection | null {
  const sentencesUrl = raw.collectionClozeSentencesUrl ?? raw.collectionClozeSentencesUpsertUrl;
  if ((typeof raw.id !== "number" && typeof raw.id !== "string") || !sentencesUrl) return null;
  return {
    id: raw.id,
    slug: raw.slug ?? null,
    name: raw.name,
    numSentences: raw.numSentences ?? null,
    sentencesUrl,
    playUrl: raw.playUrl ?? null,
  };
}

export async function listMyCollections(): Promise<ClozemasterCollection[]> {
  const { collectionsUrl, isPro } = await resolveCollectionsUrl();
  const response = await fetch(`${collectionsUrl}?filter=mine&order=updatedAt`, {
    credentials: "same-origin",
    headers: requestHeaders(),
  });
  if (response.status === 401) {
    throw new ClozemasterError("signed_out", "You're not signed in to Clozemaster.", SIGN_IN_INSTRUCTION);
  }
  if (response.status === 403 || (isPro === false && !response.ok)) {
    throw new ClozemasterError(
      "pro_required",
      "Custom collections are a Clozemaster Pro feature.",
      "Upgrade to Clozemaster Pro, or add the sentences by hand in Clozemaster."
    );
  }
  if (!response.ok) {
    throw new ClozemasterError(
      "request_failed",
      `Couldn't load your collections (HTTP ${response.status}).`,
      "Reload the Clozemaster page and try again."
    );
  }
  const data = (await response.json()) as { collections?: RawCollection[] };
  const collections = (data.collections ?? []).map(toCollection).filter((c): c is ClozemasterCollection => c !== null);
  if (collections.length === 0 && isPro === false) {
    throw new ClozemasterError(
      "pro_required",
      "Custom collections are a Clozemaster Pro feature.",
      "Upgrade to Clozemaster Pro, or add the sentences by hand in Clozemaster."
    );
  }
  return collections;
}

export async function createCollection(name: string): Promise<ClozemasterCollection> {
  const { collectionsUrl } = await resolveCollectionsUrl();
  const data = await postJson(collectionsUrl, { collection: { name } });
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
