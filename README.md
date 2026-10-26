# Study Harvester

A browser extension that turns your open YouTube tabs into a study desk.

- **Time left.** The popup and the desk show how much watching is left across your tabs, with the queue laid out as a timeline ("now, +10 min, +38 min").
- **Piles.** Sort videos into small piles such as grammar, podcasts or one course. Drag a row onto a pile, or right-click it.
- **Study sessions.** Start a focused session: the chosen videos play in order and everything else is put away into a saved session.
- **Saved sessions and reading list.** Keep sets of tabs for later and triage Chrome's reading list from the same desk.
- **Listen first.** On a YouTube video with captions, press E or the ear button. Captions hide, the video stops after each bit of speech, and you say whether you caught it by ear, only after reading, or not at all. Missed bits are saved for review.
- **Practice.** The desk's Practice page reviews saved sentences (missed bits and cloze cards) in the speaker's own voice, on a spaced schedule of 1, 3, 7, 16 and 35 days, and shows what you catch by ear per language and per video.
- **Hours of listening.** The Time page counts lifetime hours per goal language toward milestones (10, 50, 150, 300, 600, 1000, 1500 h), with hours from before the extension added by hand.
- **WebMCP.** YouTube, Mandala and Clozemaster pages expose tools for AI agents through the WebMCP standard.
- **Watch history.** Every YouTube video you play is measured by the player itself: paused, buffering and ad time is left out, and a muted tab in the background does not count. The desk's Time view shows how long you watched by day (stacked by language), by language, by channel (with channel pictures) and on a weekday-by-hour heatmap, plus playback speed, time with subtitles, time heard from another tab and finished videos. Set daily goals ("at least") and limits ("at most") per language; an eight-week calendar shows your streak of kept days. When a limit is reached on the player, a card offers unfinished videos in other languages instead. It works on its own, with or without Mandala, and can be turned off, backed up as JSON or exported as CSV with the columns you pick from the same view.
- **Time on pages for Mandala.** The toolbar badge counts the minutes a page earns for a Mandala pillar. A page counts when it is on a Mandala shelf, when its site or pile is given a pillar (from the popup, or the desk's Time view), and no other page time is kept. The tab in front counts as active; a tab making sound elsewhere, or while you are away, counts as passive. Whole minutes reach Mandala on their own when a Mandala tab is open, and the Mandala part of the Time view shows where those minutes went.

## Development

```bash
bun install
bun run dev
```

`bun run build` writes the extension to `.output/chrome-mv3`. Load that folder in Chrome through `chrome://extensions` with Developer mode on and "Load unpacked".

## Design

One shared theme lives in `assets/theme.css`: warm neutral surfaces, an amber accent, Newsreader for headings and numbers, Instrument Sans for text. Light, dark and system modes are switched from Settings. The icon in `public/icon/icon.svg` is the source for the PNG sizes.
