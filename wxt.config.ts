import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "Study Harvester",
    description: "Turn open YouTube tabs into a study desk: see the time left, sort videos into piles, and start focused sessions.",
    permissions: ["tabs", "scripting", "storage", "readingList", "history", "idle", "alarms"],
    host_permissions: [
      "*://*.youtube.com/*",
    ],
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
