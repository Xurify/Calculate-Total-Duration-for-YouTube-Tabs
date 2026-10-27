import { buildApprovalRequest, ensureReadGrant, isExtensionPageSender, requestApproval } from "../../utils/approvals";
import {
  editSentences,
  loadSentenceBank,
  markInClozemaster,
  saveSentenceBank,
  type SentenceEdit,
} from "../../utils/sentenceBank";
import { clozemasterCard, DEFAULT_COLLECTION_NAME, sentenceLanguageCode } from "../../utils/clozemasterExport";
import { MAX_CARDS_PER_CALL } from "../../utils/clozemasterTools";
import { withPracticeStore } from "./practice";

export async function broadcastToClozemasterTabs(messagePayload: unknown): Promise<void> {
  const allTabs = await browser.tabs.query({});
  const clozemasterTabs = allTabs.filter((candidateTab) => {
    if (!candidateTab.url || candidateTab.id === undefined) return false;
    try {
      const urlObject = new URL(candidateTab.url);
      return urlObject.hostname.includes("clozemaster.com");
    } catch {
      return false;
    }
  });
  for (const clozemasterTab of clozemasterTabs) {
    if (clozemasterTab.id !== undefined) {
      void browser.tabs.sendMessage(clozemasterTab.id, messagePayload).catch(() => {});
    }
  }
}

