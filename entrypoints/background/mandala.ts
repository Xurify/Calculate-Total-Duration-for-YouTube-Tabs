import {
  loadCachedMandalaSummary,
  saveCachedMandalaSummary,
  mandalaStatusFor,
  shelfLinksForVideo,
  type MandalaStatus,
  PENDING_MANDALA_LOGS_KEY,
  PENDING_MANDALA_SHELF_LINKS_KEY,
  type PendingMandalaTimeLog,
  type PendingMandalaShelfLink,
} from "../../utils/storage";
import { buildApprovalRequest, ensureReadGrant, isExtensionPageSender, requestApproval } from "../../utils/approvals";
import { isMandalaUrl } from "../../utils/siteTracker";

/** Tells every open Mandala tab there is time to take; the tab asks for it and posts it to the page. */
export async function notifyMandalaTabsOfPendingTime(): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !isMandalaUrl(tab.url)) continue;
    void browser.tabs.sendMessage(tab.id, { action: "flush-time-log" }).catch(() => {});
  }
}

export interface MandalaRemoteMessage {
  op: "status" | "save" | "log";
  payload?: {
    url?: string;
    title?: string;
    pillarIndex?: unknown;
    kind?: unknown;
    minutes?: unknown;
    videoTitle?: string;
  };
}

const MAX_LOGGED_MINUTES = 24 * 60;

/**
 * The Mandala actions agents reach through the bridge. The in-player HUD keeps calling the
 * plain handlers: a click there is already the user's decision, a tool call is not.
 */
export async function handleMandalaRemote(message: MandalaRemoteMessage, sender: Browser.runtime.MessageSender) {
  const payload = message.payload ?? {};
  const url = typeof payload.url === "string" ? payload.url : "";
  if (!url) throw new Error("No video URL was supplied.");

  if (message.op === "status") {
    await ensureReadGrant(
      sender,
      "mandala-status",
      buildApprovalRequest(sender, {
        title: "Share your Mandala pillars?",
        summary: "This page wants the names of your Mandala pillars and which of them hold this video.",
        confirmLabel: "Share pillars",
        destructive: false,
      })
    );
    return { success: true, ...(await handleCheckMandalaStatus(url)) };
  }

  if (message.op === "save") {
    const pillarIndex = payload.pillarIndex;
    if (typeof pillarIndex !== "number" || !Number.isInteger(pillarIndex) || pillarIndex < 0 || pillarIndex > 7) {
      throw new Error("pillarIndex must be an integer from 0 to 7.");
    }
    const kind = payload.kind === undefined ? "repeat" : payload.kind;
    if (kind !== "repeat" && kind !== "once") {
      throw new Error('kind must be "repeat" or "once".');
    }
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : url;
    const status = await handleCheckMandalaStatus(url);
    const pillarTitle = status.pillars.find((pillar) => pillar.index === pillarIndex)?.title || `Pillar ${pillarIndex + 1}`;
    if (status.savedPillarIndexes.includes(pillarIndex)) {
      return { success: true, alreadyExisted: true, queued: false, pillarIndex, pillarTitle };
    }

    if (!isExtensionPageSender(sender)) {
      const approved = await requestApproval(
        buildApprovalRequest(sender, {
          title: `Save this video to ${pillarTitle}?`,
          summary: `This page wants to put this video on the shelf of your Mandala pillar “${pillarTitle}”${kind === "once" ? " as a one-time item" : ""}.`,
          items: [title],
          confirmLabel: "Save to shelf",
          destructive: false,
        })
      );
      if (!approved) throw new Error("The user declined to save this video to Mandala.");
    }

    const result = await handleSaveMandalaShelfLink({ pillarIndex, url, title, kind });
    return { ...result, pillarIndex, pillarTitle };
  }

  if (message.op === "log") {
    const minutes = payload.minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_LOGGED_MINUTES) {
      throw new Error(`minutes must be a number from 1 to ${MAX_LOGGED_MINUTES}.`);
    }
    const wholeMinutes = Math.round(minutes);
    const videoTitle = typeof payload.videoTitle === "string" ? payload.videoTitle : "";

    if (!isExtensionPageSender(sender)) {
      const approved = await requestApproval(
        buildApprovalRequest(sender, {
          title: `Log ${wholeMinutes} min to Mandala?`,
          summary: "This page wants to log this watch time against the Mandala action this video is shelved under.",
          items: [videoTitle || url],
          confirmLabel: "Log time",
          destructive: false,
        })
      );
      if (!approved) throw new Error("The user declined to log this time to Mandala.");
    }

    return await handleLogMandalaTime({ url, minutes: wholeMinutes, videoTitle });
  }

  throw new Error(`Unknown Mandala operation "${String(message.op)}".`);
}

