import { api, esc, date, time, toast, confirm } from "./api.js";

export async function mountPlayerRating(container, rankings, drawChart) {
  const section = document.createElement("section");
  section.className = "panel mb-4";
  // Place rating beside the overview, before event cards, without replacing other charts.
  const grid = container.querySelector(".stats-grid");
  if (grid) grid.after(section);
  else container.append(section);
  let page = 1;
  async function load() {
    const data = await api(
        `/players/me/rating?pool=doubles&page=${page}&limit=100`,
      ),
      p = data.profile;
    const status = p.manualLocked
      ? "Manual override"
      : p.automaticConfirmed
        ? "Automatic rank confirmed"
        : `Provisional · ${p.ratedMatches} / ${data.settings.minimumRatedMatches} rated matches`;
    section.innerHTML = `<div class="panel-header"><div><h3>Your doubles rating</h3><p>${data.settings.enabled ? "Rated results update after official finalization." : "Automatic ranking is currently disabled. Existing ratings are preserved."}</p></div><span class="badge ${p.automaticConfirmed ? "green" : ""}">${esc(status)}</span></div><div class="rating-summary"><div><span class="stat-value">${p.rating.toFixed(1)}</span><span class="muted ms-2">Elo</span></div><div><strong>${esc(rankings[(p.rank || 1) - 1])}</strong><div class="subtle">${p.ratedMatches} rated doubles matches · K=${data.settings.kFactor}</div></div></div><p class="subtle mt-3">${p.manualLocked ? "An administrator has locked your skill category. Your numerical rating still tracks rated matches." : `Categories use configurable thresholds with a ${data.settings.hysteresis}-point buffer. At least ${data.settings.minimumRatedMatches} rated matches are required for automatic confirmation.`}</p><div class="chart-container"><canvas id="rating-progression" aria-label="Doubles Elo progression for this history page"></canvas></div><div class="panel-header mt-4"><h3>Rating history</h3><span class="subtle">${data.total} adjustments · page ${data.page}</span></div>${data.history.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Source</th><th>Previous</th><th>Adjustment</th><th>New rating</th><th>Skill category</th></tr></thead><tbody>${data.history.map((h) => `<tr><td>${date(h.timestamp)} ${time(h.timestamp)}</td><td>${h.kind === "match" ? `<a href="#/events/${esc(h.matchId?.eventId || "")}" title="Match ${esc(h.matchId?._id || "")}">Rated match · ${esc(String(h.matchId?._id || "").slice(-6))}</a>` : `Manual decision<br><span class="subtle">${esc(h.reason)}</span>`}</td><td>${h.previousRating.toFixed(1)}</td><td><span class="badge ${h.adjustment > 0 ? "green" : ""}">${h.adjustment >= 0 ? "+" : ""}${h.adjustment.toFixed(1)}</span></td><td><strong>${h.newRating.toFixed(1)}</strong></td><td>${esc(rankings[h.newRank - 1])}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Your first rated result will start your progression chart.</div>'}<div class="form-actions"><button class="btn btn-secondary btn-sm" id="rating-previous" ${page === 1 ? "disabled" : ""}>Newer history</button><button class="btn btn-secondary btn-sm" id="rating-next" ${!data.hasMore ? "disabled" : ""}>Older history</button></div>`;
    const chronological = [...data.history].reverse();
    drawChart(
      "rating-progression",
      "line",
      chronological.map((h) => date(h.timestamp)),
      [
        {
          label: "Doubles rating",
          data: chronological.map((h) => h.newRating),
          borderColor: "#7fa015",
          backgroundColor: "#b5e61d25",
          tension: 0.15,
          pointRadius: 3,
        },
      ],
      {
        scales: { y: { beginAtZero: false }, x: { grid: { display: false } } },
      },
    );
    section.querySelector("#rating-previous").onclick = async () => {
      page--;
      await load();
    };
    section.querySelector("#rating-next").onclick = async () => {
      page++;
      await load();
    };
  }
  await load();
}