const CLOZEMASTER_PLAY_URL = /^https:\/\/www\.clozemaster\.com\/l\/([a-z]{3}-[a-z]{3})\/collections\/([^/?#]+)\/play(?:[?#]|$)/i;

/** Only collection play URLs the person actually visited; nothing else from history leaves here. */
export async function findClozemasterCollectionUrls(limit = 10) {
  const items = await browser.history.search({ text: "clozemaster.com/l/", startTime: 0, maxResults: 1000 });
  const bySlug = new Map<string, { url: string; languagePair: string; slug: string; title: string; lastVisitTime: number }>();
  for (const item of items) {
    const match = item.url?.match(CLOZEMASTER_PLAY_URL);
    if (!item.url || !match) continue;
    const slug = decodeURIComponent(match[2]);
    const lastVisitTime = item.lastVisitTime ?? 0;
    const existing = bySlug.get(slug);
    if (existing && existing.lastVisitTime >= lastVisitTime) continue;
    bySlug.set(slug, { url: item.url, languagePair: match[1].toLowerCase(), slug, title: item.title ?? "", lastVisitTime });
  }
  return [...bySlug.values()].sort((first, second) => second.lastVisitTime - first.lastVisitTime).slice(0, limit);
}

export interface ClozemasterRemoteMessage {
  op: "list" | "add";
  payload?: {
    languagePair?: string;
    collectionId?: number | string;
    collectionName?: string;
    cards?: Array<{ sentence?: string }>;
  };
}

export class ClozemasterRemoteError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const CLOZEMASTER_PAIR_URL = /^https:\/\/www\.clozemaster\.com\/l\/([a-z]{3}-[a-z]{3})(?:[/?#]|$)/i;

function clozemasterPairOf(url: string | undefined): string | null {
  return url?.match(CLOZEMASTER_PAIR_URL)?.[1]?.toLowerCase() ?? null;
}

/** Language pairs the person has opened in Clozemaster, most recent first. */
export async function visitedClozemasterPairs(): Promise<string[]> {
  const items = await browser.history.search({ text: "clozemaster.com/l/", startTime: 0, maxResults: 1000 });
  const pairs: string[] = [];
  for (const item of [...items].sort((first, second) => (second.lastVisitTime ?? 0) - (first.lastVisitTime ?? 0))) {
    const pair = clozemasterPairOf(item.url);
    if (pair && !pairs.includes(pair)) pairs.push(pair);
  }
  return pairs;
}

async function waitForTabComplete(tabId: number, timeoutMilliseconds = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * A Clozemaster tab for the language: an open one if there is one, otherwise a background tab
 * on that language's dashboard (the /l/<pair> page Clozemaster's own language menu links to).
 */
async function clozemasterTabFor(requestedPair: string | null): Promise<{ tabId: number; opened: boolean; pair: string | null }> {
  const tabs = (await browser.tabs.query({ url: "https://www.clozemaster.com/*" })).filter((tab) => tab.id !== undefined);
  const matching = requestedPair
    ? tabs.find((tab) => clozemasterPairOf(tab.url) === requestedPair)
    : tabs.find((tab) => clozemasterPairOf(tab.url)) ?? tabs[0];
  if (matching?.id !== undefined) return { tabId: matching.id, opened: false, pair: clozemasterPairOf(matching.url) };

  let pair = requestedPair;
  if (!pair) {
    const visited = await visitedClozemasterPairs();
    if (visited.length === 1) pair = visited[0];
    else if (visited.length > 1) {
      throw new ClozemasterRemoteError("language_required", "Which Clozemaster language should these go to?", {
        instruction: "Pass languagePair, one of knownLanguagePairs.",
        knownLanguagePairs: visited,
      });
    } else {
      throw new ClozemasterRemoteError("no_clozemaster_tab", "No Clozemaster language is known yet.", {
        instruction: "Open https://www.clozemaster.com, sign in and open the language you study, then try again.",
      });
    }
  }

  const created = await browser.tabs.create({ url: `https://www.clozemaster.com/l/${pair}`, active: false });
  if (created.id === undefined) throw new ClozemasterRemoteError("request_failed", "Couldn't open Clozemaster.");
  await waitForTabComplete(created.id);
  return { tabId: created.id, opened: true, pair };
}

async function sendToClozemasterTab(tabId: number, message: unknown): Promise<unknown> {
  // A freshly opened tab may not have its content script yet.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await browser.tabs.sendMessage(tabId, message);
      const notReady = (response as { reason?: string } | undefined)?.reason === "not_ready";
      if (response !== undefined && !notReady) return response;
    } catch {
      // Receiving end not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ClozemasterRemoteError("not_ready", "The Clozemaster tab didn't answer.", {
    instruction: "Reload the Clozemaster tab and try again.",
  });
}

export async function handleClozemasterRemote(message: ClozemasterRemoteMessage, sender: Browser.runtime.MessageSender) {
  const payload = message.payload ?? {};
  const requestedPair = payload.languagePair?.trim().toLowerCase() || null;
  if (requestedPair && !/^[a-z]{3}-[a-z]{3}$/.test(requestedPair)) {
    throw new ClozemasterRemoteError("invalid_input", `"${payload.languagePair}" isn't a Clozemaster language pair.`, {
      instruction: 'Use a pair from a Clozemaster URL, such as "slk-eng".',
    });
  }

  if (message.op === "list") {
    await ensureReadGrant(
      sender,
      "clozemaster-collections",
      buildApprovalRequest(sender, {
        title: "Share your Clozemaster collections?",
        summary: "This page wants to see the names of your Clozemaster collections so it can add sentences to one.",
        confirmLabel: "Allow",
        destructive: false,
      })
    );
  } else if (!isExtensionPageSender(sender)) {
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    const target = payload.collectionName?.trim()
      ? `“${payload.collectionName.trim()}” (created if you don't have it yet)`
      : `collection ${payload.collectionId ?? "?"}`;
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Add ${cards.length} ${cards.length === 1 ? "sentence" : "sentences"} to Clozemaster?`,
        summary: `This page wants to add these sentences to your Clozemaster ${target}${requestedPair ? ` for ${requestedPair}` : ""}.`,
        items: cards.map((card) => card.sentence ?? ""),
        confirmLabel: "Add sentences",
        destructive: false,
      })
    );
    if (!approved) throw new ClozemasterRemoteError("declined", "The user declined to add these sentences.");
  }

  const { tabId, opened, pair } = await clozemasterTabFor(requestedPair);
  try {
    const { languagePair: _ignored, ...opPayload } = payload;
    const result = (await sendToClozemasterTab(tabId, { action: "clozemaster-op", op: message.op, payload: opPayload })) as Record<
      string,
      unknown
    >;
    return { ...result, languagePair: pair };
  } finally {
    if (opened) void browser.tabs.remove(tabId).catch(() => {});
  }
}

export function cleanEdits(raw: unknown): SentenceEdit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((edit): edit is SentenceEdit => Boolean(edit) && typeof edit.id === "string")
    .map((edit) => ({
      id: edit.id,
      clozeWord: typeof edit.clozeWord === "string" ? edit.clozeWord.slice(0, 100) : undefined,
      translation: typeof edit.translation === "string" ? edit.translation.slice(0, 500) : undefined,
    }));
}

interface ClozemasterSendResult {
  success?: boolean;
  reason?: string;
  errorMessage?: string;
  instruction?: string;
  collection?: { name: string; playUrl: string | null };
  results?: Array<{ index: number; added: boolean; error?: string }>;
}

/**
 * Adds saved sentences to a collection for one language pair. The cards are built here from the
 * stored text, so the page only chooses the blank and the translation.
 */
export async function sendBankToClozemaster(message: Record<string, unknown>, sender: Browser.runtime.MessageSender) {
  const languagePair = typeof message.languagePair === "string" ? message.languagePair : "";
  const collectionName = (typeof message.collectionName === "string" ? message.collectionName.trim().slice(0, 100) : "") || DEFAULT_COLLECTION_NAME;
  const edits = cleanEdits(message.items).filter((edit) => edit.clozeWord && edit.translation);
  // Saved first, so the translations typed in stay even when Clozemaster can't be reached.
  const bank = await withPracticeStore(async () => {
    const next = editSentences(await loadSentenceBank(), edits);
    await saveSentenceBank(next);
    return next;
  });
  const chosen = edits
    .map((edit) => bank.find((sentence) => sentence.id === edit.id))
    .filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence));
  if (chosen.length === 0) return { success: false, reason: "invalid_input", errorMessage: "Pick at least one sentence with a translation." };

  const added: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let collection: ClozemasterSendResult["collection"];
  for (let start = 0; start < chosen.length; start += MAX_CARDS_PER_CALL) {
    const batch = chosen.slice(start, start + MAX_CARDS_PER_CALL);
    const cards = batch.map((sentence) => clozemasterCard(sentence, sentence.clozeWord ?? "", sentence.translation, sentenceLanguageCode(sentence)));
    const result = (await handleClozemasterRemote({ op: "add", payload: { languagePair, collectionName, cards } }, sender)) as ClozemasterSendResult;
    if (!result.results) {
      // Nothing was attempted: signed out, no Pro, or no Clozemaster tab. Keep what was sent so far.
      if (added.length === 0) return { ...result, success: false, bank };
      break;
    }
    collection = result.collection ?? collection;
    for (const row of result.results) {
      const sentence = batch[row.index];
      if (!sentence) continue;
      if (row.added) added.push(sentence.id);
      else failed.push({ id: sentence.id, error: row.error ?? "Not added." });
    }
  }

  const next = await withPracticeStore(async () => {
    const marked = markInClozemaster(await loadSentenceBank(), added, collection?.name ?? collectionName);
    await saveSentenceBank(marked);
    return marked;
  });
  const playUrl = collection?.playUrl ? new URL(collection.playUrl, "https://www.clozemaster.com").href : null;
  return { success: added.length > 0, bank: next, addedCount: added.length, failed, collection: { name: collection?.name ?? collectionName, playUrl } };
}
