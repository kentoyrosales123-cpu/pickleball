import { api, esc, date, toast } from "./api.js";
const tiers = [
  "Rookie",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Diamond",
  "Ace",
  "Master",
  "Grandmaster",
  "Legend",
];
const rankLabel = (p) => `${p.rankTier} ${p.rankDivision || ""}`.trim();
function labelForStars(stars) {
  if (stars >= 135) return `Legend · ${stars - 135} stars`;
  return `${tiers[Math.floor(stars / 15)]} ${["III", "II", "I"][Math.floor(stars / 5) % 3]} · ${stars % 5} stars`;
}
export async function reviewPickleQue(playerId) {
  const data = await api(
    `/admin/ranking/players/${playerId}/pickle-que-review`,
  );
  const last = data.reviews[0]?.externalReview;
  const result = await Swal.fire({
    title: `Pickle Que review: ${data.player.fullName}`,
    width: 780,
    html: `<div class="pickle-que-review"><p>Current club rank: <strong>${esc(rankLabel(data.profile))}</strong> · ${data.profile.rankStars} total stars</p><p class="subtle">Enter the stats you checked on the player's Pickle Que account, then choose the club rank you consider appropriate.</p><form id="pq-review-form"><div class="form-grid"><div class="wide"><label class="form-label" for="pq-url">Pickle Que profile link</label><input id="pq-url" name="profileUrl" type="url" class="form-control" placeholder="https://…" maxlength="1000" required value="${esc(last?.profileUrl || "")}"></div><div><label class="form-label" for="pq-name">Pickle Que account name</label><input id="pq-name" name="accountName" class="form-control" maxlength="100" required value="${esc(last?.accountName || "")}"></div><div><label class="form-label" for="pq-date">Stats checked on (UTC date)</label><input id="pq-date" name="observedOn" type="date" class="form-control" max="${new Date().toISOString().slice(0, 10)}" value="${new Date().toISOString().slice(0, 10)}" required></div><div><label class="form-label" for="pq-wins">Wins</label><input id="pq-wins" name="wins" type="number" min="0" max="1000000" step="1" class="form-control" required></div><div><label class="form-label" for="pq-losses">Losses</label><input id="pq-losses" name="losses" type="number" min="0" max="1000000" step="1" class="form-control" required></div><div class="wide"><output id="pq-stat-summary" aria-live="polite">Enter wins and losses to calculate win rate.</output></div><div class="wide"><label class="form-label" for="pq-rating">Displayed rating or level (optional)</label><input id="pq-rating" name="displayedRating" class="form-control" maxlength="100" placeholder="Copy the rating or level shown on the profile"></div><div class="wide"><label class="form-label" for="pq-notes">Supporting stats / review notes (optional)</label><textarea id="pq-notes" name="notes" class="form-control" maxlength="1000" rows="2" placeholder="Match format, period covered, opponent strength, or other context"></textarea></div><div><label class="form-label" for="pq-tier">Assign rank tier</label><select id="pq-tier" name="tier" class="form-select">${tiers.map((t) => `<option ${t === data.profile.rankTier ? "selected" : ""}>${t}</option>`).join("")}</select></div><div><label class="form-label" for="pq-division">Division</label><select id="pq-division" name="division" class="form-select">${["III", "II", "I"].map((d) => `<option ${d === data.profile.rankDivision ? "selected" : ""}>${d}</option>`).join("")}</select></div><div><label class="form-label" for="pq-stars">Stars within rank/division</label><input id="pq-stars" name="stars" type="number" min="0" max="4" step="1" class="form-control" required value="${data.profile.stars}"></div><div><label class="form-label">Rank change preview</label><output id="pq-rank-summary" aria-live="polite"></output></div><div class="wide"><label class="form-label" for="pq-reason">Why do these stats justify this rank?</label><textarea id="pq-reason" name="reason" class="form-control" minlength="3" maxlength="500" required rows="2"></textarea></div></div><p class="subtle mt-3">The club rank is your assessment. Entered stats do not automatically convert into a rank or change the player's match results, MMR, or reward meters.</p><label><input name="confirmed" type="checkbox" required> I checked that this Pickle Que account belongs to this player and reviewed these stats.</label></form><button id="pq-history" type="button" class="btn btn-secondary btn-sm mt-3">Previous Pickle Que reviews (${data.total})</button></div>`,
    showCancelButton: true,
    confirmButtonText: "Review rank change",
    focusConfirm: false,
    didOpen: () => {
      const form = document.querySelector("#pq-review-form");
      const update = () => {
        const legend = form.elements.tier.value === "Legend";
        form.elements.division.disabled = legend;
        form.elements.stars.max = legend ? "999865" : "4";
        const wins = Number(form.elements.wins.value),
          losses = Number(form.elements.losses.value),
          total = wins + losses;
        document.querySelector("#pq-stat-summary").textContent =
          `${total} completed matches · ${total ? ((wins / total) * 100).toFixed(1) : "0.0"}% win rate`;
        const stars = Number(form.elements.stars.value);
        const totalStars = legend
          ? 135 + stars
          : tiers.indexOf(form.elements.tier.value) * 15 +
            ["III", "II", "I"].indexOf(form.elements.division.value) * 5 +
            stars;
        document.querySelector("#pq-rank-summary").textContent =
          `${data.profile.rankStars} → ${totalStars} total stars`;
      };
      form.oninput = update;
      form.onsubmit = (e) => e.preventDefault();
      document.querySelector("#pq-history").onclick = async () => {
        Swal.close();
        await showPickleQueReviews(playerId);
      };
      update();
    },
    preConfirm: () => {
      const form = document.querySelector("#pq-review-form");
      if (!form.reportValidity()) return false;
      const e = form.elements,
        wins = Number(e.wins.value),
        losses = Number(e.losses.value);
      const url = new URL(e.profileUrl.value);
      if (url.protocol !== "https:" || url.username || url.password) {
        Swal.showValidationMessage(
          "Enter an HTTPS profile link without embedded credentials",
        );
        return false;
      }
      if (wins + losses === 0) {
        Swal.showValidationMessage("Enter at least one completed match");
        return false;
      }
      const targetRank = {
        tier: e.tier.value,
        division: e.tier.value === "Legend" ? null : e.division.value,
        stars: Number(e.stars.value),
      };
      const totalStars =
        targetRank.tier === "Legend"
          ? 135 + targetRank.stars
          : tiers.indexOf(targetRank.tier) * 15 +
            ["III", "II", "I"].indexOf(targetRank.division) * 5 +
            targetRank.stars;
      if (totalStars === data.profile.rankStars) {
        Swal.showValidationMessage(
          "Choose a different rank to record an adjustment",
        );
        return false;
      }
      return {
        expectedVersion: data.version,
        targetRank,
        stats: {
          profileUrl: e.profileUrl.value,
          accountName: e.accountName.value.trim(),
          observedOn: e.observedOn.value,
          wins,
          losses,
          displayedRating: e.displayedRating.value.trim(),
          notes: e.notes.value.trim(),
        },
        reason: e.reason.value.trim(),
        confirmed: true,
      };
    },
  });
  if (!result.isConfirmed) return false;
  const body = result.value,
    rank = body.targetRank;
  const confirm = await Swal.fire({
    title: "Confirm player rank adjustment",
    text: `${data.player.fullName}: ${rankLabel(data.profile)} (${data.profile.stars} stars) → ${rank.tier} ${rank.division || ""} (${rank.stars} stars). Based on ${body.stats.wins} wins / ${body.stats.losses} losses. Reason: ${body.reason}`,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Save reviewed rank",
  });
  if (!confirm.isConfirmed) return false;
  await api(
    `/admin/ranking/players/${playerId}/pickle-que-review`,
    "POST",
    body,
  );
  toast("Pickle Que review and player rank saved");
  return true;
}
export async function showPickleQueReviews(playerId, page = 1) {
  const data = await api(
    `/admin/ranking/players/${playerId}/pickle-que-review?page=${page}`,
  );
  const result = await Swal.fire({
    title: `Pickle Que review history: ${data.player.fullName}`,
    width: 780,
    html: `<div class="pickle-que-review">${data.reviews.map((r) => `<article class="panel mb-3"><strong>${date(r.timestamp)} · ${esc(r.actorId?.fullName || "Administrator")}</strong><p>${esc(labelForStars(r.externalReview.previousRankStars))} → ${esc(labelForStars(r.rankStars))}</p><a href="${esc(r.externalReview.profileUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.externalReview.accountName)} — source profile</a><p>${r.externalReview.wins} wins / ${r.externalReview.losses} losses · ${r.externalReview.winPercentage.toFixed(1)}% · checked ${esc(r.externalReview.observedOn)}</p><p>Displayed rating: ${esc(r.externalReview.displayedRating || "Not recorded")}</p><p>${esc(r.externalReview.notes || "")}</p><p><strong>Reason:</strong> ${esc(r.reason)}</p><small>Stats entered and reviewed by an administrator.</small></article>`).join("") || "<p>No Pickle Que reviews recorded yet.</p>"}<p>Page ${page} · ${data.total} reviews</p></div>`,
    showCancelButton: true,
    cancelButtonText: "Close",
    showDenyButton: page > 1,
    denyButtonText: "Newer reviews",
    showConfirmButton: page * 20 < data.total,
    confirmButtonText: "Older reviews",
  });
  if (result.isConfirmed) return showPickleQueReviews(playerId, page + 1);
  if (result.isDenied) return showPickleQueReviews(playerId, page - 1);
}
