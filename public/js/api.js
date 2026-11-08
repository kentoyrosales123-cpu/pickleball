export async function api(path, method = "GET", body) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-PMS-Request": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.message || "Request failed");
    error.status = res.status;
    throw error;
  }
  return data;
}
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const icon = (name) =>
  `<i data-lucide="${name}" aria-hidden="true"></i>`;
export const date = (value) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "To be scheduled";
export const time = (value) =>
  value
    ? new Date(value).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "TBD";
export const initials = (name) =>
  esc(
    (name || "?")
      .split(" ")
      .slice(0, 2)
      .map((s) => s[0])
      .join(""),
  );
export const avatar = (user) =>
  user.profileImage
    ? `<img class="avatar" src="${esc(user.profileImage)}" alt="${esc(user.fullName)}" referrerpolicy="no-referrer">`
    : `<span class="avatar">${initials(user.fullName)}</span>`;
export const empty = (title, text = "") =>
  `<div class="empty">${icon("calendar-days")}<strong>${esc(title)}</strong>${text ? `<p class="mb-0 mt-2">${esc(text)}</p>` : ""}</div>`;
export const toast = (title) =>
  Swal.fire({
    toast: true,
    position: "top-end",
    icon: "success",
    title,
    timer: 2500,
    showConfirmButton: false,
  });
export async function confirm(title, text) {
  return (
    await Swal.fire({
      title,
      text,
      icon: "question",
      showCancelButton: true,
      confirmButtonText: "Confirm",
    })
  ).isConfirmed;
}
export function download(name, rows) {
  const csv = rows
    .map((row) =>
      row
        .map(
          (v) =>
            `"${String(v ?? "")
              .replace(/^[=+@-]/, "'$&")
              .replaceAll('"', '""')}"`,
        )
        .join(","),
    )
    .join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
