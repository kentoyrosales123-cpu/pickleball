import { api, esc, date, avatar } from "./api.js";
export function seasonCountdown(endDate, now = Date.now()) {
  const remaining = Math.max(0, Math.ceil((+new Date(endDate) - now) / 1000));
  if (!remaining) return "Season ended — finalizing standings";
  return `${Math.floor(remaining / 86400)}d ${Math.floor(remaining / 3600) % 24}h ${Math.floor(remaining / 60) % 60}m ${remaining % 60}s remaining`;
}
export async function mountSeasons(container, seasons, userId) {
  const active = seasons.find(
    (s) => s.status === "active" && +new Date(s.endDate) > Date.now(),
  );
  container.innerHTML = `<section class="panel mb-4"><h3>${active ? esc(active.name) : "Between seasons"}</h3>${active ? `<p>${date(active.startDate)} – ${date(active.endDate)}</p><p id="season-countdown" class="fw-bold"></p>` : "<p>No season is currently open. Your skill rating and match history are preserved.</p>"}<p class="subtle">Season stars measure this competition. Skill ratings carry over to keep teams balanced. A new season is started by your Super Admin.</p></section><section class="panel mb-4"><h3>Season results & badges</h3><label class="form-label" for="season-archive">Choose a season</label><select id="season-archive" class="form-select"><option value="">Select a season</option>${seasons.map((s) => `<option value="${esc(s._id)}">${esc(s.name)} — ${s.status === "closed" ? "Archived" : "Current"}</option>`).join("")}</select><div id="season-results" class="mt-3"></div></section>`;
  const select = container.querySelector("#season-archive");
  const results = container.querySelector("#season-results");
  let disposed = false,
    requestId = 0;
  const load = async () => {
    const currentRequest = ++requestId;
    if (!select.value) {
      results.textContent = "Choose a season to see its standings and badges.";
      return;
    }
    results.textContent = "Loading season results…";
    try {
      const data = await api(`/ranking/seasons/${select.value}/results`);
      if (disposed || requestId !== currentRequest) return;
      const own = data.rows.find((row) => row.playerId === userId);
      results.innerHTML = `<p>${data.archived ? "Archived results. Audited score corrections can update these standings and badges." : "Live season standings. Badges are awarded when the season closes."}</p>${own ? `<p><strong>Your season:</strong> #${own.position} · ${own.wins} wins / ${own.losses} losses ${own.badges.map((b) => `<span class="badge green">${esc(b)}</span>`).join(" ")}</p>` : ""}<div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>${data.archived ? "Final" : "Current"} rank</th><th>Highest rank</th><th>Wins / losses</th><th>Badges</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td>${row.position}</td><td>${avatar(row)} ${esc(row.fullName)}</td><td>${esc(row.finalRank.rankTier)} ${esc(row.finalRank.rankDivision || "")} · ${row.finalStars} stars</td><td>${esc(row.highestRank.rankTier)} ${esc(row.highestRank.rankDivision || "")} · ${row.highestStars} stars</td><td>${row.wins} / ${row.losses}</td><td>${row.badges.map((b) => `<span class="badge green">${esc(b)}</span>`).join(" ") || "Pending"}</td></tr>`).join("") || '<tr><td colspan="6">No ranked matches recorded for this season.</td></tr>'}</tbody></table></div>`;
    } catch (error) {
      if (!disposed && requestId === currentRequest)
        results.textContent = error.message;
    }
  };
  select.value = active?._id || seasons[0]?._id || "";
  select.onchange = load;
  await load();
  const tick = () => {
    const countdown = container.querySelector("#season-countdown");
    if (countdown && active)
      countdown.textContent = seasonCountdown(active.endDate);
  };
  tick();
  const timer = active ? setInterval(tick, 1000) : null;
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
