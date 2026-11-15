import { icon } from "./api.js";

const KEY = "courtside-theme";
const root = document.documentElement;

export const currentTheme = () =>
  root.getAttribute("data-theme") === "dark" ? "dark" : "light";

function apply(theme) {
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-bs-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0b1220" : "#101828");
}

function savedTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

const label = (theme) =>
  theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

export const themeToggle = () => {
  const theme = currentTheme();
  return `<button type="button" class="icon-button theme-toggle" data-theme-toggle aria-label="${label(theme)}" title="${label(theme)}">${icon(theme === "dark" ? "sun" : "moon")}</button>`;
};

function refreshButtons() {
  const theme = currentTheme();
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    b.setAttribute("aria-label", label(theme));
    b.title = label(theme);
    b.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  });
  window.lucide?.createIcons();
}

let onChange = () => {};
/** Wire every toggle on the page; `changed` runs after the theme switches. */
export function mountThemeToggles(changed) {
  onChange = changed;
  document.querySelectorAll("[data-theme-toggle]").forEach(
    (b) =>
      (b.onclick = () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        try {
          localStorage.setItem(KEY, next);
        } catch {}
        apply(next);
        refreshButtons();
        onChange(next);
      }),
  );
}

// Follow the device setting live until the user picks a theme themselves.
// (matchMedia is missing in some older browsers and in jsdom.)
window
  .matchMedia?.("(prefers-color-scheme: dark)")
  ?.addEventListener?.("change", (e) => {
    if (savedTheme()) return;
    apply(e.matches ? "dark" : "light");
    refreshButtons();
    onChange(currentTheme());
  });
apply(currentTheme());

/** Reads a CSS custom property for the active theme (used by charts). */
export const cssVar = (name) =>
  window.getComputedStyle(root).getPropertyValue(name).trim();
