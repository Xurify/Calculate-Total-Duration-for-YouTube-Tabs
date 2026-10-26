import { escapeHtml } from "../../utils/timeUi";
import { languageFlagHtml } from "../../utils/languageFlags";
import { segmentWords } from "../../utils/transcript";
import type { BankSentence } from "../../utils/sentenceBank";
import {
  baseLanguageOf,
  clozemasterPairFor,
  clozeWordFor,
  DEFAULT_COLLECTION_NAME,
  notInClozemaster,
  sentenceLanguageCode,
} from "../../utils/clozemasterExport";

/**
 * The Practice page's hand-off to Clozemaster: saved sentences become cards in one of the person's
 * collections, with the blank and the translation checked here first.
 */

export interface ClozemasterHost {
  bank: () => BankSentence[];
  setBank: (bank: BankSentence[]) => void;
  repaint: () => void;
}

interface Row {
  word: string | null;
  translation: string;
  /** Filled by the on-device translator rather than typed. */
  machine: boolean;
  include: boolean;
  error: string | null;
}

interface Group {
  key: string;
  language: string;
  code: string | null;
  pair: string | null;
  sentences: BankSentence[];
}

interface Outcome {
  kind: "done" | "error";
  text: string;
  instruction?: string;
  link?: string;
}

interface TranslatorInstance {
  translate: (text: string) => Promise<string>;
  destroy?: () => void;
}

interface TranslatorApi {
  availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<TranslatorInstance>;
}

const COLLECTION_STORAGE_KEY = "clozemasterCollection";

let open = false;
let busy = false;
let translating: { done: number; total: number } | null = null;
let pairs: string[] = [];
let collection = storedCollection();
let outcome: Outcome | null = null;
const rows = new Map<string, Row>();
let host: ClozemasterHost | null = null;

