import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "wxt";

const ELD_DIR = resolve("node_modules/eld/src");

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
  vite: () => ({
    resolve: {
      // eld's package exports only entries with a database baked in; the core lets us load ours lazily.
      alias: { "eld/core": `${ELD_DIR}/languageDetector.js` },
    },
  }),
  hooks: {
    // Shipped as JSON and fetched on first use: parsing it takes ~0.1 s, evaluating eld's 2 MB JS module ~1 s
    // on every service worker start.
    "build:publicAssets": async (_wxt, files) => {
      const { ngramsData } = await import(pathToFileURL(`${ELD_DIR}/ngrams/medium.js`).href);
      files.push({ relativeDest: "eld/medium.json", contents: JSON.stringify(ngramsData) });
    },
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
