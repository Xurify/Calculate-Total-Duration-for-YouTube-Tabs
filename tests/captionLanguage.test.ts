import { describe, expect, test } from "bun:test";
import { languageNamedInTitle } from "../utils/captionLanguage";

describe("languageNamedInTitle", () => {
  test("reads the language a lesson title names", () => {
    expect(languageNamedInTitle("Parts of the City in Slovak 🏙️😀")).toBe("sk");
    expect(languageNamedInTitle("Learn Estonian: numbers 1-10")).toBe("et");
    expect(languageNamedInTitle("50 Slovak phrases for travel")).toBe("sk");
  });

  test("ignores countries and titles that name no language", () => {
    expect(languageNamedInTitle("Life in Slovakia as a foreigner")).toBeNull();
    expect(languageNamedInTitle("Investigating The Czechia Tourists Never See")).toBeNull();
    expect(languageNamedInTitle("Why the best software must LIE to you")).toBeNull();
  });
});
