import { registerBridgeListener } from "../utils/webmcpBridge";
import {
  mandalaStatusFor,
  saveCachedMandalaSummary,
  shelfLinksForVideo,
  PENDING_MANDALA_LOGS_KEY,
  PENDING_MANDALA_SHELF_LINKS_KEY,
  type CachedMandalaPillar,
  type CachedMandalaShelfLink,
  type CachedMandalaSummary,
  type MandalaStatus,
  type PendingMandalaTimeLog,
  type PendingMandalaShelfLink,
} from "../utils/storage";

const MANDALA_LIBRARY_STORAGE_KEY = "mandala-library-v1";

/** Mirrors the chart shape in Mandala's src/lib/chart/model.ts. */
interface MandalaTool {
  id: string;
  url: string;
  title: string;
  kind: string;
  known?: boolean;
  action?: string;
}

interface MandalaSession {
  action: string;
  at: string;
  minutes: number;
  link?: string;
}

interface MandalaDayLog {
  focus?: string[];
  checked?: string[];
  sessions?: MandalaSession[];
  [key: string]: unknown;
}

interface MandalaChartData {
  goal?: string;
  pillars?: string[];
  actions?: string[][];
  actionIds?: string[][];
  meta?: Record<string, { kind?: string }>;
  tools?: Record<string, MandalaTool[]>;
  days?: Record<string, MandalaDayLog>;
  [key: string]: unknown;
}

interface MandalaChartRecord {
  id: string;
  updatedAt: number;
  data: MandalaChartData;
}

interface MandalaChartLibrary {
  activeId: string;
  charts: MandalaChartRecord[];
  deleted?: unknown[];
}

function readMandalaLibrary(): MandalaChartLibrary | null {
  try {
    const rawData = window.localStorage.getItem(MANDALA_LIBRARY_STORAGE_KEY);
    if (!rawData) return null;
    return JSON.parse(rawData) as MandalaChartLibrary;
  } catch {
    return null;
  }
}

function writeMandalaLibrary(library: MandalaChartLibrary): void {
  try {
    const serialized = JSON.stringify(library);
    window.localStorage.setItem(MANDALA_LIBRARY_STORAGE_KEY, serialized);
    // localStorage only fires "storage" in other tabs; this tells the open Mandala app to reload.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: MANDALA_LIBRARY_STORAGE_KEY,
        newValue: serialized,
      })
    );
  } catch (error) {
    console.warn("[Study Harvester] Failed to write Mandala library:", error);
  }
}

function getActiveChart(library: MandalaChartLibrary | null): MandalaChartRecord | null {
  if (!library || !Array.isArray(library.charts)) return null;
  const active = library.charts.find((chart) => chart.id === library.activeId);
  return active || library.charts[0] || null;
}

