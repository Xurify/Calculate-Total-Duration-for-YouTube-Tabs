export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ status: "ok" });
      return;
    }

    if (message.action === "sync-all" && message.tabs) {
      handleStealthSync(message.tabs);
      sendResponse({ started: true });
      return true;
    }
  });
});

interface TabToSync {
  id: number;
  url: string;
}

async function handleStealthSync(tabs: TabToSync[]) {
  await Promise.all(
    tabs.map(async (tab) => {
      try {
        const response = await fetch(tab.url);
        const html = await response.text();

        if (html.includes("consent.youtube.com")) {
          console.warn("[Background] Hit consent page, stealth fetch restricted.");
          return;
        }

        // Try to extract the ytInitialPlayerResponse JSON for absolute reliability
        const playerResponseMatch =
          html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
          html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);

        let duration = 0;
        let title = "";
        let channel = "";
        let isLive = false;

        if (playerResponseMatch) {
          try {
            const playerResponse = JSON.parse(playerResponseMatch[1]);
            const videoDetails = playerResponse.videoDetails;
            if (videoDetails) {
              title = videoDetails.title || "";
              channel = videoDetails.author || "";

              // Priority 1: Direct isLive flag (most authoritative for CURRENTLY live)
              isLive = videoDetails.isLive === true;

              // Priority 2: Check liveBroadcastDetails - has start but no end = live
              const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
              if (liveDetails && !liveDetails.endTimestamp) {
                isLive = true;
              }

              // Priority 3: If lengthSeconds has a valid value, the stream has ended
              const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
              if (lengthSeconds > 0) {
                isLive = false;
                duration = lengthSeconds;
              }
            }
          } catch (error) {
            console.error("[Background] Failed to parse playerResponse JSON", error);
          }
        }

        // Fallbacks if JSON parsing failed
        if (duration === 0) {
          const durationMatch = html.match(/"approxDurationMs"\s*:\s*"?(\d+)"?/);
          duration = durationMatch ? parseInt(durationMatch[1]) / 1000 : 0;
        }
        if (!title) {
          const titleMatch = html.match(/<title>([^<]+)<\/title>/);
          title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";
        }
        if (!channel) {
          const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/) || html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
          channel = authorMatch ? authorMatch[1] : "";
        }

        if (duration > 0 || title || isLive) {
          browser.runtime
            .sendMessage({
              action: "tab-synced",
              tabId: tab.id,
              metadata: {
                seconds: duration,
                title: title || "Loaded Video",
                channelName: channel || "Unknown Channel",
                isLive: isLive,
              },
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error(`[Background] Error fetching ${tab.url}:`, err);
      }
    })
  );

  browser.runtime.sendMessage({ action: "sync-complete" }).catch(() => {});
}
