// Runs before first paint (loaded synchronously in <head>) so the page never
// flashes the wrong theme. Saved choice wins; otherwise follow the device.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("courtside-theme");
  } catch (e) {}
  if (theme !== "light" && theme !== "dark")
    theme =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-bs-theme", theme);
})();
