import { api, esc, toast } from "./api.js";
export async function renderQueue(container, event, addPlayers) {
  const base = `/events/${event._id}/queue`;
  let data;
  try {
    data = await api(base);
  } catch (error) {
    container.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
    return;
  }
  const closed = ["draft", "completed", "cancelled"].includes(event.status);
  const team = (t, side) =>
    `<section class="queue-team ${side}"><h4>TEAM ${side === "blue" ? 1 : 2}</h4>${t.players.map((p) => `<div><strong>${esc(p.fullName)}</strong><small>Level ${p.officialRanking || p.provisionalRanking}</small></div>`).join("")}</section>`;
  const teams = (m) =>
    `<div class="queue-teams">${team(m.teamA, "blue")}${team(m.teamB, "orange")}</div>`;
  const free = event.courts.filter(
    (c) => !data.live.some((m) => m.courtNumber === c),
  );
  container.innerHTML = `<div class="queue-toolbar"><div><h2>Live queue</h2><p class="subtle">Ranked games: stars and rating points update after scoring. Random partners and opponents ? Fewest games first ? ${data.completed} completed</p></div><button class="btn btn-secondary" id="queue-refresh">Refresh</button></div>
  <div class="queue-courts">${event.courts
    .map((c) => {
      const m = data.live.find((m) => m.courtNumber === c);
      return `<article class="queue-card"><header><strong>Court ${esc(c)}</strong>${m ? `<span class="queue-live">LIVE</span><small>Started ${esc(new Date(m.startDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small>` : '<span class="badge">AVAILABLE</span>'}</header>${m ? `${teams(m)}<div class="queue-actions"><button class="btn queue-blue" data-win="${m._id}" data-side="A" ${closed ? "disabled" : ""}>Team 1 Wins</button><button class="btn queue-orange" data-win="${m._id}" data-side="B" ${closed ? "disabled" : ""}>Team 2 Wins</button></div>` : '<div class="queue-vacant">Ready for the next four players.<br><small>Call an Up Next match to this court.</small></div>'}</article>`;
    })
    .join("")}</div>
  <div class="queue-toolbar"><h3>Matchmaking</h3><button class="btn btn-primary" id="queue-prepare" ${closed || data.waiting.length < 4 || data.next.length >= event.courts.length ? "disabled" : ""}>+ Add match</button></div>
  <div class="queue-layout"><aside class="queue-waiting"><header><strong>QUEUE (${data.waiting.length})</strong><button class="btn btn-secondary btn-sm" id="queue-add">+ Add player</button></header><p>Fewest games first ? Longest waiting next</p><ol>${data.waiting.map((p) => `<li><div><strong>${esc(p.fullName)}</strong> <span class="queue-result">${p.lastResult}</span><small>${p.games} games ? ${p.games ? Math.round((p.wins / p.games) * 100) : 0}% wins ? Waiting since ${esc(new Date(p.waitingSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small></div><button class="queue-remove" data-remove-player="${p._id}" aria-label="Remove ${esc(p.fullName)}" ${closed ? "disabled" : ""}>?</button></li>`).join("") || "<li>No players waiting. Add participants to begin.</li>"}</ol></aside>
  <div class="queue-next">${data.next.map((m, i) => `<article class="queue-card queue-upnext"><header><strong>Up Next ${i + 1}</strong><span>Random teams</span></header>${teams(m)}<div class="queue-actions"><select class="form-select" aria-label="Court for next match ${i + 1}" data-court="${m._id}">${free.map((c) => `<option value="${esc(c)}">Court ${esc(c)}</option>`).join("") || "<option>No free courts</option>"}</select><button class="btn btn-primary" data-start="${m._id}" ${closed || !free.length ? "disabled" : ""}>Call Players</button></div><button class="btn btn-link" data-release="${m._id}" ${closed ? "disabled" : ""}>Return players to queue</button></article>`).join("") || '<div class="queue-placeholder">Add a match to randomly split the next four waiting players into two teams. Their places are reserved until called.</div>'}</div></div>`;
  const refresh = () => renderQueue(container, event, addPlayers);
  const action = async (button, fn) => {
    button.disabled = true;
    try {
      await fn();
      await refresh();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  };
  container.querySelector("#queue-refresh").onclick = refresh;
  container.querySelector("#queue-add").onclick = addPlayers;
  container.querySelector("#queue-prepare").onclick = (e) =>
    action(e.currentTarget, () => api(`${base}/prepare`, "POST", {}));
  container.querySelectorAll("[data-start]").forEach(
    (b) =>
      (b.onclick = () =>
        action(b, () =>
          api(`${base}/${b.dataset.start}/start`, "POST", {
            court: container.querySelector(`[data-court="${b.dataset.start}"]`)
              .value,
          }),
        )),
  );
  container
    .querySelectorAll("[data-release]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b, () => api(`${base}/${b.dataset.release}`, "DELETE"))),
    );
  container.querySelectorAll("[data-remove-player]").forEach(
    (b) =>
      (b.onclick = async () => {
        const result = await Swal.fire({
          title: "Remove waiting player?",
          text: "This removes their event registration.",
          showCancelButton: true,
          confirmButtonText: "Remove",
        });
        if (result.isConfirmed)
          await action(b, () =>
            api(
              `/events/${event._id}/participants/${b.dataset.removePlayer}`,
              "DELETE",
            ),
          );
      }),
  );
  container.querySelectorAll("[data-win]").forEach(
    (b) =>
      (b.onclick = async () => {
        const m = data.live.find((m) => m._id === b.dataset.win);
        const result = await Swal.fire({
          title: `Team ${b.dataset.side === "A" ? 1 : 2} wins ? enter scores`,
          html: `<p>Enter the actual final score for each played game.</p>${Array.from({ length: event.bestOf }, (_, i) => `<div class="queue-score"><input type="number" min="0" max="999" class="form-control" id="q-a-${i}" aria-label="Team 1 game ${i + 1}" placeholder="Team 1"><input type="number" min="0" max="999" class="form-control" id="q-b-${i}" aria-label="Team 2 game ${i + 1}" placeholder="Team 2"></div>`).join("")}`,
          showCancelButton: true,
          confirmButtonText: "Save result & return players",
          showLoaderOnConfirm: true,
          preConfirm: async () => {
            const scores = [];
            for (let i = 0; i < event.bestOf; i++) {
              const a = document.querySelector(`#q-a-${i}`).value,
                bb = document.querySelector(`#q-b-${i}`).value;
              if (a === "" && bb === "") continue;
              if (a === "" || bb === "") {
                Swal.showValidationMessage(
                  "Enter both scores for each played game.",
                );
                return false;
              }
              scores.push({ a: Number(a), b: Number(bb) });
            }
            const aWins = scores.filter((s) => s.a > s.b).length,
              bWins = scores.filter((s) => s.b > s.a).length;
            if (
              !scores.length ||
              (b.dataset.side === "A" ? aWins <= bWins : bWins <= aWins)
            ) {
              Swal.showValidationMessage(
                "Scores must match the selected winning team.",
              );
              return false;
            }
            try {
              await api(`/matches/${m._id}/results`, "POST", {
                scores,
                revision: m.revision,
              });
              return true;
            } catch (error) {
              Swal.showValidationMessage(error.message);
              return false;
            }
          },
        });
        if (result.isConfirmed) await refresh();
      }),
  );
}
