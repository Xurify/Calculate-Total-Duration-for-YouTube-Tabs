import { mkdir } from "node:fs/promises";
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
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+Y" },
        description: "Open the popup",
      },
      "open-desk": {
        suggested_key: { default: "Alt+Shift+D" },
        description: "Open the desk",
      },
    },
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
      // Only the flags a language maps to; the full flag-icons set is ~270 files. Flags show at 16×12 at most, and
      // some SVGs carry a detailed coat of arms (Serbia's is 180 KB), so they ship as 3× PNGs instead.
      const sharp = (await import("sharp")).default;
      const flagDir = resolve("node_modules/.cache/flags");
      await mkdir(flagDir, { recursive: true });
      for (const id of FLAG_FILES) {
        const png = resolve(flagDir, `${id}.png`);
        await sharp(resolve(`node_modules/flag-icons/flags/4x3/${id}.svg`), { density: 72 })
          .resize(48, 36, { fit: "fill" })
          .png({ compressionLevel: 9, palette: true, quality: 90 })
          .toFile(png);
        files.push({ relativeDest: `flags/${id}.png`, absoluteSrc: png });
      }
    },
  },
  dev: {
    server: {
      port: 3001,
    },
  },
});
