import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "Calculate Total Duration for YouTube Tabs",
    description: "Calculate the total duration of all your open YouTube tabs.",
    permissions: ["tabs", "scripting", "storage"],
    host_permissions: ["*://*.youtube.com/*"],
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