async function findMandalaTab() {
  const allTabs = await browser.tabs.query({});
  return allTabs.find((candidateTab) => {
    if (!candidateTab.url) return false;
    try {
      const urlObject = new URL(candidateTab.url);
      return (
        urlObject.hostname === "mandalamethod.vercel.app" ||
        (import.meta.env.DEV && urlObject.host === "localhost:5173")
      );
    } catch {
      return false;
    }
  });
}

export async function handleCheckMandalaStatus(rawUrl: string): Promise<MandalaStatus> {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "query-mandala-shelves",
        url: rawUrl,
      })) as MandalaStatus | undefined;
      if (tabResponse && typeof tabResponse === "object") {
        return tabResponse;
      }
    } catch {
      // Tab may still be initializing; fall back to cache
    }
  }

  const cachedSummary = await loadCachedMandalaSummary();
  if (!cachedSummary) {
    return { connected: false, cached: false, pillars: [], savedPillarIndexes: [] };
  }
  return mandalaStatusFor(cachedSummary, rawUrl, { connected: false, cached: true });
}

export async function handleSaveMandalaShelfLink(payload: {
  pillarIndex: number;
  url: string;
  title: string;
  kind?: string;
  action?: string;
}) {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "add-shelf-link",
        ...payload,
      })) as { success?: boolean; errorMessage?: string } | undefined;
      if (tabResponse?.success) return { success: true, queued: false };
      if (tabResponse) return { success: false, errorMessage: tabResponse.errorMessage };
    } catch {
      // Tab communication failed; fall through to queued write
    }
  }

  const pendingData = await browser.storage.local.get(PENDING_MANDALA_SHELF_LINKS_KEY);
  const existingQueue = (pendingData[PENDING_MANDALA_SHELF_LINKS_KEY] as PendingMandalaShelfLink[]) || [];
  const newEntry: PendingMandalaShelfLink = {
    id: crypto.randomUUID(),
    pillarIndex: payload.pillarIndex,
    url: payload.url,
    title: payload.title,
    kind: payload.kind,
    action: payload.action,
    timestamp: Date.now(),
  };
  await browser.storage.local.set({
    [PENDING_MANDALA_SHELF_LINKS_KEY]: [...existingQueue, newEntry],
  });

  // Until the Mandala tab flushes the queue, the cache is what the player reads its shelves from.
  const cachedSummary = await loadCachedMandalaSummary();
  if (cachedSummary) {
    const existing = shelfLinksForVideo(cachedSummary.shelfLinks, payload.url).find((link) => link.pillarIndex === payload.pillarIndex);
    await saveCachedMandalaSummary({
      ...cachedSummary,
      shelfLinks: existing
        ? cachedSummary.shelfLinks.map((link) => (link === existing && payload.action ? { ...link, action: payload.action } : link))
        : [
            ...cachedSummary.shelfLinks,
            { id: newEntry.id, pillarIndex: payload.pillarIndex, title: payload.title, url: payload.url, kind: payload.kind, action: payload.action },
          ],
    });
  }

  return { success: true, queued: true };
}

export async function handleLogMandalaTime(payload: { url: string; minutes: number; videoTitle: string }) {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "log-time",
        ...payload,
      })) as { success?: boolean; errorMessage?: string; actionText?: string; pillarTitle?: string } | undefined;
      if (tabResponse) return { ...tabResponse, success: Boolean(tabResponse.success), queued: false, minutes: payload.minutes };
    } catch {
      // Tab communication failed; fall through to queued write
    }
  }

  const cachedSummary = await loadCachedMandalaSummary();
  if (cachedSummary && shelfLinksForVideo(cachedSummary.shelfLinks, payload.url).length === 0) {
    return { success: false, errorMessage: "Save this video to a pillar first" };
  }

  const pendingData = await browser.storage.local.get(PENDING_MANDALA_LOGS_KEY);
  const existingQueue = (pendingData[PENDING_MANDALA_LOGS_KEY] as PendingMandalaTimeLog[]) || [];
  const newEntry: PendingMandalaTimeLog = {
    id: crypto.randomUUID(),
    url: payload.url,
    minutes: payload.minutes,
    videoTitle: payload.videoTitle,
    timestamp: Date.now(),
  };
  await browser.storage.local.set({
    [PENDING_MANDALA_LOGS_KEY]: [...existingQueue, newEntry],
  });

  return { success: true, queued: true, minutes: payload.minutes };
}
