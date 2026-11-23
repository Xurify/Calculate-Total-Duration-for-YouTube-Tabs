# Study Harvester

A browser extension that turns your open YouTube tabs into a study desk.

- **Today.** The desk opens on today: how many minutes are left on your daily language goals, one button that plans a session from the languages that are behind, and a row per language with its next video.
- **All videos.** Every open tab in one list, with the time left per video. The bar of time per language filters the list; open tabs, saved sessions and the reading list are three sources of the same view. Sort videos into piles by dragging a row onto a pile, or right-clicking it.
- **Study sessions.** The chosen videos play in order and everything else is put away into a saved session.
- **Listen first.** On a YouTube video with captions, press E or the Listen first button under the player. Captions hide, the video stops after each bit of speech, and you say whether you caught it by ear, only after reading, or not at all. Missed bits are saved for review.
- **Review.** Saved sentences (missed bits and cloze cards) come back in the speaker's own voice, on a spaced schedule of 1, 3, 7, 16 and 35 days. From there they can also become cards in a Clozemaster collection (Clozemaster Pro).
- **History.** Every YouTube video you play is measured by the player itself: paused, buffering and ad time is left out. History shows minutes per day by language, and a table of today, daily goal, the chosen range and all-time hours per language. Goals ("at least") and limits ("at most") are edited there; when a limit is reached on the player, a card offers videos in other languages instead. It can be exported as CSV, backed up as JSON or turned off.
- **Time on pages for Mandala.** If you use Mandala, the toolbar badge counts the minutes a page earns for a Mandala pillar, set from the popup or from the Tracking and Mandala section at the bottom of History. Whole minutes reach Mandala on their own when a Mandala tab is open.
- **WebMCP.** YouTube, Mandala and Clozemaster pages expose tools for AI agents through the WebMCP standard.

## Development

```bash
bun install
bun run dev
```

`bun run build` writes the extension to `.output/chrome-mv3`. Load that folder in Chrome through `chrome://extensions` with Developer mode on and "Load unpacked".

## Design

One shared theme lives in `assets/theme.css`: cool near-black and soft grey surfaces with thin borders, a teal accent that also fills the main buttons, an upright serif for page headings and large numbers, and a sans for everything else. The desk has four pages (Today, All videos, Review, History); Today is a single reading column and All videos is a list with a narrow sources rail. Light, dark and system modes are switched from Settings. The icon in `public/icon/icon.svg` is the source for the PNG sizes.
