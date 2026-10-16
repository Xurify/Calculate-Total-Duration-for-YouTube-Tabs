/**
 * Shared input schemas for the WebMCP tools over the Alt+C capture queue, which the
 * YouTube and Clozemaster pages both expose.
 */

export interface ClearStagedCardsInput extends Record<string, unknown> {
  ids?: string[];
}

export const CLEAR_STAGED_CARDS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      items: { type: "string" },
      description: "Ids of the captured cards to remove. Omit to clear the whole queue.",
    },
  },
} as const;
