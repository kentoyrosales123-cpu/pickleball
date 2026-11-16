// Offline page: retry on demand, and reload automatically when back online.
// (External file because the Content Security Policy blocks inline scripts.)
document.getElementById("retry").onclick = () => location.reload();
window.addEventListener("online", () => location.reload());
