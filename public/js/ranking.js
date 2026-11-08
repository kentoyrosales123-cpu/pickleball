import { reviewPickleQue } from "./pickle-que.js";
import { api, esc, avatar, date, toast, confirm } from "./api.js";
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
const badge = (p) =>
  `<span class="rank-emblem rank-${esc(p.rankTier.toLowerCase())}"><span aria-hidden="true">✦</span> ${esc(p.rankTier)} ${esc(p.rankDivision || "")}</span>`;
const meter = (title, points, description) =>
  `<div class="rank-meter"><div class="d-flex justify-content-between"><strong>${title}</strong><span>${points}/100</span></div><progress max="100" value="${points}" aria-label="${title}"></progress><small>${100 - points} points to activation · ${description}</small></div>`;
export async function mountStarRanking(container, user, chart) {
  const [data, history] = await Promise.all([
    api(`/ranking/players/${user.id}`),
    api(`/ranking/players/${user.id}/history`),
  ]);
  const p = data.profile,
    section = document.createElement("section");
  section.className = "panel rank-panel mb-4";
  const grid = container.querySelector(".stats-grid");
  if (grid) grid.after(section);
  else container.append(section);
  section.innerHTML = `<div class="panel-header"><div><span class="eyebrow">YOUR RANKED JOURNEY</span><h3 class="mt-2">Every rally moves you forward</h3></div><a class="btn btn-secondary btn-sm" href="#/ranking">Ranked leaderboard</a></div><div class="rank-overview"><div>${badge(p)}<div class="rank-stars" aria-label="${p.stars} stars">${p.rankTier === "Legend" ? `★ ${p.stars}` : "★".repeat(p.stars) + "☆".repeat(5 - p.stars)}</div><p>${p.rankStars} cumulative stars · ${p.nextRank ? `${5 - p.stars} to ${esc(p.nextRank)}` : "Unlimited Legend stars"}</p><small>Highest: ${esc(data.highestRank.rankTier)} ${esc(data.highestRank.rankDivision || "")} · ${p.highestRank} stars</small></div><div class="rank-numbers"><div><strong>${p.rankedMatches}</strong><small>Ranked matches</small></div><div><strong>${data.winPercentage.toFixed(1)}%</strong><small>Win rate</small></div><div><strong>${p.totalWins} / ${p.totalLosses}</strong><small>Wins / losses</small></div><div><strong>${p.currentWinStreak} / ${p.longestWinStreak}</strong><small>Current / best streak</small></div></div></div>${meter("Star protection", p.protectionPoints, "earned on losses")}${meter("Double-star reward", p.doubleStarPoints, "earned on wins")}<div class="panel-header mt-4"><h3>Recent ranked results</h3><span class="subtle">Verified by your club</span></div>${
    history.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Result</th><th>Stars</th><th>Rank</th><th>Reward</th></tr></thead><tbody>${history.rows
          .slice(0, 8)
          .map(
            (h) =>
              `<tr><td>${date(h.timestamp)}</td><td>${h.kind === "adjustment" ? "Admin adjustment" : h.won ? "Win" : "Loss"}</td><td>${h.starsChanged >= 0 ? "+" : ""}${h.starsChanged}</td><td>${esc(h.after.rankTier)} ${esc(h.after.rankDivision || "")}</td><td>${h.protectionActivated ? "🛡 STAR PROTECTED" : h.doubleStarActivated ? "★ DOUBLE STAR BONUS" : h.rankPromoted ? "Promoted" : h.rankDemoted ? "Demoted" : "—"}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="empty">Join a ranked event to earn your first star.</p>'
  }${p.mmr !== undefined ? '<div class="chart-container mt-4"><canvas id="star-mmr-chart" aria-label="Ranked matchmaking rating history"></canvas></div>' : ""}`;
  if (p.mmr !== undefined && chart) {
    const rows = history.rows
      .filter((h) => h.after.mmr !== undefined)
      .reverse();
    chart(
      "star-mmr-chart",
      "line",
      rows.map((h) => date(h.timestamp)),
      [
        {
          label: "Ranked MMR",
          data: rows.map((h) => h.after.mmr),
          borderColor: "#7fa015",
          tension: 0.2,
        },
      ],
    );
  }
}
export async function rankingPage(container, user, chart) {
  const admin = user.role === "admin",
    [seasons, events] = await Promise.all([
      api("/ranking/seasons"),
      api("/events"),
    ]);
  container.innerHTML = `<div class="page-heading"><div><h1>Ranked clubhouse</h1><p>From Rookie to Legend. Earn your place, one verified match at a time.</p></div></div><div id="rank-profile"></div><section class="panel"><div class="panel-header"><h3>Ranked leaderboard</h3><span class="badge green">LIVE</span></div><div class="filters"><input id="star-search" class="form-control" placeholder="Search players" aria-label="Search ranked players"><select id="star-tier" class="form-select" aria-label="Rank tier"><option value="">All tiers</option>${tiers.map((t) => `<option>${t}</option>`).join("")}</select><select id="star-period" class="form-select" aria-label="Ranking period"><option value="current">Current rank</option><option value="month">Monthly performance (UTC)</option><option value="season">Season rankings</option><option value="all-time">All-time match stars</option></select><select id="star-season" class="form-select" aria-label="Season"><option value="">Current season</option>${seasons.seasons.map((s) => `<option value="${s._id}">${esc(s.name)}</option>`).join("")}</select><select id="star-event" class="form-select" aria-label="Event participants"><option value="">All players</option>${events.events.map((e) => `<option value="${e._id}">${esc(e.eventName)}</option>`).join("")}</select></div><p class="subtle" id="star-label"></p><div id="star-table"></div><div class="form-actions"><button id="star-prev" class="btn btn-secondary btn-sm">Previous</button><button id="star-next" class="btn btn-secondary btn-sm">Next</button></div></section>${admin ? '<div id="rank-admin" class="mt-4"></div>' : ""}`;
  if (!admin)
    await mountStarRanking(
      container.querySelector("#rank-profile"),
      user,
      chart,
    );
  let page = 1;
  const load = async () => {
    const q = new URLSearchParams({
      period: container.querySelector("#star-period").value,
      page,
    });
    for (const [key, selector] of [
      ["tier", "#star-tier"],
      ["seasonId", "#star-season"],
      ["eventId", "#star-event"],
      ["search", "#star-search"],
    ]) {
      const value = container.querySelector(selector).value;
      if (value) q.set(key, value);
    }
    const data = await api(`/ranking/leaderboard?${q}`);
    container.querySelector("#star-label").textContent =
      `${data.label} · ${data.total} players · Page ${page}`;
    container.querySelector("#star-table").innerHTML =
      `<div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Rank</th><th>Stars</th><th>Wins</th><th>Win rate</th>${admin ? "<th>Manage</th>" : ""}</tr></thead><tbody>${data.rows.map((p) => `<tr><td>${p.position}</td><td><div class="d-flex align-items-center gap-2">${avatar(p)} ${esc(p.fullName)}</div></td><td>${badge(p)}</td><td><strong>${p.totalStars}</strong></td><td>${p.totalWins}</td><td>${p.winPercentage.toFixed(1)}%</td>${admin ? `<td><button class="btn btn-secondary btn-sm rank-inspect" data-id="${p.playerId}">History / adjust</button> <button class="btn btn-secondary btn-sm rank-pickle-que" data-id="${p.playerId}">Pickle Que review</button></td>` : ""}</tr>`).join("") || '<tr><td colspan="7">No ranked players match these filters.</td></tr>'}</tbody></table></div>`;
    container.querySelector("#star-prev").disabled = page === 1;
    container.querySelector("#star-next").disabled = page * 50 >= data.total;
    for (const button of container.querySelectorAll(".rank-pickle-que"))
      button.onclick = async () => {
        if (await reviewPickleQue(button.dataset.id)) await load();
      };
    for (const button of container.querySelectorAll(".rank-inspect"))
      button.onclick = () => inspectPlayer(button.dataset.id, load);
  };
  for (const element of container.querySelectorAll(
    ".filters input,.filters select",
  ))
    element.onchange = () => {
      page = 1;
      load().catch((e) => toast(e.message));
    };
  container.querySelector("#star-prev").onclick = () => {
    page--;
    load().catch((e) => toast(e.message));
  };
  container.querySelector("#star-next").onclick = () => {
    page++;
    load().catch((e) => toast(e.message));
  };
  await load();
  if (admin)
    await adminRanking(
      container.querySelector("#rank-admin"),
      events.events,
      seasons.seasons,
    );
}
async function inspectPlayer(id, reload) {
  const [data, history] = await Promise.all([
    api(`/ranking/players/${id}`),
    api(`/ranking/players/${id}/history`),
  ]);
  const result = await Swal.fire({
    title: data.user.fullName,
    html: `${badge(data.profile)}<p>${data.profile.rankStars} stars · ${data.profile.mmr.toFixed(1)} MMR</p><div class="table-wrap"><table><tbody>${history.rows.map((h) => `<tr><td>${date(h.timestamp)}</td><td>${h.starsChanged >= 0 ? "+" : ""}${h.starsChanged}</td><td>${esc(h.reason || (h.protectionActivated ? "Star protected" : h.doubleStarActivated ? "Double star" : h.won ? "Win" : "Loss"))}</td></tr>`).join("")}</tbody></table></div><label for="adjust-stars">New cumulative stars</label><input class="swal2-input" id="adjust-stars" type="number" min="0" max="1000000" value="${data.profile.rankStars}"><label for="adjust-reason">Required adjustment reason</label><input class="swal2-input" id="adjust-reason" maxlength="500">`,
    showCancelButton: true,
    confirmButtonText: "Record adjustment",
    preConfirm: () => {
      const rankStars = Number(document.querySelector("#adjust-stars").value),
        reason = document.querySelector("#adjust-reason").value.trim();
      if (
        !Number.isSafeInteger(rankStars) ||
        rankStars < 0 ||
        reason.length < 3
      ) {
        Swal.showValidationMessage(
          "Enter valid stars and a reason of at least 3 characters",
        );
        return false;
      }
      return { rankStars, reason };
    },
  });
  if (result.isConfirmed) {
    await api(`/admin/ranking/players/${id}`, "PATCH", result.value);
    toast("Rank adjustment recorded");
    await reload();
  }
}
async function adminRanking(container, events, seasons) {
  const settings = await api("/admin/ranking/settings");
  container.innerHTML = `<section class="panel mb-4"><h3>Ranked event operations</h3><p>Use the event workspace to register players, edit teams, publish court schedules, and verify scores.</p><div class="filters"><select id="rank-operation-event" class="form-select" aria-label="Event to manage"><option value="">Select an event</option>${events.map((e) => `<option value="${e._id}">${esc(e.eventName)}</option>`).join("")}</select><a id="rank-workspace" class="btn btn-secondary" href="#/events">Open event workspace</a></div><div id="rank-roster"></div><div id="rank-preview"></div></section><section class="panel mb-4"><h3>MMR visibility</h3><form id="rank-visibility"><label class="my-3"><input name="showMMR" type="checkbox" ${settings.showMMR ? "checked" : ""}> Allow players to see ranked MMR and history charts</label><input name="reason" class="form-control" placeholder="Reason for changing visibility" aria-label="Visibility reason" minlength="3" maxlength="500" required><button class="btn btn-primary mt-3">Save visibility</button></form></section><section class="panel"><h3>Ranking seasons</h3><p>A new season closes the current season and preserves its final standings. Lifetime wins and losses remain intact.</p><div class="table-wrap"><table><thead><tr><th>Season</th><th>Dates</th><th>Status</th><th>Reset</th></tr></thead><tbody>${seasons.map((s) => `<tr><td>${esc(s.name)}</td><td>${date(s.startDate)} – ${date(s.endDate)}</td><td>${s.status === "active" && new Date(s.endDate) < new Date() ? "Ended" : esc(s.status)}</td><td>${esc(s.resetPolicy)}</td></tr>`).join("")}</tbody></table></div><form id="rank-season-form" class="mt-4"><div class="form-grid"><div><label class="form-label" for="season-name">Season name</label><input id="season-name" name="name" class="form-control" required maxlength="100"></div><div><label class="form-label" for="season-end">End date and time</label><input id="season-end" name="endDate" type="datetime-local" class="form-control" required></div><div><label class="form-label" for="season-reset">Reset policy</label><select id="season-reset" name="resetPolicy" class="form-select"><option value="none">No star reset</option><option value="partial">Partial star reset</option><option value="placement">Placement recalibration</option></select></div><div><label class="form-label" for="season-keep">Fraction of stars to keep (partial)</label><input id="season-keep" name="keepFraction" type="number" min="0" max="1" step="0.05" value="0.5" class="form-control" required></div>${Object.entries(
    settings.rules,
  )
    .map(
      ([key, value]) =>
        `<div><label class="form-label" for="rule-${key}">${esc(key.replace(/([A-Z])/g, " $1"))}</label><input id="rule-${key}" name="${key}" type="number" min="1" max="${key.includes("Points") ? 99 : key === "strongerGap" ? 2000 : key === "placementMatches" ? 100 : 128}" value="${value}" class="form-control" required></div>`,
    )
    .join(
      "",
    )}<div class="wide"><label class="form-label" for="season-reason">Reason</label><input id="season-reason" name="reason" minlength="3" maxlength="500" class="form-control" required></div></div><p class="subtle mt-3">Placement recalibration resets stars to zero, moves MMR halfway toward 1000, and restarts ten placement matches. Both reward meters reset at season start.</p><button class="btn btn-primary">Start season now</button></form></section>`;
  container.querySelector("#rank-visibility").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/admin/ranking/settings", "PATCH", {
        showMMR: e.target.elements.showMMR.checked,
        reason: e.target.elements.reason.value,
      });
      toast("Visibility saved");
    } catch (error) {
      toast(error.message);
    }
  };
  container.querySelector("#rank-season-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      rankingRules = Object.fromEntries(
        Object.keys(settings.rules).map((key) => [key, Number(f.get(key))]),
      );
    if (
      !(await confirm(
        "Start this season?",
        "The current season will close. The selected reset applies immediately.",
      ))
    )
      return;
    try {
      await api("/admin/ranking/seasons", "POST", {
        name: f.get("name"),
        endDate: new Date(f.get("endDate")).toISOString(),
        resetPolicy: f.get("resetPolicy"),
        keepFraction: Number(f.get("keepFraction")),
        rankingRules,
        reason: f.get("reason"),
      });
      toast("Season started");
      location.reload();
    } catch (error) {
      toast(error.message);
    }
  };
  container.querySelector("#rank-operation-event").onchange = async (e) => {
    const id = e.target.value,
      roster = container.querySelector("#rank-roster"),
      preview = container.querySelector("#rank-preview");
    preview.innerHTML = "";
    roster.innerHTML = "";
    if (!id) return;
    container.querySelector("#rank-workspace").href = `#/events/${id}`;
    try {
      const data = await api(`/events/${id}/participants`);
      const rows = data.participants || data.registrations || [];
      roster.innerHTML = `<p>Select confirmed players for a balanced court preview.</p><div class="rank-roster">${rows
        .filter((r) => r.registrationStatus === "confirmed")
        .map(
          (r) =>
            `<label><input type="checkbox" value="${esc(r.userId?._id || r._id)}" checked> ${esc(r.userId?.fullName || r.fullName)}</label>`,
        )
        .join(
          "",
        )}</div><label for="rank-rotation" class="form-label mt-3">Waiting-player rotation</label><select id="rank-rotation" class="form-select"><option value="least-played">Fewest matches first</option><option value="registration">Registration order</option></select><button id="rank-generate" class="btn btn-primary mt-3">GENERATE BALANCED TEAMS</button>`;
      roster.querySelector("#rank-generate").onclick = async () => {
        try {
          const result = await api("/ranking/matchmaking/preview", "POST", {
            eventId: id,
            playerIds: [...roster.querySelectorAll("input:checked")].map(
              (i) => i.value,
            ),
            rotation: roster.querySelector("#rank-rotation").value,
          });
          const names = new Map(
            rows.map((r) => [
              String(r.userId?._id || r._id),
              r.userId?.fullName || r.fullName,
            ]),
          );
          preview.innerHTML = `<h3 class="mt-4">Court preview</h3>${result.matches.map((m) => `<p><strong>Court ${esc(m.courtNumber)}</strong>: ${m.teamA.map((p) => esc(names.get(p))).join(" + ")} vs ${m.teamB.map((p) => esc(names.get(p))).join(" + ")} <span class="subtle">(${m.gap.toFixed(1)} MMR gap)</span></p>`).join("")}<p>Waiting: ${result.waiting.map((p) => esc(names.get(p))).join(", ") || "Nobody"}</p><p class="subtle">Save teams as a draft, then review assignments and publish the schedule in the event workspace.</p><button id="rank-save-preview" class="btn btn-primary">Save team draft</button>`;
          preview.querySelector("#rank-save-preview").onclick = async () => {
            try {
              await api(`/events/${id}/teams`, "PUT", {
                teams: result.matches.flatMap((m) => [m.teamA, m.teamB]),
              });
              toast("Team draft saved");
              location.hash = `#/events/${id}`;
            } catch (error) {
              toast(error.message);
            }
          };
        } catch (error) {
          toast(error.message);
        }
      };
    } catch (error) {
      toast(error.message);
    }
  };
}
