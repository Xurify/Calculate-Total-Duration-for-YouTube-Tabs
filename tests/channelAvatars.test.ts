import { describe, expect, test } from "bun:test";
import { avatarFromChannelHtml, avatarFromWatchHtml, sizedAvatarUrl } from "../utils/channelAvatars";

describe("channel avatars", () => {
  test("reads the uploader avatar from a watch page, unescaped and resized", () => {
    const html = `x"videoOwnerRenderer":{"thumbnail":{"thumbnails":[{"url":"https://yt3.ggpht.com/abc\\u003ds48-c-k-c0x00ffffff-no-rj","width":48}]}}`;
    expect(avatarFromWatchHtml(html)).toBe("https://yt3.ggpht.com/abc=s88-c-k-c0x00ffffff-no-rj");
  });

  test("reads og:image from a channel page", () => {
    const html = `<meta property="og:image" content="https://yt3.googleusercontent.com/xyz=s900-c-k-c0x00ffffff-no-rj">`;
    expect(avatarFromChannelHtml(html)).toBe("https://yt3.googleusercontent.com/xyz=s88-c-k-c0x00ffffff-no-rj");
  });

  test("ignores images from other hosts", () => {
    expect(avatarFromChannelHtml(`<meta property="og:image" content="https://evil.example/a.png">`)).toBeNull();
    expect(avatarFromWatchHtml("nothing here")).toBeNull();
  });

  test("leaves URLs without a size alone", () => {
    expect(sizedAvatarUrl("https://yt3.ggpht.com/abc")).toBe("https://yt3.ggpht.com/abc");
  });
});
