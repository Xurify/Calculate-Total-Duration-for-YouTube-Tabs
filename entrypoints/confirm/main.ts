import "./style.css";
import { initTheme } from "../../utils/theme";
import type { ApprovalRequest } from "../../utils/approvals";

initTheme();

// Keeps the Allow button inert briefly so a keypress or click meant for the previous
// window can't land on it when this popup steals focus.
const ALLOW_ARM_DELAY_MS = 600;
const KEEPALIVE_INTERVAL_MS = 20_000;

const approvalId = new URLSearchParams(location.search).get("id") ?? "";
const titleElement = document.getElementById("title")!;
const originElement = document.getElementById("origin")!;
const summaryElement = document.getElementById("summary")!;
const itemsElement = document.getElementById("items")!;
const allowButton = document.getElementById("allow") as HTMLButtonElement;
const denyButton = document.getElementById("deny") as HTMLButtonElement;

function resolveApproval(approved: boolean) {
  allowButton.disabled = true;
  denyButton.disabled = true;
  void browser.runtime
    .sendMessage({ action: "approval:resolve", approvalId, approved })
    .finally(() => window.close());
}

function render(request: ApprovalRequest) {
  document.title = `Study Harvester · ${request.title}`;
  titleElement.textContent = request.title;
  originElement.textContent = request.origin;
  summaryElement.textContent = request.summary;
  allowButton.textContent = request.confirmLabel;
  allowButton.classList.toggle("is-destructive", request.destructive);

  // Titles and URLs come from web pages, so they are only ever set as text.
  const listedItems = request.moreCount > 0 ? [...request.items, `…and ${request.moreCount} more`] : request.items;
  for (const itemText of listedItems) {
    const listItem = document.createElement("li");
    listItem.className = "truncate";
    listItem.title = itemText;
    listItem.textContent = itemText;
    itemsElement.appendChild(listItem);
  }
  itemsElement.classList.toggle("hidden", listedItems.length === 0);

  window.setTimeout(() => {
    allowButton.disabled = false;
  }, ALLOW_ARM_DELAY_MS);
}

function renderExpired() {
  titleElement.textContent = "This request has expired.";
  summaryElement.textContent = "Nothing was shared or changed. Ask the agent again if you still want this.";
  allowButton.hidden = true;
  denyButton.textContent = "Close";
  denyButton.addEventListener("click", () => window.close());
}

async function init() {
  const request = (await browser.runtime.sendMessage({
    action: "approval:get",
    approvalId,
  })) as ApprovalRequest | null;

  if (!request) {
    renderExpired();
    return;
  }

  render(request);
  allowButton.addEventListener("click", () => resolveApproval(true));
  denyButton.addEventListener("click", () => resolveApproval(false));
  denyButton.focus();

  document.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key === "Escape") resolveApproval(false);
  });

  window.setInterval(() => {
    void browser.runtime.sendMessage({ action: "approval:keepalive", approvalId });
  }, KEEPALIVE_INTERVAL_MS);
}

void init();