function storedCollection(): string {
  try {
    return localStorage.getItem(COLLECTION_STORAGE_KEY) || DEFAULT_COLLECTION_NAME;
  } catch {
    return DEFAULT_COLLECTION_NAME;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function pending(): BankSentence[] {
  return host ? notInClozemaster(host.bank()) : [];
}

function groups(): Group[] {
  const byKey = new Map<string, Group>();
  for (const sentence of [...pending()].sort((first, second) => first.createdAt - second.createdAt)) {
    const code = sentenceLanguageCode(sentence);
    const pair = clozemasterPairFor(code, pairs);
    const key = pair ?? `unknown:${sentence.language}`;
    const group = byKey.get(key) ?? { key, language: sentence.language || "Unknown language", code, pair, sentences: [] };
    group.sentences.push(sentence);
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((first, second) => Number(!first.pair) - Number(!second.pair) || second.sentences.length - first.sentences.length);
}

function rowFor(sentence: BankSentence, code: string | null): Row {
  let row = rows.get(sentence.id);
  if (!row) {
    row = { word: clozeWordFor(sentence.text, sentence.clozeWord, code), translation: sentence.translation, machine: false, include: true, error: null };
    rows.set(sentence.id, row);
  }
  return row;
}

function ready(row: Row): boolean {
  return row.include && Boolean(row.word) && row.translation.trim() !== "";
}

function readyCount(): number {
  return groups()
    .filter((group) => group.pair)
    .reduce((sum, group) => sum + group.sentences.filter((sentence) => ready(rowFor(sentence, group.code))).length, 0);
}

function pairWords(pair: string): string {
  const base = baseLanguageOf(pair);
  const name = base ? new Intl.DisplayNames(["en"], { type: "language" }).of(base) : null;
  return name ? `from ${name}` : "";
}

function wordsHtml(sentence: BankSentence, row: Row, code: string | null, disabled: boolean): string {
  const chosen = row.word?.toLocaleLowerCase();
  let marked = false;
  return segmentWords(sentence.text, code)
    .map((token) => {
      if (!token.isWord || !/\p{L}/u.test(token.text)) return escapeHtml(token.text);
      const pressed = !marked && token.text.toLocaleLowerCase() === chosen;
      if (pressed) marked = true;
      return `<button type="button" class="cm-word" data-cm-action="word" data-id="${escapeHtml(sentence.id)}" data-word="${escapeHtml(token.text)}" aria-pressed="${pressed}"${disabled ? " disabled" : ""}>${escapeHtml(token.text)}</button>`;
    })
    .join("");
}

function rowHtml(sentence: BankSentence, group: Group): string {
  const row = rowFor(sentence, group.code);
  const disabled = !group.pair || busy;
  const id = escapeHtml(sentence.id);
  const note = row.error
    ? `<span class="text-danger">${escapeHtml(row.error)}</span>`
    : row.machine
      ? "Translated on this device. Check it before sending."
      : row.translation.trim() === "" && row.include
        ? "Needs a translation, or it stays here."
        : "";
  return `<li class="cm-row${row.include ? "" : " is-skipped"}">
    <input type="checkbox" class="cm-check" data-cm-action="include" data-id="${id}" ${row.include ? "checked" : ""}${disabled ? " disabled" : ""} aria-label="Send this sentence" />
    <div class="min-w-0 flex flex-col gap-1.5">
      <p class="cm-sentence">${wordsHtml(sentence, row, group.code, disabled)}</p>
      <input type="text" class="cm-translation" data-cm-field="translation" data-id="${id}" value="${escapeHtml(row.translation)}" placeholder="Translation" aria-label="Translation of “${escapeHtml(sentence.text)}”"${disabled ? " disabled" : ""} />
      ${note ? `<span class="text-xs text-text-muted" data-cm-note="${id}">${note}</span>` : `<span class="text-xs text-text-muted" data-cm-note="${id}"></span>`}
    </div>
  </li>`;
}

function groupHtml(group: Group): string {
  const title = `${languageFlagHtml(group.language)}<span>${escapeHtml(group.language)}</span>`;
  const meta = group.pair
    ? `<span class="font-normal text-text-muted">${escapeHtml(pairWords(group.pair))}</span><span class="cm-pair" title="The Clozemaster course these cards go to">${escapeHtml(group.pair)}</span>`
    : `<span class="font-normal text-text-muted">Clozemaster doesn't know this language, so these stay here.</span>`;
  return `<section class="flex flex-col gap-1">
    <h3 class="cm-group">${title}${meta}</h3>
    <ul class="m-0 p-0 list-none flex flex-col">${group.sentences.map((sentence) => rowHtml(sentence, group)).join("")}</ul>
  </section>`;
}

function outcomeHtml(): string {
  if (!outcome) return "";
  const link = outcome.link
    ? ` <a href="${escapeHtml(outcome.link)}" target="_blank" rel="noopener noreferrer" class="font-medium text-accent">Open in Clozemaster ↗</a>`
    : "";
  const instruction = outcome.instruction ? `<span class="block text-text-muted">${escapeHtml(outcome.instruction)}</span>` : "";
  return `<p class="cm-outcome cm-outcome--${outcome.kind}" role="status">${escapeHtml(outcome.text)}${link}${instruction}</p>`;
}

const SEND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true"><path d="M14.5 21.7a.5.5 0 0 0 .9 0L22 3.5a.5.5 0 0 0-.6-.6L3.3 9.4a.5.5 0 0 0 0 .9l7.6 3.1a2 2 0 0 1 1.1 1.1z"/><path d="m21.9 2.1-10.9 10.9"/></svg>`;

export function clozemasterSectionHtml(): string {
  if (!host) return "";
  const bank = host.bank();
  if (bank.length === 0) return "";
  const waiting = pending();

  if (!open || waiting.length === 0) {
    const sent = bank.length - waiting.length;
    const summary =
      waiting.length > 0
        ? `${plural(waiting.length, "saved sentence")} ${waiting.length === 1 ? "isn't" : "aren't"} in Clozemaster yet.`
        : `All ${plural(sent, "sentence")} are in Clozemaster.`;
    return `<section class="cm-bar">
      <span class="cm-bar-icon">${SEND_ICON}</span>
      <span class="min-w-0 flex-1 flex flex-col gap-0.5">
        <span class="text-sm font-medium text-text-primary">Clozemaster</span>
        <span class="text-xs text-text-muted">${escapeHtml(summary)}</span>
      </span>
      ${outcome && !open ? outcomeHtml() : ""}
      ${waiting.length > 0 ? `<button type="button" class="practice-grade" data-cm-action="open">Prepare ${plural(waiting.length, "card")}</button>` : ""}
    </section>`;
  }

  const count = readyCount();
  const status = translating
    ? `Translating ${translating.done} of ${translating.total} on this device…`
    : busy
      ? "Adding to Clozemaster…"
      : `${plural(count, "card")} ready.`;
  return `<section class="practice-card cm-panel" aria-label="Send to Clozemaster">
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0 flex flex-col gap-1">
        <h2 class="font-display text-[22px] font-medium m-0 flex items-center gap-2">${SEND_ICON}Send to Clozemaster</h2>
        <p class="text-sm text-text-secondary m-0">Click a word to make it the blank. Each card's note links back to the moment in the video.</p>
      </div>
      <button type="button" class="link-btn text-sm" data-cm-action="close">Close</button>
    </div>
    ${groups().map(groupHtml).join("")}
    ${outcome ? outcomeHtml() : ""}
    <div class="cm-footer">
      <label class="flex items-center gap-2 text-sm text-text-secondary">Collection
        <input type="text" class="cm-collection" data-cm-field="collection" value="${escapeHtml(collection)}" maxlength="100"${busy ? " disabled" : ""} />
      </label>
      <span class="flex-1 text-xs text-text-muted" role="status">${escapeHtml(status)}</span>
      <button type="button" class="practice-grade practice-grade--good" data-cm-action="send"${count === 0 || busy || translating ? " disabled" : ""}>Add ${plural(count, "card")}</button>
    </div>
  </section>`;
}

function translatorApi(): TranslatorApi | null {
  const api = (globalThis as { Translator?: TranslatorApi }).Translator;
  return api && typeof api.create === "function" ? api : null;
}

/** Chrome's built-in translator runs on the device; without it the person types the translation. */
async function fillTranslations(): Promise<void> {
  const api = translatorApi();
  if (!api) return;
  const jobs = groups()
    .filter((group) => group.pair && group.code)
    .flatMap((group) =>
      group.sentences
        .filter((sentence) => rowFor(sentence, group.code).translation.trim() === "")
        .map((sentence) => ({ sentence, source: group.code!, target: baseLanguageOf(group.pair!) }))
    )
    .filter((job): job is typeof job & { target: string } => Boolean(job.target) && job.target !== job.source);
  if (jobs.length === 0) return;
  translating = { done: 0, total: jobs.length };
  host?.repaint();
  const translators = new Map<string, TranslatorInstance | null>();
  for (const job of jobs) {
    const key = `${job.source}>${job.target}`;
    if (!translators.has(key)) {
      let translator: TranslatorInstance | null = null;
      try {
        const options = { sourceLanguage: job.source, targetLanguage: job.target };
        if ((await api.availability(options)) !== "unavailable") translator = await api.create(options);
      } catch {
        translator = null;
      }
      translators.set(key, translator);
    }
    const translator = translators.get(key);
    const row = rows.get(job.sentence.id);
    if (translator && row && row.translation.trim() === "") {
      try {
        row.translation = (await translator.translate(job.sentence.text)).trim();
        row.machine = row.translation !== "";
      } catch {
        // Left blank for the person to fill in.
      }
    }
    translating.done += 1;
    host?.repaint();
  }
  translators.forEach((translator) => translator?.destroy?.());
  translating = null;
  host?.repaint();
}

async function openPanel(): Promise<void> {
  open = true;
  outcome = null;
  host?.repaint();
  try {
    const response = (await browser.runtime.sendMessage({ action: "clozemaster-pairs" })) as { pairs?: string[] } | undefined;
    pairs = response?.pairs ?? [];
  } catch {
    pairs = [];
  }
  host?.repaint();
  await fillTranslations();
}

interface SendResponse {
  success?: boolean;
  bank?: BankSentence[];
  addedCount?: number;
  failed?: Array<{ id: string; error: string }>;
  collection?: { name: string; playUrl: string | null };
  errorMessage?: string;
  instruction?: string;
}

async function send(): Promise<void> {
  if (!host || busy) return;
  busy = true;
  outcome = null;
  host.repaint();
  let added = 0;
  let link: string | undefined;
  let problem: Outcome | null = null;
  for (const group of groups()) {
    if (!group.pair) continue;
    const items = group.sentences
      .filter((sentence) => ready(rowFor(sentence, group.code)))
      .map((sentence) => {
        const row = rows.get(sentence.id)!;
        return { id: sentence.id, clozeWord: row.word, translation: row.translation };
      });
    if (items.length === 0) continue;
    let response: SendResponse | undefined;
    try {
      response = (await browser.runtime.sendMessage({ action: "clozemaster-send", languagePair: group.pair, collectionName: collection, items })) as SendResponse | undefined;
    } catch (error) {
      response = { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    if (response?.bank) host.setBank(response.bank);
    added += response?.addedCount ?? 0;
    link = response?.collection?.playUrl ?? link;
    for (const failure of response?.failed ?? []) {
      const row = rows.get(failure.id);
      if (row) row.error = `Clozemaster said: ${failure.error}`;
    }
    if (!response?.success && !response?.addedCount) {
      problem = { kind: "error", text: response?.errorMessage ?? "Clozemaster didn't answer.", instruction: response?.instruction };
      break;
    }
  }
  busy = false;
  if (added > 0) outcome = { kind: "done", text: `Added ${plural(added, "card")} to “${collection}”.`, link };
  if (problem) outcome = added > 0 ? { ...problem, text: `Added ${added}, then: ${problem.text}` } : problem;
  // Stays open only while something needs the person: an error, or a card Clozemaster turned down.
  open = Boolean(problem) || pending().some((sentence) => rows.get(sentence.id)?.error);
  host.repaint();
}

export function wireClozemaster(panel: HTMLElement, clozemasterHost: ClozemasterHost): void {
  host = clozemasterHost;
  panel.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cm-action]");
    if (!target) return;
    const action = target.dataset.cmAction;
    const row = target.dataset.id ? rows.get(target.dataset.id) : undefined;
    if (action === "open") void openPanel();
    else if (action === "close") {
      open = false;
      host?.repaint();
    } else if (action === "send") void send();
    else if (action === "word" && row && target.dataset.word) {
      row.word = target.dataset.word;
      row.error = null;
      host?.repaint();
    } else if (action === "include" && row) {
      row.include = (target as HTMLInputElement).checked;
      host?.repaint();
    }
  });
  // Typing updates state without a repaint, so the field keeps its caret.
  panel.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.cmField === "collection") {
      collection = input.value.trim() || DEFAULT_COLLECTION_NAME;
      try {
        localStorage.setItem(COLLECTION_STORAGE_KEY, collection);
      } catch {
        // Only a convenience.
      }
      return;
    }
    if (input.dataset.cmField !== "translation" || !input.dataset.id) return;
    const row = rows.get(input.dataset.id);
    if (!row) return;
    row.translation = input.value;
    row.machine = false;
    row.error = null;
    const note = panel.querySelector<HTMLElement>(`[data-cm-note="${CSS.escape(input.dataset.id)}"]`);
    if (note) note.textContent = row.translation.trim() === "" ? "Needs a translation, or it stays here." : "";
    const button = panel.querySelector<HTMLButtonElement>('[data-cm-action="send"]');
    const count = readyCount();
    if (button) {
      button.textContent = `Add ${plural(count, "card")}`;
      button.disabled = count === 0 || busy || Boolean(translating);
    }
  });
  // Typed translations are kept even if the panel is closed without sending.
  panel.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.cmField !== "translation" || !input.dataset.id) return;
    void browser.runtime.sendMessage({ action: "bank-edit", edits: [{ id: input.dataset.id, translation: input.value }] }).then((response) => {
      const bank = (response as { bank?: BankSentence[] } | undefined)?.bank;
      if (bank) host?.setBank(bank);
    });
  });
}
