import { registerBridgeListener } from "../utils/webmcpBridge";
import {
  saveCachedMandalaSummary,
  normalizeYoutubeUrl,
  PENDING_MANDALA_LOGS_KEY,
  PENDING_MANDALA_SHELF_LINKS_KEY,
  type CachedMandalaPillar,
  type CachedMandalaShelfLink,
  type CachedMandalaSummary,
  type PendingMandalaTimeLog,
  type PendingMandalaShelfLink,
} from "../utils/storage";
import { getVideoIdFromUrl } from "../utils/format";

const MANDALA_LIBRARY_STORAGE_KEY = "mandala-library-v1";

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
}

interface MandalaDayLog {
  focus?: string[];
  checked?: string[];
  sessions?: MandalaSession[];
}

interface MandalaChartData {
  g?: string;
  p0?: string;
  p1?: string;
  p2?: string;
  p3?: string;
  p4?: string;
  p5?: string;
  p6?: string;
  p7?: string;
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

function generateMandalaId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function getTodayDateKey(): string {
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, "0");
  const day = String(currentDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentTimeKey(): string {
  const currentDate = new Date();
  const hours = String(currentDate.getHours()).padStart(2, "0");
  const minutes = String(currentDate.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function extractChartSummary(chartRecord: MandalaChartRecord): CachedMandalaSummary {
  const chartData = chartRecord.data || {};
  const activeChartTitle = chartData.g?.trim() || "Mandala Chart";

  const pillars: CachedMandalaPillar[] = [];
  const shelfLinks: CachedMandalaShelfLink[] = [];

  for (let pillarIndex = 0; pillarIndex < 8; pillarIndex++) {
    const pillarKey = `p${pillarIndex}` as keyof MandalaChartData;
    const pillarTitle = (chartData[pillarKey] as string)?.trim() || `Pillar ${pillarIndex + 1}`;

    let actionCount = 0;
    for (let slotIndex = 0; slotIndex < 8; slotIndex++) {
      const actionKey = `a${pillarIndex}_${slotIndex}`;
      if (typeof chartData[actionKey] === "string" && chartData[actionKey].trim()) {
        actionCount++;
      }
    }

    pillars.push({
      index: pillarIndex,
      title: pillarTitle,
      actionCount,
    });

    const toolsForPillar = chartData.tools?.[`p${pillarIndex}`] || [];
    for (const tool of toolsForPillar) {
      if (tool.url) {
        shelfLinks.push({
          id: tool.id,
          pillarIndex,
          title: tool.title || tool.url,
          url: tool.url,
          kind: tool.kind,
        });
      }
    }
  }

  return {
    activeChartId: chartRecord.id,
    activeChartTitle,
    pillars,
    shelfLinks,
    lastUpdatedAt: Date.now(),
  };
}

async function syncMandalaSummaryToExtension(): Promise<CachedMandalaSummary | null> {
  const library = readMandalaLibrary();
  const activeChart = getActiveChart(library);
  if (!activeChart) return null;

  const summary = extractChartSummary(activeChart);
  await saveCachedMandalaSummary(summary);
  return summary;
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
  if (pendingLinks.length > 0) {
    if (!activeChart.data.tools) {
      activeChart.data.tools = {};
    }

    for (const pendingLink of pendingLinks) {
      const pillarKey = `p${pendingLink.pillarIndex}`;
      const existingTools = activeChart.data.tools[pillarKey] || [];
      const alreadyExists = existingTools.some(
        (existingTool) => existingTool.url === pendingLink.url
      );

      if (!alreadyExists) {
        existingTools.push({
          id: generateMandalaId("tool"),
          url: pendingLink.url,
          title: pendingLink.title,
          kind: pendingLink.kind || "repeat",
        });
        activeChart.data.tools[pillarKey] = existingTools;
        hasModifications = true;
      }
    }

    await browser.storage.local.remove(PENDING_MANDALA_SHELF_LINKS_KEY);
  }

  const pendingLogs = (storageData[PENDING_MANDALA_LOGS_KEY] as PendingMandalaTimeLog[]) || [];
  if (pendingLogs.length > 0) {
    if (!activeChart.data.days) {
      activeChart.data.days = {};
    }
    const todayKey = getTodayDateKey();
    const dayLog = activeChart.data.days[todayKey] || {};
    const existingSessions = dayLog.sessions || [];

    for (const pendingLog of pendingLogs) {
      existingSessions.push({
        action: pendingLog.actionId || "a0_0",
        at: getCurrentTimeKey(),
        minutes: pendingLog.minutes,
      });
      hasModifications = true;
    }

    dayLog.sessions = existingSessions;
    activeChart.data.days[todayKey] = dayLog;

    await browser.storage.local.remove(PENDING_MANDALA_LOGS_KEY);
  }

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
      "get-reading-list-catalog": () =>
        browser.runtime.sendMessage({ action: "get-reading-list-catalog" }),
      "shelve-and-clear-reading-item": (payload) =>
        browser.runtime.sendMessage({
          action: "shelve-and-clear-reading-item",
          url: (payload as { url: string })?.url,
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
        const library = readMandalaLibrary();
        const activeChart = getActiveChart(library);
        if (!activeChart) {
          sendResponse({
            connected: true,
            cached: false,
            pillars: [],
          });
          return true;
        }

        const summary = extractChartSummary(activeChart);
        void saveCachedMandalaSummary(summary);

        const targetUrl = runtimeMessage.url as string;
        const normalizedTargetUrl = normalizeYoutubeUrl(targetUrl);
        const targetVideoId = getVideoIdFromUrl(normalizedTargetUrl);

        const matchedLink = summary.shelfLinks.find((shelfLink) => {
          const normalizedLinkUrl = normalizeYoutubeUrl(shelfLink.url);
          if (normalizedLinkUrl === normalizedTargetUrl) return true;
          const linkVideoId = getVideoIdFromUrl(normalizedLinkUrl);
          return Boolean(targetVideoId && linkVideoId && targetVideoId === linkVideoId);
        });

        const matchedPillar = matchedLink
          ? summary.pillars.find((pillar) => pillar.index === matchedLink.pillarIndex)
          : undefined;

        sendResponse({
          connected: true,
          cached: false,
          activeChartTitle: summary.activeChartTitle,
          matchedShelfItem: matchedLink
            ? {
                pillarIndex: matchedLink.pillarIndex,
                pillarTitle: matchedPillar?.title || `Pillar ${matchedLink.pillarIndex + 1}`,
                linkId: matchedLink.id,
                toolTitle: matchedLink.title,
              }
            : undefined,
          pillars: summary.pillars,
        });
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

        if (!activeChart.data.tools) {
          activeChart.data.tools = {};
        }

        const pillarKey = `p${pillarIndex}`;
        const toolsList = activeChart.data.tools[pillarKey] || [];
        const alreadyExists = toolsList.some((existingTool) => existingTool.url === url);

        if (alreadyExists) {
          sendResponse({ success: true, alreadyExisted: true });
          return true;
        }

        const newTool: MandalaTool = {
          id: generateMandalaId("tool"),
          url,
          title: title || url,
          kind: kind || "repeat",
        };

        toolsList.push(newTool);
        activeChart.data.tools[pillarKey] = toolsList;
        activeChart.updatedAt = Date.now();

        writeMandalaLibrary(library);
        void syncMandalaSummaryToExtension();

        sendResponse({ success: true, linkId: newTool.id });
        return true;
      }

      if (runtimeMessage.action === "log-time") {
        const { actionId, minutes, linkId } = runtimeMessage as {
          actionId?: string;
          minutes: number;
          linkId?: string;
        };

        const library = readMandalaLibrary();
        const activeChart = getActiveChart(library);
        if (!library || !activeChart) {
          sendResponse({ success: false, errorMessage: "No active Mandala chart found" });
          return true;
        }

        if (!activeChart.data.days) {
          activeChart.data.days = {};
        }

        const todayKey = getTodayDateKey();
        const dayLog = activeChart.data.days[todayKey] || {};
        const sessions = dayLog.sessions || [];

        let resolvedActionId = actionId;
        if (!resolvedActionId) {
          resolvedActionId = "a0_0";
        }

        sessions.push({
          action: resolvedActionId,
          at: getCurrentTimeKey(),
          minutes,
        });

        dayLog.sessions = sessions;
        activeChart.data.days[todayKey] = dayLog;
        activeChart.updatedAt = Date.now();

        writeMandalaLibrary(library);

        sendResponse({ success: true, loggedMinutes: minutes, actionId: resolvedActionId, linkId });
        return true;
      }
    });
  },
});
