import { describe, expect, test } from "bun:test";
import { detectLanguageFromPlayerResponse, languageNamedInTitle } from "../utils/captionLanguage";

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

describe("detectLanguageFromPlayerResponse", () => {
  const frenchAsr = { kind: "asr", languageCode: "fr", name: { simpleText: "French (auto-generated)" } };
  const singleAudio = { audioTracks: [{ defaultCaptionTrackIndex: 0 }], defaultAudioTrackIndex: 0 };

  test("a default caption track from speech recognition is only a guess", () => {
    const detected = detectLanguageFromPlayerResponse({
      videoDetails: { title: "GLAZBA: Dani su bez broja, Magazin, Esma Redžepova" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [frenchAsr], ...singleAudio } },
    });
    expect(detected).toEqual({ language: "fr", languageName: "French", weak: true });
  });

  test("the uploader's audio language still beats that guess", () => {
    const detected = detectLanguageFromPlayerResponse({
      videoDetails: { defaultAudioLanguageCode: "hr" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [frenchAsr, { languageCode: "hr", name: { simpleText: "Croatian" } }],
          ...singleAudio,
        },
      },
    });
    expect(detected).toEqual({ language: "hr", languageName: "Croatian" });
  });

  test("a default caption track someone uploaded is trusted", () => {
    const detected = detectLanguageFromPlayerResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "sk", name: { simpleText: "Slovak" } }],
          ...singleAudio,
        },
      },
    });
    expect(detected).toEqual({ language: "sk", languageName: "Slovak" });
  });
});
