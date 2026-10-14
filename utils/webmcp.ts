/**
 * WebMCP (Web Model Context Protocol) Type Definitions & Registration Helpers
 * Based on the W3C Web Machine Learning Community Group specification and Chrome AI documentation.
 */

export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
  debugging?: boolean;
}

export interface WebMcpToolDefinition<
  InputArguments extends Record<string, unknown> = Record<string, unknown>,
  ExecutionResult = unknown,
> {
  name: string;
  description: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: WebMcpToolAnnotations;
  execute: (
    inputArguments: InputArguments,
    executionOptions?: { signal?: AbortSignal }
  ) => Promise<ExecutionResult> | ExecutionResult;
}

export interface WebMcpModelContext {
  registerTool: (
    tool: WebMcpToolDefinition<Record<string, unknown>, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
  unregisterTool?: (toolName: string) => Promise<void>;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<unknown[]>;
  executeTool?: (tool: unknown, inputArguments?: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }
}

/**
 * Returns true if the current environment supports WebMCP document.modelContext.
 */
export function isWebMcpSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    "modelContext" in document &&
    typeof document.modelContext?.registerTool === "function"
  );
}

/**
 * Safely registers a WebMCP tool on document.modelContext if supported.
 * Returns an unregister function that aborts the tool lifecycle.
 */
export async function registerWebMcpTool<
  InputArguments extends Record<string, unknown>,
  ExecutionResult,
>(
  tool: WebMcpToolDefinition<InputArguments, ExecutionResult>,
  parentSignal?: AbortSignal
): Promise<(() => void) | null> {
  if (!isWebMcpSupported() || !document.modelContext) {
    return null;
  }

  const abortController = new AbortController();

  if (parentSignal) {
    if (parentSignal.aborted) {
      return null;
    }
    parentSignal.addEventListener("abort", () => {
      abortController.abort();
    });
  }

  try {
    await document.modelContext.registerTool(
      tool as unknown as WebMcpToolDefinition<Record<string, unknown>, unknown>,
      { signal: abortController.signal }
    );
    return () => abortController.abort();
  } catch (error) {
    console.warn(`[WebMCP] Failed to register tool "${tool.name}":`, error);
    return null;
  }
}
