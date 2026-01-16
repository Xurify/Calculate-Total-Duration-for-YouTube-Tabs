import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "YouTube Totalled",
    description: "Calculate total duration of all open YouTube tabs.",
    permissions: ["tabs", "scripting", "storage"],
    host_permissions: ["https://www.youtube.com/*", "https://youtube.com/*"],
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
