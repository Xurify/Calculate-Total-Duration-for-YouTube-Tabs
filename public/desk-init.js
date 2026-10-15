// Runs synchronously while the page parses, before the manager's module script loads tabs.
// With a snapshot it paints the last known desk (rail, heading, time bar, planner, list);
// without one it marks the page as loading so the skeleton shows instead of zeros.
(function paintLastKnownDesk() {
  var root = document.documentElement;
  try {
    var raw = localStorage.getItem("desk-snapshot");
    var snap = raw ? JSON.parse(raw) : null;
    if (!snap || snap.v !== 2) {
      root.classList.add("desk-loading");
      return;
    }
    var set = function (id, html) {
      var el = document.getElementById(id);
      if (el && typeof html === "string") el.innerHTML = html;
    };
    var text = function (id, value) {
      var el = document.getElementById(id);
      if (el && typeof value === "string") el.textContent = value;
    };
    var show = function (id, visible) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", !visible);
    };
    set("facet-rail", snap.rail);
    set("time-bar", snap.timeBar);
    show("time-bar", Boolean(snap.timeBar));
    set("time-bar-rest", snap.timeBarRest);
    show("time-bar-rest", Boolean(snap.timeBarRest));
    text("desk-kicker", snap.kicker);
    text("current-view-title", snap.title);
    text("desk-time-value", snap.timeValue);
    text("desk-time-suffix", snap.timeSuffix);
    text("current-view-stats", snap.stats);
    text("plan-summary", snap.planSummary);
    text("btn-start-plan-label", snap.planLabel);
    var planner = document.getElementById("planner");
    if (planner && snap.plannerVisible) {
      planner.classList.remove("hidden");
      planner.classList.add("flex");
    }
    if (snap.list) set("tab-list", snap.list);
    root.classList.add("desk-snapshot");
  } catch (error) {
    root.classList.add("desk-loading");
  }
})();
