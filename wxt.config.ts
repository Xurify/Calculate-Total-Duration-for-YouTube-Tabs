import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "wxt";
import { FLAG_FILES } from "./utils/languageFlags";

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
      // Only the flags a language maps to; the full flag-icons set is ~270 files.
      for (const id of FLAG_FILES) {
        files.push({ relativeDest: `flags/${id}.svg`, absoluteSrc: resolve(`node_modules/flag-icons/flags/4x3/${id}.svg`) });
      }
    },
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
