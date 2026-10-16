/**
 * User approval for actions that web pages can reach through the WebMCP bridge.
 *
 * The MAIN-world bridge cannot tell our tool code apart from any other script on the
 * page (YouTube's ad scripts, or anything on the Mandala origin), so the bridge alone
 * is not a trust boundary. Approval happens in an extension window instead, which page
 * scripts can neither read nor click.
 */

export const APPROVAL_PAGE_PATH = "/confirm.html";
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_LISTED_ITEMS = 8;

export interface ApprovalRequest {
  title: string;
  origin: string;
  summary: string;
  items: string[];
  moreCount: number;
  confirmLabel: string;
  destructive: boolean;
}

type Sender = Browser.runtime.MessageSender;

interface PendingApproval {
  request: ApprovalRequest;
  settle: (approved: boolean) => void;
  windowId?: number;
}

const pendingApprovals = new Map<string, PendingApproval>();
const readGrants = new Set<string>();
let listenersAttached = false;

export function isExtensionPageSender(sender: Sender): boolean {
  return Boolean(sender.url?.startsWith(browser.runtime.getURL("/")));
}

function isApprovalPageSender(sender: Sender): boolean {
  return Boolean(sender.url?.startsWith(browser.runtime.getURL(APPROVAL_PAGE_PATH)));
}

function senderOrigin(sender: Sender): string {
  if (sender.origin) return sender.origin;
  try {
    return new URL(sender.url ?? "").origin;
  } catch {
    return "an unknown page";
  }
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  browser.windows.onRemoved.addListener((windowId) => {
    for (const pending of pendingApprovals.values()) {
      if (pending.windowId === windowId) pending.settle(false);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    for (const grant of readGrants) {
      if (grant.includes(`|tab:${tabId}|`)) readGrants.delete(grant);
    }
  });
}

export function buildApprovalRequest(
  sender: Sender,
  fields: Omit<ApprovalRequest, "origin" | "items" | "moreCount"> & { items?: string[] }
): ApprovalRequest {
  const items = fields.items ?? [];
  return {
    ...fields,
    origin: senderOrigin(sender),
    items: items.slice(0, MAX_LISTED_ITEMS),
    moreCount: Math.max(0, items.length - MAX_LISTED_ITEMS),
  };
}

export async function requestApproval(request: ApprovalRequest): Promise<boolean> {
  attachListeners();
  const approvalId = crypto.randomUUID();

  return new Promise<boolean>((resolve) => {
    const timeoutTimer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);

    function settle(approved: boolean) {
      const pending = pendingApprovals.get(approvalId);
      if (!pending) return;
      pendingApprovals.delete(approvalId);
      clearTimeout(timeoutTimer);
      if (pending.windowId !== undefined) {
        void browser.windows.remove(pending.windowId).catch(() => {});
      }
      resolve(approved);
    }

    pendingApprovals.set(approvalId, { request, settle });

    browser.windows
      .create({
        url: browser.runtime.getURL(`${APPROVAL_PAGE_PATH}?id=${approvalId}`),
        type: "popup",
        width: 440,
        height: 520,
        focused: true,
      })
      .then((createdWindow) => {
        const pending = pendingApprovals.get(approvalId);
        if (pending) pending.windowId = createdWindow?.id;
      })
      .catch(() => settle(false));
  });
}

/**
 * Asks once per page document; later reads from the same document reuse the grant.
 * YouTube navigates as an SPA, so one grant covers a YouTube tab until it reloads.
 */
export async function ensureReadGrant(
  sender: Sender,
  scope: "open-tabs" | "reading-list" | "clozemaster-collections",
  request: ApprovalRequest
): Promise<void> {
  if (isExtensionPageSender(sender)) return;

  const documentKey = sender.documentId ?? senderOrigin(sender);
  const grantKey = `${scope}|tab:${sender.tab?.id ?? "none"}|${documentKey}`;
  if (readGrants.has(grantKey)) return;

  if (!(await requestApproval(request))) {
    const shared = { "open-tabs": "open tabs", "reading-list": "the Reading List", "clozemaster-collections": "Clozemaster collections" };
    throw new Error(`The user declined to share ${shared[scope]} with this page.`);
  }
  readGrants.add(grantKey);
}

/**
 * Answers messages from the approval window. Returns true when the message was handled.
 */
export function handleApprovalPageMessage(
  message: { action?: string; approvalId?: string; approved?: boolean },
  sender: Sender,
  sendResponse: (response: unknown) => void
): boolean {
  if (!message.action?.startsWith("approval:")) return false;
  if (!isApprovalPageSender(sender) || typeof message.approvalId !== "string") {
    sendResponse(null);
    return true;
  }

  const pending = pendingApprovals.get(message.approvalId);
  if (message.action === "approval:get") {
    sendResponse(pending?.request ?? null);
  } else if (message.action === "approval:resolve") {
    pending?.settle(message.approved === true);
    sendResponse({ ok: true });
  } else {
    // approval:keepalive — any message resets the MV3 service worker idle timer.
    sendResponse({ alive: Boolean(pending) });
  }
  return true;
}
