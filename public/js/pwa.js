import { icon } from "./api.js";

// Installable app support: service worker registration plus an
// "Install app" button that uses the browser's own install prompt
// (Android / desktop Chrome & Edge) or shows Add-to-Home-Screen steps (iOS).
let deferredPrompt = null;
let refresh = () => {};

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)")?.matches ||
  window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ reports itself as a Mac with touch support
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const canInstall = () =>
  !isStandalone() && (Boolean(deferredPrompt) || isIOS());

export function registerPWA() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installation is optional; the site keeps working without it.
    });
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // show our own button instead of the mini-bar
    deferredPrompt = event;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    refresh();
  });
}

function iosSteps() {
  return Swal.fire({
    title: "Install CourtSide",
    html: `<ol class="text-start ps-3 mb-0" style="line-height:1.9"><li>Tap the <strong>Share</strong> button in Safari ${icon("share")}</li><li>Scroll down and tap <strong>Add to Home Screen</strong> ${icon("square-plus")}</li><li>Tap <strong>Add</strong>. CourtSide opens from your home screen like an app.</li></ol>`,
    confirmButtonText: "Got it",
    didOpen: () => window.lucide?.createIcons(),
  });
}

async function install() {
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // The browser's prompt can only be used once; if dismissed, the
      // browser fires beforeinstallprompt again later.
      if (outcome === "accepted" || deferredPrompt === prompt)
        deferredPrompt = null;
    } catch {
      // Prompt unavailable (e.g. not triggered by a tap): keep the button
      // and point people to the browser menu instead of failing.
      await Swal.fire({
        title: "Install CourtSide",
        text: "Open your browser menu and choose “Install app” or “Add to Home screen”.",
        confirmButtonText: "Got it",
      });
    }
    refresh();
  } else if (isIOS()) await iosSteps();
}

/** Renders the Install button into `slot` and keeps it in sync. */
export function mountInstallButton(slot) {
  if (!slot) return;
  refresh = () => {
    if (!slot.isConnected) return;
    slot.innerHTML = canInstall()
      ? `<button type="button" class="install-app" id="install-app">${icon("download")} Install app</button>`
      : "";
    const button = slot.querySelector("#install-app");
    if (button) button.onclick = install;
    window.lucide?.createIcons();
  };
  refresh();
}
