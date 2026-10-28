import type { TimeTrackingPrefs } from "../../../utils/timeLog";
import { formatMinutesWords } from "../../../utils/timeUi";
import type { WatchSummary, WatchVideoRow } from "../../../utils/watchLog";
import { app } from "../state";
import { channelAvatarHtml } from "../avatars";
import {
  CHEVRON_RIGHT_ICON,
  colorOfLanguage,
  hourWords,
  languageColorMap,
  languageMarkHtml,
  longDate,
  plural,
  shareWords,
  speedWords,
  timeAgoWords,
  timeSectionHeading,
  watchStatTile,
  WEEKDAY_NAMES,
  weekdayShort,
} from "./html";
import {
  CHANNEL_ROWS,
  CHANNEL_TOOLTIP_TITLES,
  dayChartMode,
  HEAT_LEVELS,
  openChannel,
  showAllChannels,
  timeRange,
  VIDEO_ROWS_PAGE,
  videoRowsShown,
} from "./panel";
import { escapeHtml } from "../util";

function watchVideoRowHtml(video: WatchVideoRow, colors: Map<string, string>): string {
  const url = video.isShort ? `https://www.youtube.com/shorts/${encodeURIComponent(video.videoId)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
  const progress = video.isLive ? "Live" : video.durationSeconds > 0 ? shareWords(video.coverage, 1) : "";
  const speed = video.playedSeconds > 0 ? video.videoSeconds / video.playedSeconds : 1;
  const faster = !video.isLive && Math.abs(speed - 1) >= 0.05;
  return `<li class="grid grid-cols-[4rem_minmax(0,1fr)_3.5rem_3rem_5.5rem] items-center gap-3 min-w-0 text-sm">
    <img src="https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/mqdefault.jpg" alt="" loading="lazy" class="w-16 h-9 rounded object-cover bg-surface-hover manager-card-thumb" />
    <span class="min-w-0 flex flex-col">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="truncate text-text-primary no-underline hover:text-accent" title="${escapeHtml(video.title || video.videoId)}">${escapeHtml(video.title || video.videoId)}</a>
      <span class="truncate text-xs text-text-muted flex items-center gap-1.5">${languageMarkHtml(video.language, colorOfLanguage(colors, video.language))}<span class="truncate">${escapeHtml([video.channelName, video.language, timeAgoWords(video.lastAt)].filter(Boolean).join(" · "))}</span></span>
    </span>
    <span class="justify-self-start">${faster ? `<span class="speed-chip" title="${escapeHtml(`${formatMinutesWords(video.videoSeconds)} of video in ${formatMinutesWords(video.playedSeconds)}`)}">${speedWords(speed)}</span>` : ""}</span>
    <span class="text-right text-xs text-text-muted tabular-nums" title="${video.durationSeconds > 0 ? `Seen ${progress} of ${formatMinutesWords(video.durationSeconds)}` : ""}">${progress}</span>
    <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(video.playedSeconds)}</span>
  </li>`;
}

function dayBarsHtml(watch: WatchSummary, colors: Map<string, string>): string {
  const peakDay = Math.max(60, ...watch.days.map((day) => day.seconds));
  const dense = watch.days.length > 30;
  const byLanguage = dayChartMode === "language";
  const order = watch.byLanguage.map((row) => row.label);
  const bars = watch.days
    .map((day, index) => {
      const behind = Math.max(0, day.seconds - day.visible);
      const segments = byLanguage
        ? order
            .filter((label) => (day.languages[label] ?? 0) > 0)
            .map((label) => `<div class="w-full shrink-0 ${dense ? "" : "rounded-[3px]"}" style="height:${((day.languages[label] / peakDay) * 100).toFixed(2)}%;background:${colorOfLanguage(colors, label)}"></div>`)
            .join("")
        : `<div class="w-full shrink-0 bg-accent ${dense ? "" : "rounded-[3px]"}" style="height:${((day.visible / peakDay) * 100).toFixed(2)}%"></div><div class="w-full shrink-0 bg-accent/35 ${dense ? "" : "rounded-[3px]"}" style="height:${((behind / peakDay) * 100).toFixed(2)}%"></div>`;
      const breakdown = byLanguage
        ? order.filter((label) => (day.languages[label] ?? 0) >= 60).map((label) => `${label}: ${formatMinutesWords(day.languages[label])}`)
        : [`On screen: ${formatMinutesWords(day.visible)}`, ...(behind >= 60 ? [`Background: ${formatMinutesWords(behind)}`] : [])];
      const tip = [`${longDate(day.key)}: ${formatMinutesWords(day.seconds)}`, ...breakdown].join("\n");
      const label = timeRange === 7 ? weekdayShort(day.key) : !dense || index % 15 === 0 ? day.key.slice(dense ? 5 : 8) : "";
      return `<div class="flex flex-col items-center gap-1.5 min-w-0" title="${escapeHtml(tip)}">
        <div class="w-full h-40 flex flex-col-reverse ${dense ? "" : "gap-[2px]"} rounded-md bg-surface-elevated overflow-hidden">${segments}</div>
        <span class="text-[11px] text-text-muted tabular-nums whitespace-nowrap">${label || "&nbsp;"}</span>
        ${dense ? "" : `<span class="font-display text-[13px] text-text-secondary tabular-nums whitespace-nowrap">${day.seconds >= 60 ? formatMinutesWords(day.seconds) : "·"}</span>`}
      </div>`;
    })
    .join("");
  const legend = byLanguage
    ? watch.byLanguage
        .map((row) => `<span class="flex items-center gap-1.5">${languageMarkHtml(row.label, colorOfLanguage(colors, row.label))}${escapeHtml(row.label)}</span>`)
        .join("")
    : `<span class="flex items-center gap-1.5"><span class="legend-swatch bg-accent"></span>On screen</span><span class="flex items-center gap-1.5"><span class="legend-swatch bg-accent/35"></span>Background</span>`;
  const modeHtml = `<span class="inline-flex gap-0.5 p-0.5 rounded-lg border border-border bg-surface" role="group" aria-label="Split days by">
    <button type="button" class="time-day-mode budget-chip" data-mode="language" aria-pressed="${byLanguage}">Language</button>
    <button type="button" class="time-day-mode budget-chip" data-mode="screen" aria-pressed="${!byLanguage}">Screen</button>
  </span>`;
  const busiest = watch.days.reduce((best, day) => (day.seconds > best.seconds ? day : best), watch.days[0]);
  const busiestHtml = busiest && busiest.seconds >= 60 ? `<span class="text-xs text-text-muted">Most on ${escapeHtml(longDate(busiest.key))}</span>` : "";
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("By day", `${busiestHtml}${modeHtml}`, "day")}
    <div class="grid ${dense ? "gap-px" : "gap-2"}" style="grid-template-columns: repeat(${watch.days.length}, minmax(0, 1fr))">${bars}</div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">${legend}</div>
  </section>`;
}

