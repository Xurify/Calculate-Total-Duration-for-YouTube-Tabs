

export function injectImmersionStyles(): void {
  if (document.getElementById("study-harvester-immersion-styles")) return;

  const styleElement = document.createElement("style");
  styleElement.id = "study-harvester-immersion-styles";
  styleElement.textContent = `
    #study-harvester-player-hud {
      --sh-ink: #f4efe6;
      --sh-muted: rgba(244, 239, 230, 0.62);
      --sh-glass: rgba(14, 12, 11, 0.62);
      --sh-glass-strong: rgba(14, 12, 11, 0.86);
      --sh-line: rgba(255, 255, 255, 0.1);
      --sh-accent: #f0b65a;
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 60;
      font-family: "YouTube Sans", Roboto, Arial, sans-serif;
      color: var(--sh-ink);
      user-select: none;
      pointer-events: auto;
      transition: opacity 0.1s cubic-bezier(0.4, 0, 1, 1);
    }
    .ytp-autohide #study-harvester-player-hud:not(.is-open),
    .ad-showing #study-harvester-player-hud {
      opacity: 0;
      pointer-events: none;
      transition-duration: 0.5s;
    }
    .study-harvester-icon {
      width: 18px;
      height: 18px;
      flex: none;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .study-harvester-hud-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 36px;
      padding: 0 14px 0 11px;
      border: 1px solid var(--sh-line);
      border-radius: 8px;
      background-color: var(--sh-glass);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      box-shadow: 0 6px 20px -10px rgba(0, 0, 0, 0.8);
      color: var(--sh-ink);
      font: 500 13px/1 "YouTube Sans", Roboto, Arial, sans-serif;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .study-harvester-hud-btn:hover:not(:disabled) {
      background-color: rgba(40, 36, 32, 0.8);
      border-color: rgba(255, 255, 255, 0.22);
      transform: translateY(-1px);
    }
    .study-harvester-hud-btn:disabled {
      cursor: default;
      color: var(--sh-muted);
    }
    .study-harvester-hud-btn.is-icon {
      width: 36px;
      padding: 0;
      justify-content: center;
    }
    .study-harvester-hud-btn.is-accent {
      border-color: transparent;
      background-color: var(--sh-accent);
      color: #1a1410;
      font-weight: 600;
      box-shadow: 0 8px 24px -8px rgba(240, 182, 90, 0.7);
    }
    .study-harvester-hud-btn.is-accent:hover:not(:disabled) {
      background-color: var(--sh-accent);
      filter: brightness(1.06);
    }
    .study-harvester-shelf-popover {
      --sh-ink: #f4efe6;
      --sh-muted: rgba(244, 239, 230, 0.62);
      --sh-glass-strong: rgba(14, 12, 11, 0.86);
      --sh-line: rgba(255, 255, 255, 0.1);
      --sh-accent: #f0b65a;
      position: fixed;
      z-index: 2147483644;
      min-width: 230px;
      padding: 8px;
      border-radius: 16px;
      border: 1px solid var(--sh-line);
      background-color: var(--sh-glass-strong);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 20px 50px -20px rgba(0, 0, 0, 0.9);
      color: var(--sh-ink);
      display: flex;
      flex-direction: column;
      animation: study-harvester-rise 0.18s ease-out;
    }
    .study-harvester-shelf-header {
      padding: 6px 10px 8px;
      font: 600 11px Roboto, Arial, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sh-muted);
    }
    .study-harvester-shelf-hint {
      padding: 0 10px 8px;
      font: 400 12px/1.4 Roboto, Arial, sans-serif;
      color: var(--sh-muted);
    }
    .study-harvester-pillar-item {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 38px;
      padding: 0 10px;
      border: none;
      border-radius: 10px;
      background: transparent;
      color: var(--sh-ink);
      font: 400 14px Roboto, Arial, sans-serif;
      text-align: left;
      cursor: pointer;
    }
    .study-harvester-pillar-item .study-harvester-icon {
      width: 18px;
      height: 18px;
      opacity: 0.6;
    }
    .study-harvester-pillar-item > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .study-harvester-pillar-item.saved {
      color: var(--sh-accent);
    }
    .study-harvester-pillar-item.saved:disabled {
      cursor: default;
    }
    .study-harvester-pillar-item.is-back {
      color: var(--sh-muted);
    }
    .study-harvester-pillar-item.saved .study-harvester-icon {
      opacity: 1;
    }
    .study-harvester-pillar-item:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.08);
    }
    @keyframes study-harvester-rise {
      from { opacity: 0; transform: translateY(6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    #study-harvester-cloze-modal {
      --sh-ink: #f4efe6;
      --sh-muted: rgba(244, 239, 230, 0.58);
      --sh-line: rgba(255, 255, 255, 0.1);
      --sh-accent: #f0b65a;
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(10, 9, 8, 0.2) 0%, rgba(10, 9, 8, 0.55) 55%, rgba(10, 9, 8, 0.85) 100%);
      z-index: 2147483645;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: "YouTube Sans", Roboto, system-ui, sans-serif;
    }
    .study-harvester-cloze-card {
      width: 100%;
      max-width: 920px;
      padding: 14px 20px 16px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(16, 14, 13, 0.82);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: var(--sh-ink);
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: study-harvester-rise 0.22s ease-out;
    }
    .study-harvester-cloze-card:focus {
      outline: none;
    }
    .study-harvester-cloze-header {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 28px;
      font-size: 12px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-kicker {
      flex: none;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sh-accent);
    }
    .study-harvester-cloze-source {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .study-harvester-cloze-source::before {
      content: "·";
      margin-right: 10px;
    }
    .study-harvester-cloze-close {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: none;
      border-radius: 6px;
      background: transparent;
      border: none;
      color: var(--sh-muted);
      cursor: pointer;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    .study-harvester-cloze-close .study-harvester-icon {
      width: 16px;
      height: 16px;
    }
    .study-harvester-cloze-close:hover {
      background-color: rgba(255, 255, 255, 0.08);
      color: var(--sh-ink);
    }
    .study-harvester-cloze-sentence {
      padding: 2px 0 6px;
      font: 400 23px/1.5 Georgia, "Times New Roman", serif;
      color: var(--sh-ink);
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
    .study-harvester-cloze-word {
      display: inline;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      line-height: inherit;
      vertical-align: baseline;
      cursor: pointer;
      transition: color 0.12s ease;
    }
    .study-harvester-cloze-word:hover {
      color: var(--sh-accent);
      text-decoration: underline 1px dotted;
      text-underline-offset: 4px;
    }
    .study-harvester-cloze-word.is-blank {
      color: var(--sh-accent);
      font-weight: 600;
      text-decoration: underline 2px solid;
      text-underline-offset: 4px;
    }
    .study-harvester-cloze-note {
      font-size: 12px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .study-harvester-cloze-nav {
      display: inline-flex;
      flex: none;
      gap: 2px;
      padding: 3px;
      border-radius: 12px;
      border: 1px solid var(--sh-line);
      background: rgba(255, 255, 255, 0.04);
    }
    .study-harvester-cloze-nav-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 30px;
      min-width: 30px;
      padding: 0 7px;
      border-radius: 9px;
      border: none;
      background: transparent;
      color: var(--sh-ink);
      font: 500 13px "YouTube Sans", Roboto, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    .study-harvester-cloze-nav-btn .study-harvester-icon {
      width: 16px;
      height: 16px;
    }
    .study-harvester-cloze-nav-btn:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.09);
    }
    .study-harvester-cloze-nav-btn.is-listen {
      padding: 0 10px 0 8px;
      color: var(--sh-accent);
    }
    .study-harvester-cloze-nav-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .study-harvester-cloze-pick {
      display: inline-flex;
      flex: none;
      align-items: baseline;
      gap: 8px;
      height: 38px;
      box-sizing: border-box;
      padding: 0 12px;
      line-height: 36px;
      border-radius: 12px;
      border: 1px solid rgba(240, 182, 90, 0.3);
      background: rgba(240, 182, 90, 0.08);
      font-size: 13px;
      color: var(--sh-muted);
    }
    .study-harvester-cloze-pick-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .study-harvester-cloze-pick-word {
      color: var(--sh-accent);
      font-weight: 600;
    }
    .study-harvester-cloze-translation {
      flex: 1 1 200px;
      min-width: 0;
      height: 38px;
      box-sizing: border-box;
      padding: 0 14px;
      border-radius: 12px;
      border: 1px solid var(--sh-line);
      background-color: rgba(0, 0, 0, 0.28);
      color: var(--sh-ink);
      font: 400 14px "YouTube Sans", Roboto, system-ui, sans-serif;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .study-harvester-cloze-translation::placeholder {
      color: rgba(244, 239, 230, 0.4);
    }
    .study-harvester-cloze-translation:focus {
      border-color: rgba(240, 182, 90, 0.7);
      box-shadow: 0 0 0 3px rgba(240, 182, 90, 0.15);
    }
    .study-harvester-btn-save {
      flex: none;
      margin-left: auto;
      height: 38px;
      padding: 0 18px;
      border-radius: 12px;
      border: none;
      background: var(--sh-accent);
      color: #1a1410;
      font: 600 13px "YouTube Sans", Roboto, system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 10px 28px -12px rgba(240, 182, 90, 0.9);
      transition: filter 0.15s ease, transform 0.15s ease;
    }
    .study-harvester-btn-save:hover {
      filter: brightness(1.06);
      transform: translateY(-1px);
    }
    #study-harvester-hud-toast {
      position: absolute;
      left: 12px;
      bottom: 64px;
      max-width: min(480px, 70%);
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(14, 12, 11, 0.82);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #f4efe6;
      font: 400 14px/20px Roboto, Arial, sans-serif;
      z-index: 61;
      transition: opacity 0.2s ease, transform 0.2s ease;
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
    }
    #study-harvester-limit-card {
      position: absolute;
      right: 12px;
      bottom: 64px;
      width: min(380px, calc(100% - 24px));
      max-height: calc(100% - 88px);
      overflow-y: auto;
      box-sizing: border-box;
      padding: 14px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(14, 12, 11, 0.88);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 20px 50px -20px rgba(0, 0, 0, 0.9);
      color: #f4efe6;
      font: 400 13px/18px Roboto, Arial, sans-serif;
      z-index: 62;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    #study-harvester-limit-card.is-shown {
      opacity: 1;
      transform: translateY(0);
    }
    #study-harvester-limit-card .sh-limit-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    #study-harvester-limit-card .sh-limit-title {
      flex: 1;
      font: 600 15px/20px "YouTube Sans", Roboto, Arial, sans-serif;
    }
    #study-harvester-limit-card .sh-limit-used,
    #study-harvester-limit-card .sh-limit-meta {
      color: rgba(244, 239, 230, 0.62);
      font-size: 12px;
    }
    #study-harvester-limit-card .sh-limit-note {
      margin: 2px 0 10px;
      color: rgba(244, 239, 230, 0.78);
    }
    #study-harvester-limit-card .sh-limit-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #study-harvester-limit-card .sh-limit-pick {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px;
      margin: 0 -6px;
      border-radius: 10px;
      color: inherit;
      text-decoration: none;
      transition: background-color 0.15s ease;
    }
    #study-harvester-limit-card .sh-limit-pick:hover,
    #study-harvester-limit-card .sh-limit-pick:focus-visible {
      background-color: rgba(255, 255, 255, 0.08);
      outline: none;
    }
    #study-harvester-limit-card .sh-limit-thumb {
      width: 72px;
      height: 40px;
      flex: none;
      border-radius: 6px;
      object-fit: cover;
      background-color: rgba(255, 255, 255, 0.08);
    }
    #study-harvester-limit-card .sh-limit-body {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    #study-harvester-limit-card .sh-limit-pick-title,
    #study-harvester-limit-card .sh-limit-meta {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    #study-harvester-limit-card .sh-limit-goal {
      color: #f0b65a;
      font-size: 11px;
      font-weight: 500;
    }
    #study-harvester-limit-card .sh-limit-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    #study-harvester-limit-card .sh-limit-btn {
      height: 32px;
      padding: 0 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: transparent;
      color: #f4efe6;
      font: 500 13px/1 "YouTube Sans", Roboto, Arial, sans-serif;
      cursor: pointer;
    }
    #study-harvester-limit-card .sh-limit-btn:hover {
      background-color: rgba(255, 255, 255, 0.08);
    }
    #study-harvester-limit-card .sh-limit-btn.is-accent {
      border-color: transparent;
      background-color: #f0b65a;
      color: #1a1410;
      font-weight: 600;
    }
    .study-harvester-hud-btn.is-on {
      border-color: rgba(240, 182, 90, 0.55);
      color: var(--sh-accent);
    }
    .sh-listen-first .ytp-caption-window-container {
      opacity: 0 !important;
    }
    #study-harvester-listen-card {
      position: absolute;
      left: 50%;
      bottom: 64px;
      width: min(640px, calc(100% - 24px));
      box-sizing: border-box;
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background-color: rgba(16, 14, 13, 0.86);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: #f4efe6;
      font: 400 13px/18px "YouTube Sans", Roboto, Arial, sans-serif;
      z-index: 62;
      display: flex;
      flex-direction: column;
      gap: 8px;
      opacity: 0;
      transform: translate(-50%, 6px);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #study-harvester-listen-card.is-shown {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    #study-harvester-listen-card .sh-listen-head {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: rgba(244, 239, 230, 0.6);
    }
    #study-harvester-listen-card .sh-listen-kicker {
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #f0b65a;
    }
    #study-harvester-listen-card .sh-listen-meta {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
    }
    #study-harvester-listen-card .sh-listen-off {
      height: 26px;
      padding: 0 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: rgba(244, 239, 230, 0.6);
      font: 500 12px "YouTube Sans", Roboto, Arial, sans-serif;
      cursor: pointer;
    }
    #study-harvester-listen-card .sh-listen-off:hover {
      background-color: rgba(255, 255, 255, 0.08);
      color: #f4efe6;
    }
    #study-harvester-listen-card .sh-listen-prompt,
    #study-harvester-listen-card .sh-listen-text {
      margin: 0;
      font: 400 22px/1.45 Georgia, "Times New Roman", serif;
      color: #f4efe6;
    }
    #study-harvester-listen-card .sh-listen-text {
      max-height: 140px;
      overflow-y: auto;
    }
    #study-harvester-listen-card .sh-listen-hint {
      margin: 2px 0 0;
      font-size: 12px;
      color: rgba(244, 239, 230, 0.6);
    }
    #study-harvester-listen-card .sh-listen-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }
    #study-harvester-listen-card .sh-listen-spacer {
      flex: 1;
    }
    #study-harvester-listen-card .sh-listen-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      padding: 0 8px 0 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: transparent;
      color: #f4efe6;
      font: 500 13px/1 "YouTube Sans", Roboto, Arial, sans-serif;
      cursor: pointer;
      transition: background-color 0.15s ease, filter 0.15s ease;
    }
    #study-harvester-listen-card .sh-listen-btn .study-harvester-icon {
      width: 16px;
      height: 16px;
      margin-left: -4px;
    }
    #study-harvester-listen-card .sh-listen-btn:hover {
      background-color: rgba(255, 255, 255, 0.08);
    }
    #study-harvester-listen-card .sh-listen-btn.is-accent {
      border-color: transparent;
      background-color: #f0b65a;
      color: #1a1410;
      font-weight: 600;
      box-shadow: 0 10px 28px -12px rgba(240, 182, 90, 0.9);
    }
    #study-harvester-listen-card .sh-listen-btn.is-accent:hover {
      filter: brightness(1.06);
    }
    #study-harvester-listen-card .sh-listen-btn:focus-visible,
    #study-harvester-listen-card .sh-listen-off:focus-visible {
      outline: 2px solid #f0b65a;
      outline-offset: 2px;
    }
    #study-harvester-listen-card .sh-listen-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      box-sizing: border-box;
      border-radius: 6px;
      background-color: rgba(255, 255, 255, 0.1);
      color: inherit;
      font: 600 11px/1 "YouTube Sans", Roboto, Arial, sans-serif;
      opacity: 0.8;
    }
    #study-harvester-listen-card .sh-listen-btn.is-accent .sh-listen-kbd {
      background-color: rgba(26, 20, 16, 0.14);
    }
  `;
  document.head.appendChild(styleElement);
}
