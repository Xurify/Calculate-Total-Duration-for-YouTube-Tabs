## Summary

Expands the extension into a **WebMCP Study Harvester** conforming to the W3C WebMCP standard (`document.modelContext`). This turns passive YouTube consumption into goal-aware active learning by connecting open YouTube tabs, Chrome's Reading List, and language study platforms with the [Mandala Method](https://mandalamethod.vercel.app/) goal-tracking web app (aligned with Mandala PR #15).

---

### Features & Capabilities

1. **YouTube WebMCP Tools (`world: "MAIN"`)**:
   - `youtube_get_current_video`: Deep metadata, live status, language tracks, and volume. Validates `videoId` against active URL to avoid stale SPA navigation data.
   - `youtube_get_transcript`: Resilient transcript resolver (timedtext JSON3, regex-parsed XML, DOM transcript panel, and live caption overlay fallback) with language and offset filtering. Fully compliant with YouTube's `require-trusted-types-for 'script'` CSP (no `innerHTML` or `DOMParser` injection).
   - `youtube_control_playback`: Native player controls (`play`, `pause`, `toggle`, `seek`, `set_speed`, `set_volume`, `mute`, `unmute`) via `movie_player` with `<video>` fallback. Includes strict action enum and input parameter validation.

2. **Goal-Aware Queue Planning & Guilt-Free Tab Stashing**:
   - `youtube_list_open_tabs`: Cross-tab inventory of open YouTube tabs across all windows with remaining duration and detected language.
   - `youtube_stage_study_queue`: Curates prioritized tabs and automatically stashes unselected/distraction tabs into extension storage (`SavedSession`) before closing them. Strictly validates tab IDs, prevents self-closing caller tab deadlocks, and automatically sets playback speed on the primary video.

3. **Chrome Reading List Integration (Scoped to Mandala)**:
   - `reading_list_get_unread`: Retrieves unread articles from Chrome's Reading List to match against active learning pillars.
   - `reading_list_remove_item`: Removes Reading List entries once shelved into a Mandala learning pillar shelf using `add_shelf_link`. Scoped exclusively to Mandala for security.

4. **Clozemaster Spaced-Repetition Adapter**:
   - `clozemaster_get_session`: Extracts language pair, pending reviews count, and active sentence context. Returns `null` when review count is not present to avoid confusing 0 reviews with missing selectors.
   - `clozemaster_list_collections`: Lists the user's own collections for the open language, with IDs and sentence counts.
   - `clozemaster_add_sentences`: Adds up to 50 cloze sentences to a collection chosen by ID, or by name (created if missing), through the same JSON endpoints as Clozemaster's "Add Sentence to Collection" modal, using the user's session and CSRF token. Accepts `{{word}}`, `[word]`, or a plain sentence plus `targetWord`, and reports each sentence's result. Custom collections need Clozemaster Pro.

5. **Mandala Method Unified Bridge**:
   - Content scripts registered on `https://mandalamethod.vercel.app/*` and `http://localhost:5173/*` so AI agents on Mandala have simultaneous access to Mandala chart tools (`add_shelf_link`, `update_shelf_link`, `read_shelves`, `finish_action`) and Harvester tab tools in a single context window.

---

### Architecture & Technical Details

- **Execution Context Isolation**: Double-world architecture. Main world scripts (`*.webmcp.content.ts`) register tools on `document.modelContext`; isolated scripts (`*.content.ts`) bridge requests across tabs and background APIs via a typed `window.postMessage` bus (`utils/webmcpBridge.ts`).
- **Security Hardening**: Privileged Chrome Reading List actions are restricted to Mandala domains and blocked from YouTube pages. Background script catches all async errors and propagates human-readable error messages back across the bridge.
- **Verification**: Verified with `bun run compile` (`tsc --noEmit`) and `bun run build` (WXT / Vite).
