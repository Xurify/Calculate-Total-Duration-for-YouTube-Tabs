import "./style.css";
import { initTheme } from "../../utils/theme";
import type { ApprovalRequest } from "../../utils/approvals";

initTheme();

// Keeps the Allow button inert briefly so a keypress or click meant for the previous
// window can't land on it when this popup steals focus.
const ALLOW_ARM_DELAY_MS = 600;
const KEEPALIVE_INTERVAL_MS = 20_000;
const COPY_FEEDBACK_MS = 1500;

const approvalId = new URLSearchParams(location.search).get("id") ?? "";
const titleElement = document.getElementById("title")!;
const originElement = document.getElementById("origin")!;
const summaryElement = document.getElementById("summary")!;
const itemsElement = document.getElementById("items")!;
const itemsSection = document.getElementById("items-section")!;
const itemsCountElement = document.getElementById("items-count")!;
const copyButton = document.getElementById("copy") as HTMLButtonElement;
const allowButton = document.getElementById("allow") as HTMLButtonElement;
const denyButton = document.getElementById("deny") as HTMLButtonElement;

function resolveApproval(approved: boolean) {
  allowButton.disabled = true;
  denyButton.disabled = true;
  void browser.runtime
    .sendMessage({ action: "approval:resolve", approvalId, approved })
    .finally(() => window.close());
}

async function copyItems(items: string[]) {
  try {
    await navigator.clipboard.writeText(items.join("\n"));
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    copyButton.textContent = "Copy all";
  }, COPY_FEEDBACK_MS);
}

function render(request: ApprovalRequest) {
  document.title = `Study Harvester · ${request.title}`;
  titleElement.textContent = request.title;
  originElement.textContent = request.origin;
  summaryElement.textContent = request.summary;
  allowButton.textContent = request.confirmLabel;
  allowButton.classList.toggle("is-destructive", request.destructive);

  // Titles and URLs come from web pages, so they are only ever set as text.
  for (const itemText of request.items) {
    const listItem = document.createElement("li");
    listItem.className = "break-words";
    listItem.textContent = itemText;
    itemsElement.appendChild(listItem);
  }
  itemsCountElement.textContent = `${request.items.length} ${request.items.length === 1 ? "item" : "items"}`;
  itemsSection.classList.toggle("hidden", request.items.length === 0);
  itemsSection.classList.toggle("flex", request.items.length > 0);
  copyButton.addEventListener("click", () => void copyItems(request.items));

  window.setTimeout(() => {
    allowButton.disabled = false;
  }, ALLOW_ARM_DELAY_MS);
}

function renderExpired() {
  originElement.parentElement?.classList.add("hidden");
  document.getElementById("warning")?.classList.add("hidden");
  titleElement.textContent = "This request has expired";
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
