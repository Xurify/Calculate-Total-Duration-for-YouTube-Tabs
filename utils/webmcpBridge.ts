/**
 * Secure postMessage bridge between MAIN world (WebMCP) and ISOLATED world (Extension APIs).
 */

export const BRIDGE_SOURCE_MAIN = "webmcp-study-harvester-main";
export const BRIDGE_SOURCE_ISOLATED = "webmcp-study-harvester-isolated";

export interface BridgeRequestMessage<Payload = unknown> {
  source: typeof BRIDGE_SOURCE_MAIN;
  requestIdentifier: string;
  action: string;
  payload: Payload;
}

export interface BridgeResponseMessage<Result = unknown> {
  source: typeof BRIDGE_SOURCE_ISOLATED;
  requestIdentifier: string;
  success: boolean;
  result?: Result;
  errorMessage?: string;
}

const BRIDGE_TIMEOUT_MILLISECONDS = 15000;

/**
 * Dispatches a request from the MAIN world to the ISOLATED world and awaits the response.
 */
export function sendBridgeRequest<RequestPayload, ResponseResult>(
  action: string,
  payload: RequestPayload
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const requestIdentifier =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeoutTimer = window.setTimeout(() => {
      window.removeEventListener("message", messageHandler);
      reject(new Error(`Bridge request "${action}" timed out after ${BRIDGE_TIMEOUT_MILLISECONDS}ms`));
    }, BRIDGE_TIMEOUT_MILLISECONDS);

    function messageHandler(event: MessageEvent) {
      if (event.source !== window || !event.data) {
        return;
      }

      const responseMessage = event.data as BridgeResponseMessage<ResponseResult>;
      if (
        responseMessage.source === BRIDGE_SOURCE_ISOLATED &&
        responseMessage.requestIdentifier === requestIdentifier
      ) {
        window.clearTimeout(timeoutTimer);
        window.removeEventListener("message", messageHandler);

        if (responseMessage.success) {
          resolve(responseMessage.result as ResponseResult);
        } else {
          reject(new Error(responseMessage.errorMessage || `Bridge request "${action}" failed`));
        }
      }
    }

    window.addEventListener("message", messageHandler);
    window.postMessage(
      {
        source: BRIDGE_SOURCE_MAIN,
        requestIdentifier,
        action,
        payload,
      } satisfies BridgeRequestMessage<RequestPayload>,
      "*"
    );
  });
}

export type BridgeActionHandler = (
  payload: unknown
) => Promise<unknown> | unknown;

/**
 * Registers an action listener in the ISOLATED world to handle requests from the MAIN world.
 * Returns an unregister cleanup function.
 */
export function registerBridgeListener(
  handlers: Record<string, BridgeActionHandler>
): () => void {
  function messageHandler(event: MessageEvent) {
    if (event.source !== window || !event.data) {
      return;
    }

    const request = event.data as BridgeRequestMessage;
    if (request.source !== BRIDGE_SOURCE_MAIN || !request.requestIdentifier || !request.action) {
      return;
    }

    const handler = handlers[request.action];
    if (!handler) {
      window.postMessage(
        {
          source: BRIDGE_SOURCE_ISOLATED,
          requestIdentifier: request.requestIdentifier,
          success: false,
          errorMessage: `Unknown bridge action: ${request.action}`,
        } satisfies BridgeResponseMessage,
        "*"
      );
      return;
    }

    Promise.resolve()
      .then(() => handler(request.payload))
      .then((result) => {
        window.postMessage(
          {
            source: BRIDGE_SOURCE_ISOLATED,
            requestIdentifier: request.requestIdentifier,
            success: true,
            result,
          } satisfies BridgeResponseMessage,
          "*"
        );
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        window.postMessage(
          {
            source: BRIDGE_SOURCE_ISOLATED,
            requestIdentifier: request.requestIdentifier,
            success: false,
            errorMessage,
          } satisfies BridgeResponseMessage,
          "*"
        );
      });
  }

  window.addEventListener("message", messageHandler);
  return () => {
    window.removeEventListener("message", messageHandler);
  };
}
