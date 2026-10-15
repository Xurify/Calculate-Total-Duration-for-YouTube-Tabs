(function applyStoredTheme() {
  try {
    var storedPreference = localStorage.getItem("theme-preference");
    if (storedPreference === "light" || storedPreference === "dark") {
      document.documentElement.dataset.theme = storedPreference;
    }
  } catch (error) {
    return;
  }
})();