function heatmapHtml(watch: WatchSummary): string {
  const peak = Math.max(...watch.byWeekdayHour.flat());
  if (peak <= 0) return "";
  let peakDay = 0;
  let peakHour = 0;
  watch.byWeekdayHour.forEach((hours, weekday) =>
    hours.forEach((seconds, hour) => {
      if (seconds === peak) {
        peakDay = weekday;
        peakHour = hour;
      }
    })
  );
  const hourLabels = Array.from({ length: 24 }, (_unused, hour) => `<span class="text-[10px] text-text-muted tabular-nums text-center">${hour % 3 === 0 ? escapeHtml(hourWords(hour)) : ""}</span>`).join("");
  const rows = watch.byWeekdayHour
    .map(
      (hours, weekday) =>
        `<span class="text-[11px] text-text-muted self-center">${WEEKDAY_NAMES[weekday]}</span>` +
        hours
          .map((seconds, hour) => {
            const level = seconds <= 0 ? 0 : Math.max(1, Math.ceil((seconds / peak) * (HEAT_LEVELS - 1)));
            return `<span class="heat-cell" data-level="${level}" title="${escapeHtml(`${WEEKDAY_NAMES[weekday]} ${hourWords(hour)}: ${formatMinutesWords(seconds)}`)}"></span>`;
          })
          .join("")
    )
    .join("");
  const legend = Array.from({ length: HEAT_LEVELS }, (_unused, level) => `<span class="heat-cell legend-swatch" data-level="${level}"></span>`).join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("When you watch", `<span class="text-xs text-text-muted">Most on ${WEEKDAY_NAMES[peakDay]} around ${escapeHtml(hourWords(peakHour))}</span>`, "clock")}
    <div class="grid gap-[3px]" style="grid-template-columns: 2.5rem repeat(24, minmax(0, 1fr))"><span></span>${hourLabels}${rows}</div>
    <div class="flex items-center justify-end gap-1.5 text-[11px] text-text-muted">Less ${legend} More</div>
  </section>`;
}

function speedSectionHtml(watch: WatchSummary): string {
  const rows = watch.bySpeed.filter((row) => row.playedSeconds >= 60);
  if (rows.length === 0 || (rows.length === 1 && rows[0].rate === 1)) return "";
  const realTime = rows.reduce((sum, row) => sum + row.playedSeconds, 0);
  const videoTime = rows.reduce((sum, row) => sum + row.videoSeconds, 0);
  const longest = Math.max(...rows.map((row) => row.playedSeconds));
  const rowsHtml = rows
    .map(
      (row) => `<li class="grid grid-cols-[4rem_minmax(0,1fr)_6rem_9rem] items-center gap-3 text-sm">
        <span class="speed-chip justify-self-start${row.rate === 1 ? " speed-chip--plain" : ""}">${speedWords(row.rate)}</span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full rounded-full bg-accent" style="width:${Math.max(2, (row.playedSeconds / longest) * 100)}%;opacity:${(0.45 + Math.min(1, (row.rate - 0.75) / 1.25) * 0.55).toFixed(2)}"></span></span>
        <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.playedSeconds)}</span>
        <span class="text-right text-xs text-text-muted tabular-nums whitespace-nowrap">${row.rate === 1 ? "" : `${formatMinutesWords(row.videoSeconds)} of video`}</span>
      </li>`
    )
    .join("");
  const saved = videoTime - realTime;
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Playback speed", "", "speed")}
    <p class="text-xs text-text-muted m-0">${formatMinutesWords(videoTime)} of video took ${formatMinutesWords(realTime)} of real time${saved >= 60 ? `, ${formatMinutesWords(saved)} saved by watching faster` : ""}. Goals, limits and every total here use real time.</p>
    <ul class="m-0 p-0 list-none flex flex-col gap-2">${rowsHtml}</ul>
  </section>`;
}

