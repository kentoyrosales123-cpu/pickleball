import { api, esc, date, time } from "./api.js";
import { waitingDuration } from "./queue.js";

const labels = {
  "not-checked-in": "Not checked in",
  waiting: "Waiting",
  "up-next": "Up next",
  playing: "Playing",
  break: "On a break",
  left: "Left session",
  completed: "Session completed",
};

const signed = (value) =>
  value === null || value === undefined
    ? "Not recorded"
    : `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}`;
function resultHistory(session) {
  const history = session.history || [];
  return `<section class="mt-4"><h3>Session results</h3><p><strong>${session.games} games played &middot; ${session.wins ?? 0} wins &middot; ${session.losses ?? 0} losses</strong></p>${history.length ? '<p class="subtle">Scores show your team first. Rating points and stars reflect the latest official results.</p>' : '<p class="subtle">No completed matches yet.</p>'}${history.map((m, i) => `<article class="panel mb-3"><div class="panel-header"><h4>${i === 0 ? "Latest result" : "Result"}: ${m.won ? "Win" : "Loss"}</h4><span>Match ${m.round} &middot; Court ${esc(m.court || "Unassigned")}</span></div><p>${date(m.completedAt)} ${time(m.completedAt)}</p><p><strong>Score: ${m.scores.map((s) => `${s.own}–${s.opponent}`).join(", ")}</strong></p><p>Partner: ${esc(m.partner.fullName)}<br>Opponents: ${m.opponents.map((p) => esc(p.fullName)).join(" &amp; ")}</p><p>Rating points: <strong>${m.ratingHidden ? "Hidden by club" : signed(m.ratingChange)}</strong> &middot; Stars: <strong>${signed(m.starsChange)}</strong></p>${m.reported ? '<p class="subtle">Reported to organizer for review</p>' : `<button class="btn btn-secondary btn-sm" data-report-score="${esc(m._id)}" data-event="${esc(session.event._id)}" data-revision="${m.revision}" aria-label="Report incorrect score for match ${m.round}">Report incorrect score</button>`}</article>`).join("")}</section>`;
}

