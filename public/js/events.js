import { renderQueue } from "./queue.js";
import {
  api,
  esc,
  icon,
  date,
  time,
  initials,
  empty,
  toast,
  confirm,
  download,
} from "./api.js";
const teamName = (t) =>
  t?.players?.map((p) => p.fullName || "Player").join(" & ") ||
  "Awaiting advancement";
const ratingValue = (p) =>
  p.doublesRating ??
  100 + ((p.officialRanking || p.provisionalRanking) - 1) * 200;
const input = (label, name, value = "", type = "text", extra = "") =>
  `<div><label class="form-label" for="${name}">${label}</label><input class="form-control" name="${name}" id="${name}" value="${esc(value)}" type="${type}" ${extra}></div>`;
const select = (label, name, values, current) =>
  `<div><label class="form-label" for="${name}">${label}</label><select class="form-select" name="${name}" id="${name}">${values
    .map((v) => {
      const [key, text] = Array.isArray(v) ? v : [v, v.replaceAll("-", " ")];
      return `<option value="${key}" ${String(current) === String(key) ? "selected" : ""}>${text}</option>`;
    })
    .join("")}</select></div>`;
const localDate = (value) => {
  const d = new Date(value);
  return new Date(+d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export async function eventForm(content, state, id) {
  if (!["admin", "super-admin"].includes(state.user.role))
    throw new Error("Administrator access required");
  const now = Date.now();
  const event = id
    ? (await api(`/events/${id}`)).event
    : {
        eventName: "",
        eventType: "open-play",
        description: "",
        location: "",
        startDateTime: new Date(now + 8 * 86400_000),
        endDateTime: new Date(now + 8 * 86400_000 + 4 * 3600_000),
        registrationOpen: new Date(now),
        registrationDeadline: new Date(now + 7 * 86400_000),
        capacity: 24,
        minRanking: 1,
        maxRanking: 12,
        courts: ["1", "2"],
        fee: 0,
        format: "random",
        teamMode: "random",
        targetPoints: 11,
        winningMargin: 2,
        bestOf: 1,
        rounds: 3,
        matchDuration: 20,
        status: "registration-open",
        waitlistEnabled: true,
        grandFinalReset: true,
        groupCount: 2,
        rated: false,
      };
  content.innerHTML = `<div class="page-heading"><div><a href="#/events" class="subtle">← All events</a><h1 class="mt-2">${id ? "Fine-tune the details." : "Bring your next event to life."}</h1><p>Set up the courts. We’ll help with the rest.</p></div></div><form class="panel" id="event-form"><h3 class="mb-4">The essentials</h3><div class="form-grid">${input("Event name", "eventName", event.eventName, "text", 'required maxlength="120"')}${select(
    "Event type",
    "eventType",
    [
      ["open-play", "Open play"],
      ["tournament", "Tournament"],
    ],
    event.eventType,
  )}${input("Venue / location", "location", event.location, "text", "required")}${input("Court names (comma-separated)", "courts", event.courts.join(", "), "text", "required")}<div class="wide"><label for="description" class="form-label">Description</label><textarea class="form-control" name="description" id="description" rows="3">${esc(event.description)}</textarea></div>${input("Start (your local time)", "startDateTime", localDate(event.startDateTime), "datetime-local", "required")}${input("End (your local time)", "endDateTime", localDate(event.endDateTime), "datetime-local", "required")}${input("Registration opens", "registrationOpen", localDate(event.registrationOpen), "datetime-local", "required")}${input("Registration deadline", "registrationDeadline", localDate(event.registrationDeadline), "datetime-local", "required")}${input("Player capacity", "capacity", event.capacity, "number", 'required min="4" max="256"')}${input("Registration fee (PHP)", "fee", event.fee, "number", 'required min="0" step="0.01"')}${select(
    "Minimum skill level",
    "minRanking",
    state.rankings.map((r, i) => [i + 1, `${i + 1} · ${r}`]),
    event.minRanking,
  )}${select(
    "Maximum skill level",
    "maxRanking",
    state.rankings.map((r, i) => [i + 1, `${i + 1} · ${r}`]),
    event.maxRanking,
  )}</div><div class="divider"></div><h3 class="mb-4">Teams & scoring</h3><div class="form-grid">${select("Match / tournament format", "format", [["random", "Random queue (new teams every round)"], "balanced", "round-robin", "rotating", "single-elimination", "double-elimination", "group-knockout"], event.format)}${select("Team assignment method", "teamMode", ["random", "balanced", "same-rank", "manual", "player-selected"], event.teamMode)}${select(
    "Target points",
    "targetPoints",
    [
      [11, "11 points"],
      [15, "15 points"],
      [21, "21 points"],
    ],
    event.targetPoints,
  )}${input("Winning margin", "winningMargin", event.winningMargin, "number", 'required min="1" max="10"')}${select(
    "Games per match",
    "bestOf",
    [
      [1, "Single game"],
      [3, "Best of three"],
    ],
    event.bestOf,
  )}${input("Match duration (minutes)", "matchDuration", event.matchDuration, "number", 'required min="5" max="180"')}${input("Rounds (random, balanced, or rotating)", "rounds", event.rounds, "number", 'required min="1" max="30"')}${input("Groups (group stage + knockout)", "groupCount", event.groupCount, "number", 'required min="2" max="8"')}${select("Event status", "status", ["draft", "published", "registration-open", "registration-closed", "ongoing", "completed", "cancelled"], event.status)}<div class="pt-4"><label class="d-block mb-2"><input type="checkbox" name="rated" ${event.rated ? "checked" : ""}> Enable rankings for this event (stars and win/loss records)</label><label class="d-block mb-2"><input type="checkbox" name="waitlistEnabled" ${event.waitlistEnabled ? "checked" : ""}> Enable waiting list</label><label><input type="checkbox" name="grandFinalReset" ${event.grandFinalReset ? "checked" : ""}> Grand-final reset in double elimination</label></div></div><p class="subtle mt-4">Random queue shuffles teammates and opponents every round, with fewer-played players going first. Pairings may repeat by chance. All dates use your browser’s local timezone. Tournament matches are scheduled as their participants become known. Fees are recorded for club administration; payment collection is outside this application.</p><div id="form-error" role="alert"></div><div class="form-actions"><a class="btn btn-secondary" href="#/events">Cancel</a><button type="submit" class="btn btn-primary">${id ? "Save changes" : "Create event"}</button></div></form>`;
  const formats = document.querySelector("#format");
  const updateFormats = () => {
    const tournament =
      document.querySelector("#eventType").value === "tournament";
    [...formats.options].forEach(
      (o) =>
        (o.disabled = !(
          tournament
            ? [
                "single-elimination",
                "double-elimination",
                "round-robin",
                "group-knockout",
              ]
            : ["random", "balanced", "round-robin", "rotating"]
        ).includes(o.value)),
    );
    if (formats.selectedOptions[0].disabled)
      formats.value = tournament ? "single-elimination" : "random";
  };
  document.querySelector("#eventType").onchange = updateFormats;
  updateFormats();
  document.querySelector("#event-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.submitter;
    b.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(e.target));
      for (const k of [
        "startDateTime",
        "endDateTime",
        "registrationOpen",
        "registrationDeadline",
      ])
        data[k] = new Date(data[k]).toISOString();
      data.courts = data.courts
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      data.waitlistEnabled = e.target.elements.waitlistEnabled.checked;
      data.rated = e.target.elements.rated.checked;
      data.grandFinalReset = e.target.elements.grandFinalReset.checked;
      const result = await api(
        id ? `/events/${id}` : "/events",
        id ? "PUT" : "POST",
        data,
      );
      toast(id ? "Event updated" : "Event created");
      location.hash = `#/events/${result.event._id}`;
    } catch (err) {
      document.querySelector("#form-error").innerHTML =
        `<div class="error-message">${esc(err.message)}</div>`;
    } finally {
      b.disabled = false;
    }
  };
}
export async function eventDetail(content, state, id) {
  const { event } = await api(`/events/${id}`),
    { events } = await api("/events");
  const registration = events.find((e) => e._id === id)?.registration;
  const admin = ["admin", "super-admin"].includes(state.user.role);
  content.innerHTML = `<div class="page-heading"><div><a href="#/events" class="subtle">← All events</a><div class="mt-3 mb-2"><span class="badge green">${event.eventType === "tournament" ? "TOURNAMENT" : "OPEN PLAY"}</span> <span class="badge">${esc(event.status.replaceAll("-", " "))}</span></div><h1>${esc(event.eventName)}</h1><p>${esc(event.location)} · ${date(event.startDateTime)} · ${time(event.startDateTime)}–${time(event.endDateTime)}</p></div>${admin ? `<a class="btn btn-secondary" href="#/events/${id}/edit">${icon("sliders-horizontal")} Edit event</a>` : ""}</div><div class="event-tabs"><button data-tab="overview" class="active">Overview</button>${admin ? '<button data-tab="participants">Participants</button>' : ""}${admin && event.eventType === "open-play" && event.format === "random" ? '<button data-tab="queue">Live queue</button>' : ""}<button data-tab="teams">Teams</button><button data-tab="rankings">Rankings</button><button data-tab="matches">Matches${event.eventType === "tournament" ? " & bracket" : ""}</button></div><div id="event-content"></div>`;
  const container = document.querySelector("#event-content");
  async function overview() {
    const level = state.user.officialRanking || state.user.provisionalRanking;
    const eligible = level >= event.minRanking && level <= event.maxRanking;
    const open =
      event.status === "registration-open" &&
      new Date() >= new Date(event.registrationOpen) &&
      new Date() < new Date(event.registrationDeadline);
    const joined = ["confirmed", "waitlisted"].includes(registration);
    container.innerHTML = `<div class="stats-grid"><div class="stat-card"><div class="stat-top">Player spots</div><div class="stat-value">${event.confirmedCount}<span class="muted fs-6"> / ${event.capacity}</span></div><div class="stat-foot">${event.waitlistEnabled ? "Waiting list enabled" : "Limited capacity"}</div></div><div class="stat-card"><div class="stat-top">Skill levels</div><div class="stat-value">${event.minRanking}–${event.maxRanking}</div><div class="stat-foot">${esc(state.rankings[event.minRanking - 1])} and above</div></div><div class="stat-card"><div class="stat-top">Courts</div><div class="stat-value">${event.courts.length}</div><div class="stat-foot">${event.courts.map(esc).join(", ")}</div></div><div class="stat-card"><div class="stat-top">Registration fee</div><div class="stat-value">${event.fee ? `₱${event.fee.toLocaleString()}` : "Free"}</div><div class="stat-foot">${event.fee ? "Arrange payment with your club" : "Just bring your paddle"}</div></div></div><div class="profile-grid"><div class="panel"><h3>About this event</h3><p class="mt-3" style="white-space:pre-line">${esc(event.description) || "A chance to meet your club on court."}</p><div class="divider"></div><h3>How we’re playing</h3><p class="mt-3">${esc(event.format.replaceAll("-", " "))} · ${event.bestOf === 3 ? "Best of three" : "Single game"} · First to ${event.targetPoints}, win by ${event.winningMargin}</p><p class="subtle">${event.matchDuration} minutes per match · ${esc(event.teamMode)} team assignment</p></div><div class="panel"><h3>${joined ? "You’re on the list." : "Ready to rally?"}</h3><p class="mt-3">Registration closes<br><strong>${date(event.registrationDeadline)} · ${time(event.registrationDeadline)}</strong></p>${joined ? `<span class="badge green">${registration.toUpperCase()}</span><button class="btn btn-secondary d-block mt-4" id="cancel-registration" ${new Date() >= new Date(event.registrationDeadline) || event.finalizedBatch ? "disabled" : ""}>Cancel registration</button>` : `<button class="btn btn-primary" id="register-event" ${!open || !eligible || event.finalizedBatch || (event.confirmedCount >= event.capacity && !event.waitlistEnabled) ? "disabled" : ""}>${event.confirmedCount >= event.capacity ? "Join waiting list" : "Register now"} ${icon("arrow-right")}</button><p class="subtle mt-3">${!eligible ? "Your skill level is outside this event’s range." : !open ? "Registration is not currently open." : "Your place is confirmed when a spot is available."}</p>`}${admin ? `<div class="divider"></div><button class="btn btn-danger btn-sm" id="delete-event">Delete event</button>` : ""}</div></div>`;
    if (document.querySelector("#register-event"))
      document.querySelector("#register-event").onclick = async () => {
        await api(`/events/${id}/register`, "POST", {});
        toast("Registration received");
        state.render();
      };
    if (document.querySelector("#cancel-registration"))
      document.querySelector("#cancel-registration").onclick = async () => {
        if (
          await confirm(
            "Cancel your registration?",
            "Your spot may be offered to the next player on the waiting list.",
          )
        ) {
          await api(`/events/${id}/register`, "DELETE");
          toast("Registration cancelled");
          state.render();
        }
      };
    if (admin)
      document.querySelector("#delete-event").onclick = async () => {
        if (
          await confirm(
            "Delete this event?",
            "This permanently deletes the event, registrations, queue, teams, and match results. Player rankings will be recalculated. This cannot be undone.",
          )
        ) {
          const button = document.querySelector("#delete-event");
          button.disabled = true;
          try {
            await api(`/events/${id}`, "DELETE");
            toast("Event deleted");
            location.hash = "#/events";
          } catch (error) {
            toast(error.message);
            button.disabled = false;
          }
        }
      };
  }
  async function participantsTab() {
    const { participants } = await api(`/events/${id}/participants`),
      { players } = await api("/admin/players");
    container.innerHTML = `<section class="panel"><div class="panel-header"><h3>Event roster</h3><span class="badge">${participants.filter((p) => p.registrationStatus === "confirmed").length} CONFIRMED</span></div><form id="add-participant" class="filters"><select class="form-select" name="userId" aria-label="Select player">${players
      .filter(
        (p) =>
          p.active &&
          !participants.some(
            (r) =>
              r.userId._id === p._id && r.registrationStatus !== "cancelled",
          ),
      )
      .map(
        (p) =>
          `<option value="${p._id}">${esc(p.fullName)} · Level ${p.officialRanking || p.provisionalRanking}</option>`,
      )
      .join(
        "",
      )}</select><button class="btn btn-primary" ${event.finalizedBatch ? "disabled" : ""}>Add participant</button></form><div class="table-wrap"><table><thead><tr><th>Player</th><th>Skill level</th><th>Status</th><th>Registered</th><th>Action</th></tr></thead><tbody>${participants.map((p) => `<tr><td><span class="player-name"><span class="avatar">${initials(p.userId.fullName)}</span>${esc(p.userId.fullName)}</span></td><td>${esc(state.rankings[(p.userId.officialRanking || p.userId.provisionalRanking) - 1])}</td><td><span class="badge ${p.registrationStatus === "confirmed" ? "green" : ""}">${p.registrationStatus}</span></td><td>${date(p.registeredAt)}</td><td>${p.registrationStatus !== "cancelled" ? `<button class="btn btn-secondary btn-sm" data-remove="${p.userId._id}" ${event.finalizedBatch ? "disabled" : ""}>Remove</button>` : "—"}</td></tr>`).join("")}</tbody></table></div></section>`;
    document.querySelector("#add-participant").onsubmit = async (e) => {
      e.preventDefault();
      await api(
        `/events/${id}/participants`,
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      toast("Player added");
      participantsTab();
    };
    container.querySelectorAll("[data-remove]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (
            await confirm(
              "Remove this participant?",
              "A waiting-list player may be promoted. Draft teams will be cleared.",
            )
          ) {
            await api(
              `/events/${id}/participants/${b.dataset.remove}`,
              "DELETE",
            );
            participantsTab();
          }
        }),
    );
  }
  async function teamsTab() {
    const { teams, finalized } = await api(`/events/${id}/teams`);
    const participants = admin
      ? (await api(`/events/${id}/participants`)).participants
          .filter((p) => p.registrationStatus === "confirmed")
          .map((p) => p.userId)
      : [];
    const assigned = teams.flatMap((t) => t.players.map((p) => p._id));
    const unassigned = participants.filter((p) => !assigned.includes(p._id));
    container.innerHTML = `${admin && !finalized ? '<div class="notice">Draft workspace · Generate or adjust teams, then publish when you’re ready. Numerical doubles Elo provides an approximate balancing guide.</div>' : ""}<section class="panel"><div class="panel-header"><h3>${finalized ? "Official teams" : "Team assignments"}</h3><div class="inline-actions">${admin && !finalized ? `<select id="team-mode" class="form-select" aria-label="Generation mode"><option value="balanced">Elo-balanced random</option><option value="random">Completely random</option><option value="same-rank">Same-rank random</option></select><button class="btn btn-primary" id="generate-teams">${icon("shuffle")}${teams.length ? "Regenerate" : "Generate teams"}</button><button class="btn btn-secondary" id="manual-teams">Manual teams</button>` : ""}${teams.length ? '<button class="btn btn-secondary" id="export-teams">Export</button>' : ""}</div></div>${teams.length ? `<div class="table-wrap"><table><thead><tr><th>Team</th><th>Player 1</th><th>Level</th><th>Player 2</th><th>Level</th><th>Combined Elo</th></tr></thead><tbody>${teams.map((t, i) => `<tr><td><strong>${String(i + 1).padStart(2, "0")}</strong></td>${t.players.map((p) => `<td>${admin && !finalized ? `<select class="form-select team-player" aria-label="Team ${i + 1} player">${participants.map((x) => `<option value="${x._id}" ${x._id === p._id ? "selected" : ""}>${esc(x.fullName)}</option>`).join("")}</select>` : esc(p.fullName)}</td><td>${p.officialRanking || p.provisionalRanking}<div class="subtle">${ratingValue(p).toFixed(1)} Elo</div></td>`).join("")}<td><span class="badge green">${(t.combinedRating ?? t.players.reduce((n, p) => n + ratingValue(p), 0)).toFixed(1)}</span></td></tr>`).join("")}</tbody></table></div>` : empty("No teams published yet", admin ? "Generate a draft from confirmed participants or assign players manually." : "Your club will publish teams here before play begins.")}${admin && unassigned.length ? `<div class="notice mt-4"><strong>Unassigned / substitutes:</strong> ${unassigned.map((p) => esc(p.fullName)).join(", ")}<p class="mb-0 mt-2">No incomplete teams are created. You can adjust the roster, or explicitly retain these players as substitutes. Random queue and rotating-partner schedules include the confirmed roster.</p></div>` : ""}${admin && teams.length && !finalized ? '<div class="form-actions"><button class="btn btn-secondary" id="save-teams">Save adjustments</button><button class="btn btn-primary" id="finalize-teams">Finalize teams</button></div><p class="subtle mt-3 text-end">To swap partners, exchange both dropdown selections before saving.</p>' : ""}</section>`;
    if (document.querySelector("#generate-teams"))
      document.querySelector("#generate-teams").onclick = async () => {
        if (
          teams.length &&
          !(await confirm(
            "Regenerate this draft?",
            "Unsaved adjustments will be replaced.",
          ))
        )
          return;
        await api(`/events/${id}/generate-teams`, "POST", {
          mode: document.querySelector("#team-mode").value,
        });
        toast("Draft generated");
        teamsTab();
      };
    if (document.querySelector("#manual-teams"))
      document.querySelector("#manual-teams").onclick = async () => {
        if (participants.length < 2)
          throw new Error("At least two confirmed participants are required");
        const result = await Swal.fire({
          title: "Manual team assignments",
          html: `<p>Choose both players for each complete team.</p>${Array.from({ length: Math.floor(participants.length / 2) }, (_, i) => `<div class="d-flex gap-2 mb-3">${[0, 1].map((_, j) => `<select class="form-select manual-player" aria-label="Team ${i + 1} player ${j + 1}">${participants.map((p, k) => `<option value="${p._id}" ${k === i * 2 + j ? "selected" : ""}>${esc(p.fullName)}</option>`).join("")}</select>`).join("")}</div>`).join("")}`,
          showCancelButton: true,
          preConfirm: () => {
            const ids = [...document.querySelectorAll(".manual-player")].map(
              (s) => s.value,
            );
            if (new Set(ids).size !== ids.length)
              return Swal.showValidationMessage(
                "Each player can appear only once",
              );
            return Array.from({ length: ids.length / 2 }, (_, i) =>
              ids.slice(i * 2, i * 2 + 2),
            );
          },
        });
        if (result.isConfirmed) {
          await api(`/events/${id}/teams`, "PUT", { teams: result.value });
          teamsTab();
        }
      };
    if (document.querySelector("#save-teams"))
      document.querySelector("#save-teams").onclick = async () => {
        const ids = [...container.querySelectorAll(".team-player")].map(
          (s) => s.value,
        );
        await api(`/events/${id}/teams`, "PUT", {
          teams: Array.from({ length: ids.length / 2 }, (_, i) =>
            ids.slice(i * 2, i * 2 + 2),
          ),
        });
        toast("Draft saved");
        teamsTab();
      };
    if (document.querySelector("#finalize-teams"))
      document.querySelector("#finalize-teams").onclick = async () => {
        if (
          await confirm(
            "Publish these teams?",
            unassigned.length
              ? `${unassigned.length} unassigned players will remain substitutes. Save any dropdown adjustments first. Official teams and the roster will be locked.`
              : "Save any dropdown adjustments first. Official teams and the roster will be locked.",
          )
        ) {
          await api(`/events/${id}/finalize-teams`, "POST", {
            allowSubstitutes: unassigned.length > 0,
          });
          event.finalizedBatch = true;
          toast("Teams published");
          teamsTab();
        }
      };
    if (document.querySelector("#export-teams"))
      document.querySelector("#export-teams").onclick = () =>
        download("teams.csv", [
          [
            "Team",
            "Player 1",
            "Ranking",
            "Player 2",
            "Ranking",
            "Combined categories",
            "Combined Elo",
          ],
          ...teams.map((t, i) => [
            i + 1,
            ...t.players.flatMap((p) => [
              p.fullName,
              p.officialRanking || p.provisionalRanking,
            ]),
            t.combinedRanking,
            t.combinedRating ??
              t.players.reduce((n, p) => n + ratingValue(p), 0),
          ]),
        ]);
    if (admin && finalized) {
      container.insertAdjacentHTML(
        "beforeend",
        '<div class="form-actions"><button class="btn btn-secondary" id="reopen-teams">Reopen team draft</button></div>',
      );
      document.querySelector("#reopen-teams").onclick = async () => {
        if (
          await confirm(
            "Replace official assignments?",
            "This clears the current schedule and returns teams to draft. Reopening is allowed only before any match result is finalized.",
          )
        ) {
          await api(`/events/${id}/reopen-teams`, "POST", { confirm: true });
          event.finalizedBatch = undefined;
          toast("Team draft reopened");
          teamsTab();
        }
      };
    }
    if (event.teamMode === "player-selected" && !finalized) {
      try {
        const { players, proposals } = await api(
          `/events/${id}/partner-requests`,
        );
        container.insertAdjacentHTML(
          "beforeend",
          `<section class="panel mt-4"><h3 class="mb-3">Player-selected partners</h3><p class="subtle">Partner choices are reviewed by your club before they become draft assignments.</p>${
            !admin
              ? `<form id="partner-request" class="filters"><select class="form-select" name="partnerId" aria-label="Preferred partner">${players
                  .filter((p) => p._id !== state.user.id)
                  .map(
                    (p) =>
                      `<option value="${p._id}">${esc(p.fullName)} · Level ${p.ranking}</option>`,
                  )
                  .join(
                    "",
                  )}</select><button class="btn btn-primary">Request partner</button></form>`
              : ""
          }<div class="table-wrap"><table><thead><tr><th>Requested by</th><th>Preferred partner</th><th>Status</th>${admin ? "<th>Review</th>" : ""}</tr></thead><tbody>${proposals.map((p) => `<tr><td>${esc(p.requestedBy.fullName)}</td><td>${esc(p.partnerId.fullName)}</td><td>${p.status}</td>${admin ? `<td>${p.status === "pending" ? `<button class="btn btn-primary btn-sm" data-review="${p._id}" data-approve="true">Approve</button> <button class="btn btn-secondary btn-sm" data-review="${p._id}" data-approve="false">Reject</button>` : "—"}</td>` : ""}</tr>`).join("")}</tbody></table></div></section>`,
        );
        if (document.querySelector("#partner-request"))
          document.querySelector("#partner-request").onsubmit = async (e) => {
            e.preventDefault();
            await api(
              `/events/${id}/partner-requests`,
              "POST",
              Object.fromEntries(new FormData(e.target)),
            );
            toast("Partner request sent");
            teamsTab();
          };
        container.querySelectorAll("[data-review]").forEach(
          (b) =>
            (b.onclick = async () => {
              await api(
                `/events/${id}/partner-requests/${b.dataset.review}`,
                "PUT",
                { approve: b.dataset.approve === "true" },
              );
              toast("Request reviewed");
              teamsTab();
            }),
        );
      } catch (err) {
        if (err.status !== 403) throw err;
      }
    }
    lucide.createIcons();
  }
  async function matchesTab() {
    const { matches } = await api(`/events/${id}/matches`);
    const tournament =
      event.eventType === "tournament"
        ? (await api(`/tournaments/${id}/bracket`)).tournament
        : null;
    const groups = [
      ...new Set(matches.map((m) => `${m.stage || "round"}|${m.roundNumber}`)),
    ];
    container.innerHTML = `<section><div class="section-top"><div><h2>${event.eventType === "tournament" ? "Road to the championship" : "The match lineup"}</h2><p class="subtle mb-0">${event.targetPoints} points · Win by ${event.winningMargin} · ${event.bestOf === 3 ? "Best of three" : "Single game"}</p></div>${admin && !matches.length ? `<button class="btn btn-primary" id="generate-matches">Generate ${event.eventType === "tournament" ? "bracket" : "schedule"}</button>` : ""}</div>${tournament?.champion ? `<div class="notice">${icon("trophy")} <strong>Club champions: ${esc(teamName(tournament.champion))}</strong></div>` : ""}${
      matches.length
        ? `<div class="bracket">${groups
            .map((key) => {
              const [stage, round] = key.split("|");
              return `<div class="bracket-round"><h4>${esc(stage.replaceAll("-", " "))} · ${round}</h4>${matches
                .filter((m) => `${m.stage || "round"}|${m.roundNumber}` === key)
                .map(
                  (m) =>
                    `<article class="match-card"><div class="d-flex justify-content-between"><small>${esc(m.bracketKey || `Round ${m.roundNumber}`)} · ${m.rated ? (m.matchStatus !== "finalized" || m.starPolicy || m.ratingPolicy ? "Rated doubles" : "Rating not applied") : "Unrated"}</small><span class="badge ${m.matchStatus === "finalized" ? "green" : ""}">${m.matchStatus}</span></div><div class="match-team ${m.winner === m.teamA?._id ? "winner" : ""}"><span>${m.teamA ? esc(teamName(m.teamA)) : m.matchStatus === "bye" ? "Bye" : esc(m.sources?.[0] || "TBD")}</span><strong>${m.scores.map((s) => s.a).join(", ")}</strong></div><div class="match-team ${m.winner === m.teamB?._id ? "winner" : ""}"><span>${m.teamB ? esc(teamName(m.teamB)) : m.matchStatus === "bye" ? "Bye" : esc(m.sources?.[1] || "TBD")}</span><strong>${m.scores.map((s) => s.b).join(", ")}</strong></div><div class="subtle mt-2">${m.courtNumber ? `Court ${esc(m.courtNumber)} · ${date(m.startDateTime)} ${time(m.startDateTime)}` : "Court assigned after advancement"}</div>${admin && ["scheduled", "finalized"].includes(m.matchStatus) ? `<button class="btn btn-secondary btn-sm mt-3 w-100" data-score="${m._id}">${m.matchStatus === "finalized" ? "Correct result" : "Record result"}</button>` : ""}</article>`,
                )
                .join("")}</div>`;
            })
            .join("")}</div>`
        : empty(
            "The lineup is still taking shape",
            admin
              ? "Finalize your teams, then generate the match schedule."
              : "Your club will publish match details here.",
          )
    }${
      tournament?.standings?.length
        ? `<div class="panel mt-3"><h3 class="mb-3">Tournament standings</h3><p class="subtle">Group ties: wins, point differential, points scored, then stable team ID.</p><div class="table-wrap"><table><thead><tr><th>Team</th><th>Wins</th><th>Losses</th><th>Points</th><th>Differential</th></tr></thead><tbody>${tournament.standings
            .map((s) => {
              const team = matches
                .flatMap((m) => [m.teamA, m.teamB])
                .find((t) => t?._id === s.team);
              return `<tr><td>${esc(teamName(team))}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.points}</td><td>${s.points - s.conceded}</td></tr>`;
            })
            .join("")}</tbody></table></div></div>`
        : ""
    }</section>`;
    if (document.querySelector("#generate-matches"))
      document.querySelector("#generate-matches").onclick = async () => {
        if (
          await confirm(
            "Publish this schedule?",
            "The schedule will use the finalized teams and event scoring rules.",
          )
        ) {
          await api(`/events/${id}/generate-matches`, "POST", {});
          toast("Schedule published");
          matchesTab();
        }
      };
    container.querySelectorAll("[data-score]").forEach(
      (b) =>
        (b.onclick = async () => {
          const match = matches.find((m) => m._id === b.dataset.score);
          const result = await Swal.fire({
            title:
              match.matchStatus === "finalized"
                ? "Correct official result"
                : "Record official result",
            html: `<p>${esc(teamName(match.teamA))}<br><strong>vs</strong><br>${esc(teamName(match.teamB))}</p><div class="d-flex gap-3 mb-2"><strong class="w-50">Team A</strong><strong class="w-50">Team B</strong></div>${Array.from({ length: event.bestOf }, (_, i) => `<div class="d-flex gap-3 mb-3"><input type="number" class="form-control score-a" min="0" max="999" placeholder="Game ${i + 1}" aria-label="Team A game ${i + 1}" value="${match.scores[i]?.a ?? ""}"><input type="number" class="form-control score-b" min="0" max="999" placeholder="Game ${i + 1}" aria-label="Team B game ${i + 1}" value="${match.scores[i]?.b ?? ""}"></div>`).join("")}<p class="subtle">Leave unplayed games blank. Results update both partners’ statistics. Correcting a result clears affected downstream results and recalculates statistics.</p>`,
            showCancelButton: true,
            confirmButtonText: "Finalize result",
            preConfirm: () => {
              const a = [...document.querySelectorAll(".score-a")],
                b = [...document.querySelectorAll(".score-b")];
              const scores = [];
              for (let i = 0; i < a.length; i++) {
                if (!a[i].value && !b[i].value) continue;
                if (!a[i].value || !b[i].value)
                  return Swal.showValidationMessage(
                    "Enter both scores for each played game",
                  );
                scores.push({ a: Number(a[i].value), b: Number(b[i].value) });
              }
              if (!scores.length)
                return Swal.showValidationMessage("Enter a game score");
              return scores;
            },
          });
          if (result.isConfirmed) {
            let reason;
            if (match.rated && match.matchStatus === "finalized") {
              const correction = await Swal.fire({
                title: "Document this correction",
                input: "text",
                inputLabel: "Reason",
                showCancelButton: true,
                inputValidator: (v) =>
                  v.trim().length < 3
                    ? "Enter at least 3 characters"
                    : undefined,
              });
              if (!correction.isConfirmed) return;
              reason = correction.value;
            }
            const path = match.rated
              ? `/ranking/matches/${match._id}/${match.matchStatus === "finalized" ? "correct" : "finalize"}`
              : `/matches/${match._id}/results`;
            await api(path, "POST", {
              ...(reason ? { reason } : {}),
              scores: result.value,
              revision: match.revision,
              cascadeCorrection: match.matchStatus === "finalized",
            });
            toast("Official result saved");
            matchesTab();
          }
        }),
    );
    if (admin)
      for (const button of container.querySelectorAll("[data-score]")) {
        const match = matches.find((m) => m._id === button.dataset.score);
        const ratingButton = document.createElement("button");
        ratingButton.className = "btn btn-secondary btn-sm mt-2 w-100";
        ratingButton.textContent =
          match.rated &&
          (match.matchStatus !== "finalized" || match.ratingPolicy)
            ? "Exclude from Elo"
            : "Include in Elo";
        button.after(ratingButton);
        ratingButton.onclick = async () => {
          const rated = !(
            match.rated &&
            (match.matchStatus !== "finalized" || match.ratingPolicy)
          );
          const result = await Swal.fire({
            title: rated
              ? "Include this match in doubles Elo?"
              : "Exclude this match from Elo?",
            text: "Changing a completed match recalculates later star rankings and enabled skill ratings.",
            input: "text",
            inputLabel: "Documented reason",
            showCancelButton: true,
            inputValidator: (v) =>
              v.trim().length < 3 ? "Enter a reason" : undefined,
          });
          if (result.isConfirmed) {
            await api(`/matches/${match._id}/rating`, "PUT", {
              rated,
              revision: match.revision,
              reason: result.value,
            });
            toast("Rating eligibility updated");
            matchesTab();
          }
        };
        if (match.matchStatus === "finalized") {
          const invalidate = document.createElement("button");
          invalidate.className = "btn btn-danger btn-sm mt-2 w-100";
          invalidate.textContent = "Invalidate result";
          ratingButton.after(invalidate);
          invalidate.onclick = async () => {
            const result = await Swal.fire({
              title: "Invalidate official result?",
              text: "This removes the result and clears dependent bracket results. Statistics and subsequent Elo ratings will be recalculated.",
              input: "text",
              inputLabel: "Documented reason",
              showCancelButton: true,
              inputValidator: (v) =>
                v.trim().length < 3 ? "Enter a reason" : undefined,
            });
            if (result.isConfirmed) {
              await api(`/matches/${match._id}/results`, "DELETE", {
                revision: match.revision,
                reason: result.value,
                cascadeCorrection: true,
              });
              toast("Result invalidated");
              matchesTab();
            }
          };
        }
        if (match.matchStatus !== "scheduled") continue;
        const change = document.createElement("button");
        change.className = "btn btn-secondary btn-sm mt-2 w-100";
        change.textContent = "Change court / time";
        button.after(change);
        change.onclick = async () => {
          const result = await Swal.fire({
            title: "Court & start time",
            html:
              select("Court", "courtNumber", event.courts, match.courtNumber) +
              input(
                "Start (your local time)",
                "startDateTime",
                localDate(match.startDateTime),
                "datetime-local",
                "required",
              ),
            showCancelButton: true,
            preConfirm: () => ({
              courtNumber: document.querySelector("#courtNumber").value,
              startDateTime: new Date(
                document.querySelector("#startDateTime").value,
              ).toISOString(),
            }),
          });
          if (result.isConfirmed) {
            await api(`/matches/${match._id}/schedule`, "PUT", result.value);
            toast("Schedule updated");
            matchesTab();
          }
        };
      }
    lucide.createIcons();
  }
  let rankingPage = 1;
  async function rankingsTab() {
    const data = await api(
      `/ranking/leaderboard?period=event&eventId=${id}&page=${rankingPage}&limit=50`,
    );
    container.innerHTML = `<section class="panel"><div class="panel-header"><h3>Event rankings</h3><span class="badge ${event.rated ? "green" : ""}">${event.rated ? "Ranked event" : "Unranked event"}</span></div><p>Standings use net stars earned in this event, then wins. Only finalized ranked matches count. Corrections update these standings automatically.</p>${admin ? `<p class="subtle">Enable rankings in <a href="#/events/${id}/edit">Edit event</a> before recording results. Individual matches can be marked ranked or unranked in Matches.</p>` : ""}<div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Current club rank</th><th>Event stars</th><th>Wins</th><th>Losses</th><th>Win rate</th></tr></thead><tbody>${data.rows.map((p) => `<tr><td>${p.position}</td><td>${esc(p.fullName)}</td><td>${esc(p.rankTier)} ${esc(p.rankDivision || "")}</td><td>${p.totalStars > 0 ? "+" : ""}${p.totalStars}</td><td>${p.totalWins}</td><td>${p.totalLosses}</td><td>${p.winPercentage.toFixed(1)}%</td></tr>`).join("") || '<tr><td colspan="7">No ranked player profiles yet. Standings appear after ranked results are finalized.</td></tr>'}</tbody></table></div><div class="form-actions"><button class="btn btn-secondary" id="event-rank-prev" ${rankingPage === 1 ? "disabled" : ""}>Previous</button><span>Page ${rankingPage}</span><button class="btn btn-secondary" id="event-rank-next" ${rankingPage * 50 >= data.total ? "disabled" : ""}>Next</button></div></section>`;
    for (const [selector, step] of [
      ["#event-rank-prev", -1],
      ["#event-rank-next", 1],
    ])
      container.querySelector(selector).onclick = async () => {
        rankingPage += step;
        try {
          await rankingsTab();
        } catch (error) {
          toast(error.message);
        }
      };
  }
  const queueTab = () =>
    renderQueue(container, event, () =>
      content.querySelector('[data-tab="participants"]').click(),
    );
  const tabs = {
    queue: queueTab,
    overview,
    rankings: rankingsTab,
    participants: participantsTab,
    teams: teamsTab,
    matches: matchesTab,
  };
  state.refreshEvent = async () => {
    if (
      !container.isConnected ||
      Swal.isVisible() ||
      document.querySelector("input:focus,select:focus,textarea:focus")
    )
      return;
    const tab = content.querySelector("[data-tab].active")?.dataset.tab;
    if (tab === "queue") await queueTab();
    else if (tab === "rankings") await rankingsTab();
    else if (tab === "matches") await matchesTab();
    else if (tab === "teams" && !container.querySelector("#save-teams"))
      await teamsTab();
  };
  content.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = async () => {
        content
          .querySelectorAll("[data-tab]")
          .forEach((x) => x.classList.toggle("active", x === b));
        await tabs[b.dataset.tab]();
        lucide.createIcons();
      }),
  );
  await overview();
}