function channelsSectionHtml(watch: WatchSummary, colors: Map<string, string>): string {
  // The summary names channel-less videos "Unknown channel", so match it the same way.
  const videosByChannel = new Map<string, WatchVideoRow[]>();
  for (const video of watch.videos) {
    const name = video.channelName || "Unknown channel";
    videosByChannel.set(name, [...(videosByChannel.get(name) ?? []), video]);
  }
  const languages = [...new Set(watch.byChannel.map((channel) => channel.language))];
  if (app.channelLanguageFilter && !languages.includes(app.channelLanguageFilter)) app.channelLanguageFilter = null;
  const filtered = app.channelLanguageFilter ? watch.byChannel.filter((channel) => channel.language === app.channelLanguageFilter) : watch.byChannel;
  const shown = showAllChannels ? filtered : filtered.slice(0, CHANNEL_ROWS);
  const longest = filtered[0]?.seconds ?? 1;
  const rowsHtml = shown
    .map((channel, index) => {
      const open = openChannel === channel.channelName;
      const channelVideos = [...(videosByChannel.get(channel.channelName) ?? [])].sort((first, second) => second.playedSeconds - first.playedSeconds);
      const titles = channelVideos.slice(0, CHANNEL_TOOLTIP_TITLES).map((video) => `• ${video.title || video.videoId}`);
      if (channelVideos.length > CHANNEL_TOOLTIP_TITLES) titles.push(`and ${channelVideos.length - CHANNEL_TOOLTIP_TITLES} more`);
      const color = colorOfLanguage(colors, channel.language);
      return `<li class="border-b border-border/60">
        <button type="button" class="time-channel channel-row${open ? " channel-row--open" : ""}" data-channel="${escapeHtml(channel.channelName)}" aria-expanded="${open}" title="${escapeHtml(open ? "" : titles.join("\n"))}">
          <span class="font-display text-[15px] text-text-muted tabular-nums w-5 text-right">${index + 1}</span>
          ${channelAvatarHtml(channel.channelName, channel.avatarUrl, "w-8 h-8 text-xs")}
          <span class="min-w-0 flex flex-col text-left">
            <span class="truncate text-sm text-text-primary">${escapeHtml(channel.channelName)}</span>
            <span class="truncate text-xs text-text-muted flex items-center gap-1.5">${languageMarkHtml(channel.language, color)}${escapeHtml(channel.language)} · ${plural(channel.videos, "video")}</span>
          </span>
          <span class="h-2 rounded-full overflow-hidden flex"><span class="h-full rounded-full" style="width:${Math.max(2, (channel.seconds / longest) * 100)}%;background:${color}"></span></span>
          <span class="text-right text-sm text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(channel.seconds)}</span>
          ${CHEVRON_RIGHT_ICON}
        </button>
        ${open ? `<ul class="m-0 list-none flex flex-col gap-2.5 pl-[4.25rem] pr-2 pt-1 pb-4">${channelVideos.map((video) => watchVideoRowHtml(video, colors)).join("")}</ul>` : ""}
      </li>`;
    })
    .join("");
  const filterHtml =
    languages.length > 1
      ? `<span class="flex flex-wrap gap-1.5" role="group" aria-label="Filter channels by language">
          <button type="button" class="time-channel-filter chip h-7 text-xs" data-language="" aria-pressed="${app.channelLanguageFilter === null}">All</button>
          ${languages
            .map(
              (language) =>
                `<button type="button" class="time-channel-filter chip h-7 text-xs" data-language="${escapeHtml(language)}" aria-pressed="${app.channelLanguageFilter === language}">${languageMarkHtml(language, colorOfLanguage(colors, language))}${escapeHtml(language)}</button>`
            )
            .join("")}
        </span>`
      : "";
  const hidden = filtered.length - CHANNEL_ROWS;
  const toggleHtml =
    hidden > 0 ? `<button type="button" id="time-channels-toggle" class="chip h-8 text-xs self-start">${showAllChannels ? `Show top ${CHANNEL_ROWS}` : `Show all ${filtered.length} channels`}</button>` : "";
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Channels", `<span class="text-xs text-text-muted tabular-nums">${watch.byChannel.length}</span>`, "channels")}
    ${filterHtml}
    <ul class="m-0 p-0 list-none flex flex-col">${rowsHtml}</ul>
    ${toggleHtml}
  </section>`;
}

export function watchSectionsHtml(watch: WatchSummary, prefs: TimeTrackingPrefs): string {
  const total = watch.total;
  if (total.playedSeconds <= 0) {
    return `<p class="text-sm text-text-muted m-0">${prefs.watchHistory ? "Nothing watched yet." : "Watch history is off."}</p>`;
  }
  const colors = languageColorMap(watch);

  const speed = total.videoSeconds / total.playedSeconds;
  const saved = total.videoSeconds - total.playedSeconds;
  const background = Math.max(0, total.playedSeconds - total.visibleSeconds);
  const tilesHtml = [
    watchStatTile("Videos", String(total.videos), `${total.completed} finished`, "videos"),
    watchStatTile("Speed", speedWords(speed), saved >= 60 ? `${formatMinutesWords(saved)} saved` : "", "speed"),
    watchStatTile("Subtitles", shareWords(total.captionSeconds, total.playedSeconds), formatMinutesWords(total.captionSeconds), "subtitles"),
    watchStatTile("Background", shareWords(background, total.playedSeconds), formatMinutesWords(background), "background"),
    watchStatTile("Active days", `${total.activeDays} of ${watch.days.length}`, total.activeDays > 0 ? `${formatMinutesWords(total.playedSeconds / total.activeDays)} a day` : "", "day"),
    watchStatTile("Ads", formatMinutesWords(total.adSeconds), "", "ads"),
  ].join("");

  const longestLanguage = Math.max(1, ...watch.byLanguage.map((row) => row.seconds));
  const languagesHtml = watch.byLanguage
    .map(
      (row) => `<li class="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageMarkHtml(row.label, colorOfLanguage(colors, row.label))}<span class="truncate">${escapeHtml(row.label)}</span></span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full rounded-full" style="width:${Math.max(2, (row.seconds / longestLanguage) * 100)}%;background:${colorOfLanguage(colors, row.label)}"></span></span>
        <span class="text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.seconds)} <span class="text-text-muted">· ${shareWords(row.seconds, total.playedSeconds)} · ${plural(row.videos, "video")}</span></span>
      </li>`
    )
    .join("");
  const languageShareHtml =
    watch.byLanguage.length > 1
      ? `<div class="flex h-3 gap-0.5 rounded-full overflow-hidden" role="img" aria-label="${escapeHtml(watch.byLanguage.map((row) => `${row.label} ${shareWords(row.seconds, total.playedSeconds)}`).join(", "))}">${watch.byLanguage
          .map((row) => `<span class="h-full" style="flex:${Math.max(1, Math.round(row.seconds))} 1 0px;background:${colorOfLanguage(colors, row.label)}" title="${escapeHtml(row.label)}: ${shareWords(row.seconds, total.playedSeconds)}"></span>`)
          .join("")}</div>`
      : "";

  const shownVideos = Math.min(watch.videos.length, Math.max(videoRowsShown, VIDEO_ROWS_PAGE));
  const videosHtml = watch.videos.slice(0, shownVideos).map((video) => watchVideoRowHtml(video, colors)).join("");
  const moreVideos = Math.min(VIDEO_ROWS_PAGE * 2, watch.videos.length - shownVideos);
  const videosMoreHtml = moreVideos > 0 ? `<button type="button" id="time-videos-more" class="chip h-8 text-xs self-start" data-shown="${shownVideos}">Show ${moreVideos} more</button>` : "";

  return `
    <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">${tilesHtml}</div>
    ${dayBarsHtml(watch, colors)}
    <section class="flex flex-col gap-3">
      ${timeSectionHeading("Languages", `<button type="button" id="time-choose-languages" class="link-btn text-xs">${app.focusLanguages.length > 0 ? "Change languages" : "Choose languages"}</button>`, "languages")}
      ${languageShareHtml}
      <ul class="m-0 p-0 list-none flex flex-col gap-2">${languagesHtml}</ul>
    </section>
    ${heatmapHtml(watch)}
    ${speedSectionHtml(watch)}
    ${channelsSectionHtml(watch, colors)}
    <section class="flex flex-col gap-3">
      ${timeSectionHeading("Videos", `<span class="text-xs text-text-muted tabular-nums">${shownVideos < watch.videos.length ? `${shownVideos} of ${watch.videos.length}` : watch.videos.length}</span>`, "list")}
      <div class="grid grid-cols-[4rem_minmax(0,1fr)_3.5rem_3rem_5.5rem] gap-3 text-[11px] uppercase tracking-[0.1em] text-text-muted" aria-hidden="true"><span></span><span>Video</span><span>Speed</span><span class="text-right">Seen</span><span class="text-right">Time</span></div>
      <ul class="m-0 p-0 list-none flex flex-col gap-2.5">${videosHtml}</ul>
      ${videosMoreHtml}
    </section>
  `;
}
