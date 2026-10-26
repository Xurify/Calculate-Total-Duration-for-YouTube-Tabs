import { describe, expect, test } from "bun:test";
import { caughtShare, checkpointAt, checkpointText, listeningCheckpoints, recordCheck, summarizeListening } from "../utils/listening";

const sentence = (text: string, startSeconds: number, endSeconds: number) => ({ text, startSeconds, endSeconds });

describe("listeningCheckpoints", () => {
  test("joins short sentences until there is enough speech to check", () => {
    const sentences = [sentence("Áno.", 0, 0.8), sentence("Dobre.", 1, 1.8), sentence("Ideme do mesta.", 2, 4.5), sentence("Je tam veľa ľudí na námestí.", 5, 9)];
    expect(listeningCheckpoints(sentences)).toEqual([
      { firstIndex: 0, lastIndex: 2, startSeconds: 0, endSeconds: 4.5 },
      { firstIndex: 3, lastIndex: 3, startSeconds: 5, endSeconds: 9 },
    ]);
  });

  test("a short last sentence joins the one before it", () => {
    const sentences = [sentence("Dnes ideme spolu do Bratislavy.", 0, 4), sentence("Ahoj.", 4.5, 5)];
    expect(listeningCheckpoints(sentences)).toEqual([{ firstIndex: 0, lastIndex: 1, startSeconds: 0, endSeconds: 5 }]);
  });

  test("finds the checkpoint at a time and its text", () => {
    const sentences = [sentence("Prvá veta je tu.", 0, 4), sentence("Druhá veta je tu.", 4, 8)];
    const checkpoints = listeningCheckpoints(sentences);
    expect(checkpointAt(checkpoints, 2)).toBe(0);
    expect(checkpointAt(checkpoints, 6)).toBe(1);
    expect(checkpointAt(checkpoints, 9)).toBe(2);
    expect(checkpointText(sentences, checkpoints[1])).toBe("Druhá veta je tu.");
  });
});

describe("recordCheck and summarizeListening", () => {
  const video = { videoId: "abc123def45", title: "Výlet", channelName: "Lucia", language: "Slovak" };

  test("counts results per video and per language", () => {
    let log = recordCheck({}, video, "caught", 1);
    log = recordCheck(log, video, "caught", 2);
    log = recordCheck(log, video, "read", 3);
    log = recordCheck(log, { ...video, videoId: "xyz123def45", language: "Estonian" }, "missed", 4);
    const summary = summarizeListening(log);
    expect(summary.videos.map((row) => row.videoId)).toEqual(["xyz123def45", "abc123def45"]);
    expect(summary.byLanguage[0]).toEqual({ language: "Slovak", caught: 2, read: 1, missed: 0, videos: 1 });
    expect(caughtShare(summary.byLanguage[0])).toBeCloseTo(2 / 3);
  });
});
