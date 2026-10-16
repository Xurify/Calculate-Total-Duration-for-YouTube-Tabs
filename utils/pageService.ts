/**
 * Lets the isolated content script ask the MAIN world to run code that needs the page's
 * own globals (its jQuery, session, CSRF token). Page scripts can see and answer these
 * messages too, so callers must treat results as untrusted and gate anything sensitive
 * before it gets here.
 */

const REQUEST_SOURCE = "study-harvester-page-request";
const RESPONSE_SOURCE = "study-harvester-page-response";

interface PageRequestMessage {
  source: typeof REQUEST_SOURCE;
  requestIdentifier: string;
  action: string;
  payload: unknown;
}

interface PageResponseMessage {
  source: typeof RESPONSE_SOURCE;
  requestIdentifier: string;
  result: unknown;
}

/** MAIN world. */
export function servePageRequests(handlers: Record<string, (payload: unknown) => Promise<unknown> | unknown>): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const request = event.data as PageRequestMessage | undefined;
    if (request?.source !== REQUEST_SOURCE || !request.requestIdentifier) return;
    const handler = handlers[request.action];
    if (!handler) return;

    void Promise.resolve()
      .then(() => handler(request.payload))
      .catch((error: unknown) => ({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        window.postMessage(
          { source: RESPONSE_SOURCE, requestIdentifier: request.requestIdentifier, result } satisfies PageResponseMessage,
          "*"
        );
      });
  });
}

/** Isolated world. Resolves null when the MAIN world doesn't answer in time. */
export function requestFromPage<Result>(action: string, payload: unknown, timeoutMilliseconds: number): Promise<Result | null> {
  return new Promise((resolve) => {
    const requestIdentifier = crypto.randomUUID();
    const timeoutTimer = window.setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      resolve(null);
    }, timeoutMilliseconds);

    function handleResponse(event: MessageEvent) {
      if (event.source !== window) return;
      const response = event.data as PageResponseMessage | undefined;
      if (response?.source !== RESPONSE_SOURCE || response.requestIdentifier !== requestIdentifier) return;
      window.clearTimeout(timeoutTimer);
      window.removeEventListener("message", handleResponse);
      resolve(response.result as Result);
    }

    window.addEventListener("message", handleResponse);
    window.postMessage({ source: REQUEST_SOURCE, requestIdentifier, action, payload } satisfies PageRequestMessage, "*");
  });
}