export async function mountRatingSettings(container, rankings) {
  const { rating } = await api("/admin/ratings/settings");
  const section = document.createElement("section");
  section.className = "panel mt-4";
  container.append(section);
  section.innerHTML = `<h3 class="mb-3">Automatic doubles ranking</h3><p class="subtle">Use team-average Elo for rated open play and tournaments. Changes apply to newly rated matches; replay preserves the policy captured for each historical result.</p><form id="rating-settings-form"><label class="d-block mb-4"><input type="checkbox" name="enabled" ${rating.enabled ? "checked" : ""}> Enable automatic ranking</label><div class="form-grid"><div><label class="form-label" for="rating-k">K-factor</label><input type="number" class="form-control" name="kFactor" id="rating-k" min="1" max="128" step="any" required value="${rating.kFactor}"></div><div><label class="form-label" for="rating-minimum">Rated matches before confirmation</label><input type="number" class="form-control" name="minimumRatedMatches" id="rating-minimum" min="10" max="1000" required value="${rating.minimumRatedMatches}"></div><div><label class="form-label" for="rating-buffer">Hysteresis buffer (points)</label><input type="number" class="form-control" name="hysteresis" id="rating-buffer" min="0" max="100" step="any" required value="${rating.hysteresis}"></div></div><div class="divider"></div><h3 class="mb-3">Promotion & demotion boundaries</h3><p class="subtle">Promotion requires rating ≥ promotion boundary + buffer. Demotion requires rating &lt; demotion boundary − buffer. Each column must be strictly increasing.</p><div class="table-wrap"><table><thead><tr><th>Between categories</th><th>Promotion boundary</th><th>Demotion boundary</th></tr></thead><tbody>${rating.promotionThresholds.map((v, i) => `<tr><td>${esc(rankings[i])} ↔ ${esc(rankings[i + 1])}</td><td><input class="form-control promotion-threshold" type="number" min="0" max="10000" step="any" value="${v}" aria-label="Promotion to ${esc(rankings[i + 1])}" required></td><td><input class="form-control demotion-threshold" type="number" min="0" max="10000" step="any" value="${rating.demotionThresholds[i]}" aria-label="Demotion from ${esc(rankings[i + 1])}" required></td></tr>`).join("")}</tbody></table></div><div class="form-actions"><button class="btn btn-primary">Save automatic ranking settings</button></div></form><div class="divider"></div><h3>Recalculate rating history</h3><p class="subtle">Replay eligible finalized results and documented overrides in chronological order. Legacy results remain unrated until explicitly marked as rated in match management.</p><button class="btn btn-secondary" id="recalculate-ratings">Recalculate doubles ratings</button>`;
  section.querySelector("#rating-settings-form").onsubmit = async (e) => {
    e.preventDefault();
    const values = new FormData(e.target);
    const body = {
      enabled: e.target.elements.enabled.checked,
      kFactor: Number(values.get("kFactor")),
      minimumRatedMatches: Number(values.get("minimumRatedMatches")),
      hysteresis: Number(values.get("hysteresis")),
      promotionThresholds: [
        ...section.querySelectorAll(".promotion-threshold"),
      ].map((x) => Number(x.value)),
      demotionThresholds: [
        ...section.querySelectorAll(".demotion-threshold"),
      ].map((x) => Number(x.value)),
    };
    const button = e.submitter;
    button.disabled = true;
    try {
      await api("/admin/ratings/settings", "PUT", body);
      toast("Automatic ranking settings saved");
    } finally {
      button.disabled = false;
    }
  };
  section.querySelector("#recalculate-ratings").onclick = async () => {
    const result = await Swal.fire({
      title: "Recalculate doubles ratings?",
      text: "All affected history and current ratings will be rebuilt from official results and manual decisions.",
      input: "text",
      inputLabel: "Reason",
      showCancelButton: true,
      inputValidator: (v) =>
        v.trim().length < 3 ? "Enter a documented reason" : undefined,
    });
    if (result.isConfirmed) {
      await api("/admin/ratings/recalculate", "POST", { reason: result.value });
      toast("Ratings recalculated");
    }
  };
}

export async function manualRatingOverride(player, rankings) {
  const result = await Swal.fire({
    title: `Manage ${player.fullName}'s skill rating`,
    html: `<label for="override-action">Action</label><select id="override-action" class="form-select mb-3"><option value="manual">Manual override (lock category)</option><option value="release">Release category to automatic ranking</option></select><label for="override-rank">Skill category</label><select class="form-select mb-3" id="override-rank">${rankings.map((r, i) => `<option value="${i + 1}" ${i + 1 === (player.officialRanking || player.provisionalRanking) ? "selected" : ""}>${r}</option>`).join("")}</select><label for="override-rating">Numerical rating (optional)</label><input class="form-control mb-3" id="override-rating" type="number" min="-10000" max="10000" step="any" placeholder="Default: category midpoint"><label for="override-reason">Documented reason</label><input class="form-control" id="override-reason" maxlength="500"><p class="subtle mt-3">A manual override locks the category until released. Numerical Elo continues to change with rated results.</p>`,
    showCancelButton: true,
    preConfirm: () => {
      const action = document.querySelector("#override-action").value,
        reason = document.querySelector("#override-reason").value;
      if (reason.trim().length < 3)
        return Swal.showValidationMessage("Enter a reason");
      const value = { action, reason };
      if (action === "manual") {
        value.ranking = Number(document.querySelector("#override-rank").value);
        const rating = document.querySelector("#override-rating").value;
        if (rating !== "") value.rating = Number(rating);
      }
      return value;
    },
  });
  if (result.isConfirmed) {
    await api(
      `/admin/players/${player._id}/rating-override`,
      "PUT",
      result.value,
    );
    toast("Rating decision saved");
    return true;
  }
  return false;
}