const TYPE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Same TypeID format as Mandala's newId: the kind, then a UUIDv7 in lowercase Crockford base32. */
function newMandalaId(kind: "tool"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = TYPE_ID_ALPHABET[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `${kind}_${suffix}`;
}

function dateKeyOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function pillarTitle(chartData: MandalaChartData, pillarIndex: number): string {
  return chartData.pillars?.[pillarIndex]?.trim() || `Pillar ${pillarIndex + 1}`;
}

function actionText(chartData: MandalaChartData, pillarIndex: number, slot: number): string {
  return chartData.actions?.[pillarIndex]?.[slot]?.trim() ?? "";
}

function extractChartSummary(chartRecord: MandalaChartRecord): CachedMandalaSummary {
  const chartData = chartRecord.data || {};
  const pillars: CachedMandalaPillar[] = [];
  const shelfLinks: CachedMandalaShelfLink[] = [];

  for (let pillarIndex = 0; pillarIndex < 8; pillarIndex++) {
    let actionCount = 0;
    for (let slot = 0; slot < 8; slot++) {
      if (actionText(chartData, pillarIndex, slot)) actionCount++;
    }
    pillars.push({
      index: pillarIndex,
      title: pillarTitle(chartData, pillarIndex),
      named: Boolean(chartData.pillars?.[pillarIndex]?.trim()),
      actionCount,
    });

    for (const tool of chartData.tools?.[`p${pillarIndex}`] || []) {
      if (!tool.url) continue;
      shelfLinks.push({
        id: tool.id,
        pillarIndex,
        title: tool.title || tool.url,
        url: tool.url,
        kind: tool.kind,
        action: tool.action,
      });
    }
  }

  return {
    activeChartId: chartRecord.id,
    activeChartTitle: chartData.goal?.trim() || "Mandala Chart",
    pillars,
    shelfLinks,
    lastUpdatedAt: Date.now(),
  };
}

async function syncMandalaSummaryToExtension(): Promise<CachedMandalaSummary | null> {
  const activeChart = getActiveChart(readMandalaLibrary());
  if (!activeChart) return null;

  const summary = extractChartSummary(activeChart);
  await saveCachedMandalaSummary(summary);
  return summary;
}

function addShelfLink(chartData: MandalaChartData, pillarIndex: number, url: string, title: string, kind?: string) {
  chartData.tools ??= {};
  const pillarKey = `p${pillarIndex}`;
  const toolsList = chartData.tools[pillarKey] || [];
  const existing = toolsList.find(
    (tool) => tool.url === url || shelfLinksForVideo([{ id: tool.id, pillarIndex, title: "", url: tool.url }], url).length > 0
  );
  if (existing) return { tool: existing, added: false };

  const tool: MandalaTool = { id: newMandalaId("tool"), url, title: title || url, kind: kind || "repeat" };
  chartData.tools[pillarKey] = [...toolsList, tool];
  return { tool, added: true };
}

/**
 * The action a shelved video's time counts toward, the way Mandala hands links out: the
 * link's own action, else a routine in its pillar, else any written action there.
 */
function resolveLogTarget(chartData: MandalaChartData, url: string) {
  const summary = extractChartSummary({ id: "", updatedAt: 0, data: chartData });
  const matches = shelfLinksForVideo(summary.shelfLinks, url);
  for (const link of matches) {
    const pillarIndex = link.pillarIndex;
    const slots = [0, 1, 2, 3, 4, 5, 6, 7].filter((slot) => actionText(chartData, pillarIndex, slot));
    const idAt = (slot: number) => chartData.actionIds?.[pillarIndex]?.[slot];
    const kindAt = (slot: number) => {
      const id = idAt(slot);
      return id ? chartData.meta?.[id]?.kind : undefined;
    };

    const slot =
      slots.find((candidate) => link.action && idAt(candidate) === link.action) ??
      slots.find((candidate) => kindAt(candidate) === "routine") ??
      slots.find((candidate) => kindAt(candidate) !== "milestone") ??
      slots[0];
    const actionId = slot === undefined ? undefined : idAt(slot);
    if (slot !== undefined && actionId) {
      return {
        actionId,
        actionText: actionText(chartData, pillarIndex, slot),
        pillarTitle: pillarTitle(chartData, pillarIndex),
        linkId: link.id,
      };
    }
  }
  return null;
}

function logMinutes(chartData: MandalaChartData, url: string, minutes: number, endedAt: number) {
  const target = resolveLogTarget(chartData, url);
  if (!target) return null;

  const end = new Date(endedAt);
  const start = new Date(endedAt - minutes * 60_000);
  const dateKey = dateKeyOf(end);
  chartData.days ??= {};
  const dayLog = chartData.days[dateKey] ?? { focus: [], checked: [] };
  chartData.days[dateKey] = {
    ...dayLog,
    sessions: [
      ...(dayLog.sessions ?? []),
      {
        action: target.actionId,
        at: dateKeyOf(start) === dateKey ? clockOf(start) : "00:00",
        minutes,
        link: target.linkId,
      },
    ],
  };
  return target;
}

async function flushPendingMandalaQueues(): Promise<void> {
  const library = readMandalaLibrary();
  const activeChart = getActiveChart(library);
  if (!library || !activeChart) return;

  let hasModifications = false;
  const storageData = await browser.storage.local.get([
    PENDING_MANDALA_SHELF_LINKS_KEY,
    PENDING_MANDALA_LOGS_KEY,
  ]);

  const pendingLinks = (storageData[PENDING_MANDALA_SHELF_LINKS_KEY] as PendingMandalaShelfLink[]) || [];
  for (const pendingLink of pendingLinks) {
    const { added } = addShelfLink(
      activeChart.data,
      pendingLink.pillarIndex,
      pendingLink.url,
      pendingLink.title,
      pendingLink.kind
    );
    hasModifications ||= added;
  }

  // Logs queued before the video was shelved, or by older versions without a url, have no action to land on.
  const pendingLogs = (storageData[PENDING_MANDALA_LOGS_KEY] as PendingMandalaTimeLog[]) || [];
  for (const pendingLog of pendingLogs) {
    if (pendingLog.url && logMinutes(activeChart.data, pendingLog.url, pendingLog.minutes, pendingLog.timestamp)) {
      hasModifications = true;
    }
  }

  await browser.storage.local.remove([PENDING_MANDALA_SHELF_LINKS_KEY, PENDING_MANDALA_LOGS_KEY]);

  if (hasModifications) {
    activeChart.updatedAt = Date.now();
    writeMandalaLibrary(library);
    await syncMandalaSummaryToExtension();
  }
}

export default defineContentScript({
  matches: [
    "https://mandalamethod.vercel.app/*",
    ...(import.meta.env.DEV ? ["http://localhost:5173/*"] : []),
  ],
  main() {
    registerBridgeListener({
      "get-open-tabs-catalog": () => browser.runtime.sendMessage({ action: "get-open-tabs-catalog" }),
      "stage-focused-study-queue": (payload) =>
        browser.runtime.sendMessage({ action: "stage-focused-study-queue", payload }),
      "get-saved-sessions": () => browser.runtime.sendMessage({ action: "get-saved-sessions" }),
      "open-saved-session": (payload) => browser.runtime.sendMessage({ action: "open-saved-session", payload }),
      "get-reading-list-catalog": () =>
        browser.runtime.sendMessage({ action: "get-reading-list-catalog" }),
      "shelve-and-clear-reading-item": (payload) =>
        browser.runtime.sendMessage({
          action: "shelve-and-clear-reading-item",
          id: (payload as { id?: string })?.id,
        }),
    });

    void syncMandalaSummaryToExtension();
    void flushPendingMandalaQueues();

    window.addEventListener("storage", (storageEvent) => {
      if (storageEvent.key === MANDALA_LIBRARY_STORAGE_KEY) {
        void syncMandalaSummaryToExtension();
      }
    });

    browser.runtime.onMessage.addListener((runtimeMessage, _sender, sendResponse) => {
      if (runtimeMessage.action === "query-mandala-shelves") {
        const activeChart = getActiveChart(readMandalaLibrary());
        if (!activeChart) {
          sendResponse({ connected: true, cached: false, pillars: [], savedPillarIndexes: [] } satisfies MandalaStatus);
          return true;
        }

        const summary = extractChartSummary(activeChart);
        void saveCachedMandalaSummary(summary);
        sendResponse(mandalaStatusFor(summary, runtimeMessage.url as string, { connected: true, cached: false }));
        return true;
      }

      if (runtimeMessage.action === "add-shelf-link") {
        const { pillarIndex, url, title, kind } = runtimeMessage as {
          pillarIndex: number;
          url: string;
          title: string;
          kind?: string;
        };

        const library = readMandalaLibrary();
        const activeChart = getActiveChart(library);
        if (!library || !activeChart) {
          sendResponse({ success: false, errorMessage: "No active Mandala chart found" });
          return true;
        }

        const { tool, added } = addShelfLink(activeChart.data, pillarIndex, url, title, kind);
        if (added) {
          activeChart.updatedAt = Date.now();
          writeMandalaLibrary(library);
          void syncMandalaSummaryToExtension();
        }
        sendResponse({ success: true, alreadyExisted: !added, linkId: tool.id });
        return true;
      }

      if (runtimeMessage.action === "log-time") {
        const { url, minutes } = runtimeMessage as { url: string; minutes: number };

        const library = readMandalaLibrary();
        const activeChart = getActiveChart(library);
        if (!library || !activeChart) {
          sendResponse({ success: false, errorMessage: "No active Mandala chart found" });
          return true;
        }

        const target = logMinutes(activeChart.data, url, minutes, Date.now());
        if (!target) {
          sendResponse({
            success: false,
            errorMessage: "Save this video to a pillar that has actions first",
          });
          return true;
        }

        activeChart.updatedAt = Date.now();
        writeMandalaLibrary(library);
        sendResponse({
          success: true,
          loggedMinutes: minutes,
          actionText: target.actionText,
          pillarTitle: target.pillarTitle,
        });
        return true;
      }
    });
  },
});