export async function mountLiveSession(container, state) {
  const clock = container.ownerDocument.defaultView;
  let stopped = false,
    mutating = false,
    loading = false,
    repeat = false;
  const button = (eventId, status, label) =>
    `<button class="btn btn-secondary" data-availability="${status}" data-event="${esc(eventId)}">${label}</button>`;
  const updateTimers = () =>
    container.querySelectorAll("[data-waiting-since]").forEach((el) => {
      el.textContent = waitingDuration(el.dataset.waitingSince);
    });
  const refresh = async () => {
    if (stopped || !container.isConnected) return;
    if (loading || mutating) {
      repeat = true;
      return;
    }
    loading = true;
    container.querySelectorAll("[data-availability]").forEach((el) => {
      el.disabled = true;
    });
    try {
      const { sessions } = await api(
        "/players/me/live-sessions?includeCompleted=true",
      );
      if (stopped || !container.isConnected) return;
      container.innerHTML = `<div class="page-heading"><div><h1>My Live Session</h1><p>Your queue position, next match, and availability.</p></div><button class="btn btn-secondary" data-session-refresh>Refresh</button></div><p class="subtle" role="status">Live updates are on. Last updated ${esc(new Date().toLocaleTimeString())}.</p><div data-session-error role="alert"></div>${
        sessions
          .map((s) => {
            const assigned = ["up-next", "playing"].includes(s.status);
            return `<section class="panel mb-4"><div class="panel-header"><div><h2>${esc(s.event.eventName)}</h2><p>${esc(s.event.location)} &middot; ${date(s.event.startDateTime)} ${time(s.event.startDateTime)}</p></div><span class="badge green">${labels[s.status] || "Not checked in"}</span></div>
          ${s.status === "playing" ? `<div class="notice" role="alert"><strong>You are called to Court ${esc(s.match.court)}. Please head to your court.</strong></div>` : ""}
          <div class="stats-grid"><div class="stat-card"><div class="stat-top">Queue position</div><div class="stat-value">${s.queuePosition ? `${s.queuePosition} / ${s.waitingCount}` : "—"}</div><small>${s.status === "up-next" ? "Your place is reserved" : "Among ready, waiting players"}</small></div><div class="stat-card"><div class="stat-top">Waiting time</div><div class="stat-value" ${s.waitingSince ? `data-waiting-since="${esc(s.waitingSince)}"` : ""}>${s.waitingSince ? waitingDuration(s.waitingSince) : "—"}</div></div><div class="stat-card"><div class="stat-top">Games played</div><div class="stat-value">${s.games}</div></div></div>
          ${s.match ? `<h3>${s.status === "playing" ? "Your current match" : "Your next match"}</h3><p><strong>Court:</strong> ${s.match.court ? esc(s.match.court) : "Awaiting court assignment"}</p><p><strong>Your partner:</strong> ${esc(s.match.partner.fullName)}</p><p><strong>Opponents:</strong> ${s.match.opponents.map((p) => esc(p.fullName)).join(" &amp; ")}</p>` : ""}
          <div class="d-flex flex-wrap gap-2">${s.status === "completed" ? '<p class="subtle">This session is complete. Your results are saved below.</p>' : assigned ? '<p class="subtle">Ask the organizer to release your Up Next match, or finish your current game, before changing availability.</p>' : s.status === "waiting" ? button(s.event._id, "break", "Take a break") + button(s.event._id, "left", "Leave session") : button(s.event._id, "ready", s.status === "break" ? "Ready again" : "Check in") + (s.status === "break" ? button(s.event._id, "left", "Leave session") : "")}<a class="btn btn-secondary" href="#/events/${esc(s.event._id)}">View event</a></div>${resultHistory(s)}</section>`;
          })
          .join("") ||
        '<section class="panel"><h2>No active live sessions</h2><p>Join a random open-play event and get a confirmed spot to check in here.</p><a class="btn btn-primary" href="#/events">Explore events</a></section>'
      }`;
      container.querySelector("[data-session-refresh]").onclick = refresh;
      container.querySelectorAll("[data-report-score]").forEach((b) => {
        b.onclick = async () => {
          if (mutating || loading || stopped) return;
          mutating = true;
          try {
            await Swal.fire({
              title: "Report incorrect score",
              text: "Describe what is wrong and the correct score. An organizer will review it; this does not change the result.",
              input: "textarea",
              inputLabel: "Reason and correct score",
              inputAttributes: { maxlength: "1000" },
              showCancelButton: true,
              confirmButtonText: "Send report",
              showLoaderOnConfirm: true,
              preConfirm: async (value) => {
                const reason = (value || "").trim();
                if (reason.length < 5) {
                  Swal.showValidationMessage("Enter at least 5 characters.");
                  return false;
                }
                try {
                  await api(
                    `/events/${b.dataset.event}/queue/matches/${b.dataset.reportScore}/report-score`,
                    "POST",
                    { reason, revision: Number(b.dataset.revision) },
                  );
                  return true;
                } catch (error) {
                  Swal.showValidationMessage(error.message);
                  return false;
                }
              },
            });
          } finally {
            mutating = false;
            await refresh();
          }
        };
      });
      container.querySelectorAll("[data-availability]").forEach((b) => {
        b.onclick = async () => {
          if (mutating || loading || stopped) return;
          mutating = true;
          container.querySelectorAll("[data-availability]").forEach((el) => {
            el.disabled = true;
          });
          try {
            await api(`/events/${b.dataset.event}/queue/me/status`, "PUT", {
              status: b.dataset.availability,
            });
            mutating = false;
            await refresh();
          } catch (error) {
            mutating = false;
            if (!stopped) {
              container.querySelector("[data-session-error]").textContent =
                error.message;
              container
                .querySelectorAll("[data-availability]")
                .forEach((el) => {
                  el.disabled = false;
                });
            }
          }
        };
      });
    } catch (error) {
      if (!stopped && container.isConnected) {
        const existing = container.querySelector("[data-session-error]");
        if (existing)
          existing.textContent = `Updates unavailable: ${error.message}. Use Refresh to retry.`;
        else {
          container.innerHTML = `<h1>My Live Session</h1><div role="alert">${esc(error.message)}</div><button class="btn btn-secondary" data-session-refresh>Try again</button>`;
          container.querySelector("[data-session-refresh]").onclick = refresh;
        }
      }
    } finally {
      loading = false;
      if (!stopped && !mutating)
        container.querySelectorAll("[data-availability]").forEach((el) => {
          el.disabled = false;
        });
      if (repeat && !stopped) {
        repeat = false;
        void refresh();
      }
    }
  };
  state.refreshLiveSession = refresh;
  await refresh();
  const timer = clock.setInterval(() => {
    if (!container.isConnected) {
      cleanup();
      return;
    }
    updateTimers();
  }, 1000);
  const poll = clock.setInterval(refresh, 10000);
  function cleanup() {
    stopped = true;
    clock.clearInterval(timer);
    clock.clearInterval(poll);
    if (state.refreshLiveSession === refresh) state.refreshLiveSession = null;
  }
  return cleanup;
}
