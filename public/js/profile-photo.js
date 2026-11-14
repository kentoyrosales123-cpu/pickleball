export const photoForm = (user) =>
  `<form id="photo-form" class="mb-4"><label for="profile-photo" class="form-label">Profile picture</label><input class="form-control" type="file" id="profile-photo" accept="image/jpeg,image/png,image/webp" aria-describedby="photo-help"><p id="photo-help" class="subtle">JPEG, PNG, or WebP, up to 5 MB and 25 megapixels. Your photo is cropped to a square. Photos are visible to signed-in club members.</p><div class="d-flex gap-2"><button class="btn btn-secondary" type="submit">Upload photo</button>${user.profileImage ? '<button class="btn btn-secondary" type="button" id="remove-photo">Remove photo</button>' : ""}</div><p id="photo-status" role="status" aria-live="polite"></p></form>`;
export function mountPhotoUpload(container, onSaved) {
  const form = container.querySelector("#photo-form");
  const status = form.querySelector("#photo-status");
  let busy = false;
  async function save(method, file) {
    if (busy) return;
    busy = true;
    for (const control of form.querySelectorAll("button, input"))
      control.disabled = true;
    status.textContent =
      method === "PUT" ? "Uploading photo…" : "Removing photo…";
    try {
      const response = await fetch("/api/players/me/photo", {
        method,
        credentials: "same-origin",
        headers: {
          "X-PMS-Request": "1",
          ...(file ? { "Content-Type": file.type } : {}),
        },
        ...(file ? { body: file } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "Unable to update photo.");
      onSaved(result.user);
    } catch (error) {
      status.textContent =
        error.message || "Unable to update photo. Please try again.";
    } finally {
      busy = false;
      for (const control of form.querySelectorAll("button, input"))
        control.disabled = false;
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    const file = form.querySelector("#profile-photo").files[0];
    if (
      !file ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      status.textContent = "Choose a JPEG, PNG, or WebP image.";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      status.textContent = "Choose an image no larger than 5 MB.";
      return;
    }
    return save("PUT", file);
  };
  const remove = form.querySelector("#remove-photo");
  if (remove) remove.onclick = () => save("DELETE");
}
