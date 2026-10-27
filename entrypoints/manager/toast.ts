

interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

const TOAST_MS = 3000;
// Long enough to read the message and reach the button after a misclick.
const UNDO_TOAST_MS = 8000;

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
export function showToast(message: string, action?: ToastAction) {
  const el = document.getElementById("toast");
  if (!el) return;
  const text = document.createElement("span");
  text.textContent = message;
  el.replaceChildren(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.title = `${action.label} (Z)`;
    button.setAttribute("aria-keyshortcuts", "z");
    button.addEventListener("click", () => {
      hideToast();
      void action.run();
    });
    el.append(button);
  }
  el.classList.remove("hidden", "opacity-0", "pointer-events-none");
  el.classList.add("animate-in", "fade-in");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(hideToast, action ? UNDO_TOAST_MS : TOAST_MS);
}

function hideToast(): void {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = null;
  document.getElementById("toast")?.classList.add("opacity-0", "pointer-events-none");
}
