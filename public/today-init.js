// Paints the last Today page while the manager's module script loads, so the first view never flashes empty.
(function paintLastToday() {
  try {
    var html = localStorage.getItem("today-snapshot");
    var view = new URLSearchParams(location.search).get("view");
    var panel = document.getElementById("today-panel");
    if (html && panel && !view) panel.innerHTML = html;
  } catch (error) {}
})();
