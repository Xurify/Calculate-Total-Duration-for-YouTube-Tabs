import { describe, expect, test } from "bun:test";
import { FLAG_FILES, languageFlagId } from "../utils/languageFlags";

describe("languageFlagId", () => {
  test("maps codes and names to a country flag", () => {
    expect(languageFlagId("sk")).toBe("sk");
    expect(languageFlagId("et")).toBe("ee");
    expect(languageFlagId("Estonian")).toBe("ee");
    expect(languageFlagId("Ukrainian")).toBe("ua");
    expect(languageFlagId("EN")).toBe("gb");
  });

  test("knows names YouTube gives in another UI language", () => {
    expect(languageFlagId("slovaki")).toBe("sk");
    expect(languageFlagId("inglise")).toBe("gb");
    expect(languageFlagId("tšehhi")).toBe("cz");
    expect(languageFlagId("estónčina")).toBe("ee");
  });

  test("prefers the region a code names", () => {
    expect(languageFlagId("en-US")).toBe("us");
    expect(languageFlagId("pt_BR")).toBe("br");
  });

  test("gives no flag when the language has none", () => {
    expect(languageFlagId("Unknown language")).toBeNull();
    expect(languageFlagId("Latin")).toBeNull();
    expect(languageFlagId("")).toBeNull();
  });

  test("ships a file for every flag it can return", () => {
    for (const id of ["gb", "us", "ee", "es-ct", "gb-wls"]) expect(FLAG_FILES).toContain(id);
  });
});
