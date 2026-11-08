import { reviewPickleQue } from "./pickle-que.js";
import { mountStarRanking, rankingPage } from "./ranking.js";
import {
  api,
  esc,
  icon,
  date,
  time,
  initials,
  avatar,
  empty,
  toast,
  confirm,
  download,
} from "./api.js";
import { eventDetail, eventForm } from "./events.js";
import {
  mountPlayerRating,
  mountRatingSettings,
  manualRatingOverride,
} from "./ratings.js";
const app = document.querySelector("#app");
let user = null,
  rankings = [],
  charts = [],
  socket;
const state = {
  get user() {
    return user;
  },
  get rankings() {
    return rankings;
  },
  api,
  render,
  toast,
  confirm,
};
const brand = `<a class="brand" href="#/"> <span class="brand-mark">${icon("orbit")}</span><span>CourtSide<small>PICKLEBALL CLUB</small></span></a>`;
const rankLabel = (u) =>
  rankings[(u.officialRanking || u.provisionalRanking) - 1] || "Unranked";
const badge = (u) =>
  `<span class="badge green">${esc(rankLabel(u))}${!u.officialRanking ? " · provisional" : ""}</span>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  `<div><label class="form-label" for="${name}">${label}</label><input class="form-control" id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function stat(label, value, symbol, foot) {
  return `<div class="stat-card"><div class="stat-top">${label}<span class="stat-icon">${icon(symbol)}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;
}
export function eventCard(e) {
  const d = new Date(e.startDateTime);
  return `<article class="event-card"><div class="event-visual ${e.eventType}"><div class="date-chip"><small>${d.toLocaleDateString(undefined, { month: "short" }).toUpperCase()}</small><strong>${d.getDate()}</strong></div></div><div class="event-body"><span class="badge ${e.eventType === "tournament" ? "blue" : "green"}">${e.eventType === "tournament" ? "TOURNAMENT" : "OPEN PLAY"}</span> <span class="badge">${esc(e.registration || e.status.replaceAll("-", " "))}</span><h3>${esc(e.eventName)}</h3><div class="event-meta">${icon("map-pin")}${esc(e.location)}</div><div class="event-meta">${icon("clock")}${date(e.startDateTime)} · ${time(e.startDateTime)}–${time(e.endDateTime)}</div><div class="event-meta">${icon("bar-chart-3")}Levels ${e.minRanking}–${e.maxRanking}</div><div class="capacity-track"><span style="width:${Math.min(100, (e.confirmedCount / e.capacity) * 100)}%"></span></div><div class="d-flex justify-content-between subtle"><span>${e.confirmedCount} / ${e.capacity} players</span><span>${Math.max(0, e.capacity - e.confirmedCount)} spots left</span></div><div class="event-bottom"><small>${e.fee ? `₱${e.fee.toLocaleString()}` : "Free to play"}<br>Closes ${date(e.registrationDeadline)}</small><a class="btn btn-secondary btn-sm" href="${user ? `#/events/${e._id}` : "#/login"}">View event ${icon("arrow-up-right")}</a></div></div></article>`;
}
function shell(route) {
  const admin = user.role === "admin";
  const items = admin
    ? [
        ["dashboard", "layout-dashboard", "Dashboard"],
        ["players", "users", "Player management"],
        ["open-play", "calendar-days", "Open play"],
        ["tournaments", "trophy", "Tournaments"],
        ["teams", "shuffle", "Team generator"],
        ["matches", "swords", "Match management"],
        ["ranking", "star", "Ranked clubhouse"],
        ["leaderboard", "medal", "Rankings"],
        ["reports", "chart-no-axes-combined", "Statistics & reports"],
        ["settings", "settings-2", "Settings"],
      ]
    : [
        ["dashboard", "layout-dashboard", "Overview"],
        ["events", "calendar-days", "Explore events"],
        ["my-events", "ticket", "My events"],
        ["history", "swords", "Match history"],
        ["ranking", "star", "Ranked clubhouse"],
        ["leaderboard", "medal", "Leaderboard"],
        ["statistics", "chart-no-axes-combined", "My statistics"],
        ["profile", "user-round", "My profile"],
      ];
  app.innerHTML = `<aside class="sidebar">${brand}<div class="nav-label">${admin ? "CLUB MANAGEMENT" : "YOUR CLUBHOUSE"}</div><nav>${items.map(([path, i, label]) => `<a href="#/${path}" class="${route === path ? "active" : ""}">${icon(i)}${label}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="club-note">${icon("zap")}<strong>Better together.</strong><p>A good match starts with a great community. See you on court.</p></div><a href="#/profile" class="d-block mb-3">${icon("circle-user")} Account</a><button class="icon-button text-light" id="logout">${icon("log-out")} Sign out</button></div></aside><div class="shell"><header class="topbar"><button class="icon-button mobile-toggle" id="menu" aria-label="Toggle navigation">${icon("menu")}</button><div class="search-label">${icon("sun")} A good day to get on court</div><div class="top-actions"><span class="badge green">${admin ? "ADMINISTRATOR" : "PLAYER"}</span><a href="#/notifications" class="icon-button" aria-label="Notifications">${icon("bell")}</a><a href="#/profile" class="top-user">${avatar(user)}<span><strong>${esc(user.fullName)}</strong><small>${esc(rankLabel(user))}</small></span></a></div></header><main class="main" id="content"><div class="loading">Loading your clubhouse…</div></main></div>`;
  document.querySelector("#logout").onclick = async () => {
    await api("/auth/logout", "POST", {});
    user = null;
    socket?.disconnect();
    location.hash = "#/";
    render();
  };
  document.querySelector("#menu").onclick = () =>
    document.querySelector(".sidebar").classList.toggle("open");
}
async function landing() {
  const { events } = await api("/public/events");
  app.innerHTML = `<div class="landing"><nav class="landing-nav">${brand}<div class="nav-links"><a href="#features">The club experience</a><a class="btn btn-secondary" href="#/login">Log in</a><a class="btn btn-primary" href="#/register">Join the club ${icon("arrow-up-right")}</a></div></nav><section class="hero"><div><span class="eyebrow">YOUR COURT. YOUR COMMUNITY.</span><h1>More play.<br>Better matches.<br><span>Your people.</span></h1><p>Find your next game, team up with your club, and make every rally count. Your pickleball life, all in one place.</p><div class="hero-actions"><a class="btn btn-primary" href="#/register">Find your next game ${icon("arrow-right")}</a><a class="btn btn-secondary" href="#/login">Member sign in</a></div><span class="subtle">Open play · Balanced teams · Club tournaments</span></div><div class="court-art" role="img" aria-label="Illustration of a pickleball court and green ball"><div class="court"><div class="net"></div></div><div class="ball">••<br>•••</div><div class="floating-note">${icon("users")} <strong>Good games. Great company.</strong><div class="subtle">There’s a place for every skill level.</div></div></div></section><section class="landing-section"><div class="section-top"><div class="d-flex flex-column gap-2"><span class="eyebrow">GET IN THE GAME</span><h2>Next up on court</h2></div><a class="btn btn-secondary" href="#/login">Explore events ${icon("arrow-right")}</a></div><div class="events-grid">${
    events
      .filter(
        (e) =>
          new Date(e.startDateTime) > new Date() && e.status !== "cancelled",
      )
      .slice(0, 3)
      .map(eventCard)
      .join("") ||
    empty(
      "The next rally is on its way",
      "Upcoming club events will appear here.",
    )
  }</div></section><section class="landing-section" id="features"><div class="section-top"><div><span class="eyebrow">LESS ORGANIZING. MORE PLAYING.</span><h2 class="mt-3">Everything your game needs.</h2></div></div><div class="features">${[
    [
      "shuffle",
      "Find your balance",
      "Skill-aware team assignments make it easy to meet a new partner and enjoy a competitive match.",
    ],
    [
      "trophy",
      "Play for something",
      "From friendly open play to championship finals, follow your schedule and every result.",
    ],
    [
      "chart-no-axes-combined",
      "See your progress",
      "Track your wins, discover your strongest partnerships, and celebrate each improvement.",
    ],
  ]
    .map(
      ([i, t, d]) =>
        `<div class="feature">${icon(i)}<h3>${t}</h3><p>${d}</p></div>`,
    )
    .join(
      "",
    )}</div></section><section class="landing-section"><span class="eyebrow">HOW IT WORKS</span><h2 class="my-3">Three steps to your next rally.</h2><div class="features">${[
    [
      "01",
      "Make it yours",
      "Create your profile and choose your provisional skill level.",
    ],
    [
      "02",
      "Pick your play",
      "Browse local club events and reserve an eligible spot.",
    ],
    [
      "03",
      "Show up. Rally. Repeat.",
      "Check your team and court, then track your results.",
    ],
  ]
    .map(
      ([n, t, d]) =>
        `<div><div class="stat-value" style="color:#95b625">${n}</div><h3>${t}</h3><p>${d}</p></div>`,
    )
    .join(
      "",
    )}</div></section><section class="landing-section text-center"><h2>Your next chapter starts on court.</h2><p>Sign in to see club rankings and discover your place in the community.</p><a href="#/register" class="btn btn-primary">Become a member ${icon("arrow-right")}</a></section><footer class="footer"><strong>CourtSide · Pickleball Management</strong><span>Built for the love of the game.</span></footer></div>`;
}
function authPage(mode) {
  const register = mode === "register",
    forgot = mode === "forgot",
    reset = mode === "reset";
  app.innerHTML = `<div class="auth-wrap"><aside class="auth-aside">${brand}<div><span class="eyebrow">WELCOME TO YOUR CLUBHOUSE</span><h1 class="mt-4">Every great game<br>starts with<br><span style="color:var(--green)">good company.</span></h1><p class="mt-4">Your events. Your teammates. Your progress.<br>One place to bring it all together.</p></div><small class="muted">CourtSide · Made for every level of play.</small></aside><main class="auth-form"><a href="#/" class="subtle">← Back to CourtSide</a><h2 class="mt-4">${register ? "Join the club." : forgot ? "Forgot your password?" : reset ? "A fresh start." : "Welcome back."}</h2><p>${register ? "Your next great match is waiting." : forgot ? "We’ll send you a link to reset it." : reset ? "Choose a new password of at least 12 characters." : "Sign in and get back in the game."}</p><form id="auth-form"><div class="form-grid">${register ? field("Full name", "fullName", "", "text", 'required autocomplete="name"') + field("Username", "username", "", "text", 'required pattern="[a-zA-Z0-9_]{3,30}" autocomplete="username"') : ""}${!reset ? `<div class="wide">${field("Email address", "email", "", "email", 'required autocomplete="email"')}</div>` : ""}${register ? field("Mobile number", "phone", "", "tel", 'required autocomplete="tel"') + `<div><label for="provisionalRanking" class="form-label">Initial skill level</label><select name="provisionalRanking" id="provisionalRanking" class="form-select">${rankings.map((r, i) => `<option value="${i + 1}">${i + 1} · ${r}</option>`).join("")}</select></div>` : ""}${!forgot ? `<div class="${register ? "" : "wide"}">${field("Password", "password", "", "password", `required minlength="${register || reset ? 12 : 1}" maxlength="72" autocomplete="${register || reset ? "new-password" : "current-password"}"`)}</div>` : ""}${register ? field("Confirm password", "confirmPassword", "", "password", 'required minlength="12" autocomplete="new-password"') : ""}</div><div id="auth-error" role="alert"></div><button class="btn btn-primary" type="submit">${register ? "Create my account" : forgot ? "Send reset link" : reset ? "Update password" : "Sign in"} ${icon("arrow-right")}</button></form>${!register && !forgot && !reset ? '<div class="auth-switch"><a href="#/forgot">Forgot password?</a></div>' : ""}<div class="auth-switch">${register ? 'Already a member? <a href="#/login">Sign in</a>' : 'New to the club? <a href="#/register">Create an account</a>'}</div>${register ? '<p class="subtle mt-3">Your chosen skill level is provisional until a club administrator confirms it. You can add your photo and optional details in your profile.</p>' : ""}</main></div>`;
  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    const data = Object.fromEntries(new FormData(event.target));
    try {
      if (forgot) {
        const result = await api("/auth/forgot-password", "POST", data);
        toast(result.message);
      } else if (reset) {
        await api("/auth/action", "POST", {
          purpose: "reset",
          token: sessionStorage.getItem("resetToken"),
          password: data.password,
        });
        sessionStorage.removeItem("resetToken");
        toast("Password updated");
        location.hash = "#/login";
      } else {
        const result = await api(`/auth/${mode}`, "POST", data);
        user = result.user;
        connectSocket();
        location.hash = "#/dashboard";
      }
    } catch (error) {
      document.querySelector("#auth-error").innerHTML =
        `<div class="error-message">${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  };
}
function chart(id, type, labels, datasets, options = {}) {
  charts = charts.filter((c) => {
    if (c.canvas?.id === id) {
      c.destroy();
      return false;
    }
    return true;
  });
  const canvas = document.getElementById(id);
  if (!canvas) return;
  charts.push(
    new Chart(canvas, {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: type === "doughnut",
            position: "bottom",
            labels: { boxWidth: 10, font: { size: 11 } },
          },
        },
        scales:
          type === "doughnut"
            ? {}
            : {
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: {
                  beginAtZero: true,
                  ticks: { precision: 0, font: { size: 10 } },
                  grid: { color: "#f0f2f5" },
                  border: { display: false },
                },
              },
        ...options,
      },
    }),
  );
}
async function dashboard(content) {
  const admin = user.role === "admin";
  const data = await api(admin ? "/admin/dashboard" : "/players/me/stats");
  const { events } = await api("/events");
  const upcoming = events.filter(
    (e) =>
      new Date(e.startDateTime) > new Date() &&
      !["draft", "cancelled"].includes(e.status),
  );
  content.innerHTML =
    heading(
      `${admin ? "Club overview" : `Hey, ${esc(user.fullName.split(" ")[0])}`} ${admin ? "" : "👋"}`,
      admin
        ? "A little organization. A lot more time on court."
        : "Here’s what’s happening with your game today.",
      `<a class="btn btn-${admin ? "primary" : "secondary"}" href="#/${admin ? "events/new" : "events"}">${icon(admin ? "plus" : "calendar-days")}${admin ? "Create an event" : "Explore events"}</a>`,
    ) +
    `<section class="welcome-banner"><div><span class="eyebrow" style="color:var(--green)">${admin ? "BRING YOUR CLUB TOGETHER" : "MAKE YOUR NEXT RALLY COUNT"}</span><h2 class="mt-3">${admin ? "Great games start with great planning." : "Your next great game is just a rally away."}</h2><p>${admin ? "Build balanced teams, keep your courts moving, and give every player a place to belong." : "Find an open play session, meet a new partner, and keep your momentum going."}</p><a class="btn btn-primary btn-sm" href="#/${admin ? "teams" : "events"}">${admin ? "Build your next lineup" : "Find my next game"} ${icon("arrow-up-right")}</a></div><div class="mini-court" aria-hidden="true"></div></section><div class="stats-grid">${admin ? stat("Total players", data.totalPlayers, "users", `${data.activePlayers} active members`) + stat("Upcoming events", data.upcoming, "calendar-days", `${data.openPlay} open play · ${data.tournaments} tournaments`) + stat("Completed matches", data.completedMatches, "swords", "Official finalized results") + stat("Needs attention", data.provisional, "badge-check", `${data.pending} players on waiting lists`) : stat("Matches played", data.matches, "swords", "Every game is progress") + stat("Total wins", data.wins, "trophy", `${data.losses} losses`) + stat("Win rate", `${data.winRate.toFixed(1)}%`, "trending-up", "Based on completed matches") + stat("Current streak", data.streak, "flame", `Personal best: ${data.longestStreak} wins`)}</div><div class="dashboard-grid"><section class="panel"><div class="panel-header"><div><h3>${admin ? "Player growth" : "Your performance"}</h3><p>${admin ? "New members by month" : "Matches and wins, month by month"}</p></div><span class="badge">ALL TIME</span></div><div class="chart-container"><canvas id="performance-chart" aria-label="Monthly performance"></canvas></div>${!Object.keys(admin ? data.growth : data.monthly).length ? '<p class="subtle text-center mt-2">Your story starts with the first match.</p>' : ""}</section><section class="panel"><div class="panel-header"><div><h3>${admin ? "Skill distribution" : "Wins & losses"}</h3><p>${admin ? "A place for every level" : "A snapshot of your game"}</p></div>${icon("chart-pie")}</div><div class="chart-container"><canvas id="distribution-chart" aria-label="Results distribution"></canvas></div></section></div><div class="section-top"><div><h2>Next up on court</h2><p class="mb-0 subtle">${upcoming.length} upcoming club events</p></div><a class="btn btn-secondary btn-sm" href="#/events">View all ${icon("arrow-right")}</a></div><div class="events-grid">${upcoming.slice(0, 3).map(eventCard).join("") || empty("No upcoming events", admin ? "Create an event to get your club playing." : "New club events will appear here.")}</div>`;
  const monthly = admin ? data.growth : data.monthly;
  chart(
    "performance-chart",
    "bar",
    Object.keys(monthly),
    admin
      ? [
          {
            label: "New players",
            data: Object.values(monthly),
            backgroundColor: "#b5e61d",
            borderRadius: 5,
            maxBarThickness: 35,
          },
        ]
      : [
          {
            label: "Matches",
            data: Object.values(monthly).map((v) => v.matches),
            backgroundColor: "#e8eddb",
            borderRadius: 5,
            maxBarThickness: 25,
          },
          {
            label: "Wins",
            data: Object.values(monthly).map((v) => v.wins),
            backgroundColor: "#b5e61d",
            borderRadius: 5,
            maxBarThickness: 25,
          },
        ],
  );
  chart(
    "distribution-chart",
    "doughnut",
    admin ? rankings : ["Wins", "Losses"],
    [
      {
        data: admin ? data.rankingDistribution : [data.wins, data.losses],
        backgroundColor: admin
          ? rankings.map((_, i) => `hsl(${75 + i * 13} 45% ${40 + i * 2}%)`)
          : ["#b5e61d", "#e7ebf0"],
        borderWidth: 0,
      },
    ],
    { cutout: "76%" },
  );
  if (!admin) {
    await mountPlayerRating(content, rankings, chart);
    await mountStarRanking(content, user, chart);
  }
}
async function eventsPage(content, route) {
  const { events } = await api("/events");
  const admin = user.role === "admin";
  const titles = {
    events: "Find your next game",
    "open-play": "Open play management",
    tournaments: "Tournament management",
    "my-events": "Your place on court",
    teams: "Team generator",
    matches: "Match management",
  };
  let filtered = events
    .filter(
      (e) =>
        route !== "my-events" ||
        ["confirmed", "waitlisted"].includes(e.registration),
    )
    .filter((e) => route !== "open-play" || e.eventType === "open-play")
    .filter((e) => route !== "tournaments" || e.eventType === "tournament");
  content.innerHTML =
    heading(
      titles[route] || "Events",
      ["teams", "matches"].includes(route)
        ? "Select an event to manage its teams and match schedule."
        : "Good games. Familiar faces. Something to look forward to.",
      admin
        ? '<a class="btn btn-primary" href="#/events/new">+ Create event</a>'
        : "",
    ) +
    `<div class="filters"><input id="event-search" class="form-control" placeholder="Search events or venues" aria-label="Search events"><select class="form-select" id="event-filter" aria-label="Filter event status"><option value="">All statuses</option>${["registration-open", "registration-closed", "ongoing", "completed", "cancelled", "draft"].map((s) => `<option>${s}</option>`).join("")}</select></div><div class="events-grid" id="event-list"></div>`;
  const draw = () => {
    const term = document.querySelector("#event-search").value.toLowerCase(),
      status = document.querySelector("#event-filter").value;
    document.querySelector("#event-list").innerHTML =
      filtered
        .filter(
          (e) =>
            `${e.eventName} ${e.location}`.toLowerCase().includes(term) &&
            (!status || e.status === status),
        )
        .map(eventCard)
        .join("") ||
      empty("No events to show", "Try another filter or check back soon.");
    lucide.createIcons();
  };
  document.querySelector("#event-search").oninput = draw;
  document.querySelector("#event-filter").onchange = draw;
  draw();
}
async function profile(content) {
  const { history } = await api("/players/me/rankings");
  content.innerHTML =
    heading("Make yourself at home.", "Keep your player profile up to date.") +
    `<div class="profile-grid"><div class="panel"><div class="panel-header"><div class="player-name">${avatar(user)}<h3>${esc(user.fullName)}</h3></div>${badge(user)}</div><form id="profile-form"><div class="form-grid">${field("Full name", "fullName", user.fullName, "text", "required")}${field("Mobile number", "phone", user.phone, "tel")}${field("Gender (optional)", "gender", user.gender)}${field("Date of birth (optional)", "dateOfBirth", user.dateOfBirth?.slice(0, 10), "date")}${field("Profile image HTTPS URL", "profileImage", user.profileImage, "url")}<div><label class="form-label">Email address</label><div class="form-control bg-light">${esc(user.email)}</div></div></div><div class="form-actions"><button class="btn btn-primary">Save profile</button></div></form></div><div><div class="panel mb-4"><h3>Your skill level</h3><div class="my-3">${badge(user)}</div><p class="subtle">Rated results can confirm your automatic skill category when the club enables automatic ranking. Manual administrator overrides remain in effect until released.</p>${history.map((h) => `<p class="subtle">${date(h.changedAt)} · ${rankings[h.newRanking - 1]}<br>${esc(h.reason)}</p>`).join("")}</div><div class="panel"><h3>Email verification</h3><p>${user.emailVerified ? "Your email is verified." : "Verify your email using the link in your inbox."}</p>${!user.emailVerified ? '<button class="btn btn-secondary" id="resend">Send verification link</button>' : '<span class="badge green">VERIFIED</span>'}</div></div></div>`;
  document.querySelector("#profile-form").onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (!data.dateOfBirth) delete data.dateOfBirth;
    const result = await api("/players/me", "PUT", data);
    user = result.user;
    toast("Profile saved");
    render();
  };
  if (document.querySelector("#resend"))
    document.querySelector("#resend").onclick = async () =>
      toast((await api("/auth/resend-verification", "POST", {})).message);
}
async function historyPage(content) {
  const { matches, names } = await api("/players/me/matches");
  content.innerHTML =
    heading(
      "Every rally tells a story.",
      "Your official results, all in one place.",
    ) +
    `<div class="filters"><input class="form-control" id="history-search" placeholder="Search event, teammate, or result" aria-label="Search match history"></div><section class="panel"><div id="history-table"></div></section>`;
  const draw = () => {
    const q = document.querySelector("#history-search").value.toLowerCase();
    const rows = matches.filter((m) =>
      `${m.eventId.eventName} ${names[m.teammate]} ${m.result}`
        .toLowerCase()
        .includes(q),
    );
    document.querySelector("#history-table").innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Teammate</th><th>Opponents</th><th>Score</th><th>Result</th></tr></thead><tbody>${rows.map((m) => `<tr><td>${date(m.completedAt)}</td><td>${esc(m.eventId.eventName)}</td><td>${esc(names[m.teammate])}</td><td>${m.opponents.map((p) => esc(names[p])).join(" & ")}</td><td>${m.scores.map((s) => `${s.a}–${s.b}`).join(", ")}</td><td><span class="badge ${m.result === "Win" ? "green" : ""}">${m.result}</span></td></tr>`).join("")}</tbody></table></div>`
      : empty("No matches yet", "Your finalized results will appear here.");
  };
  document.querySelector("#history-search").oninput = draw;
  draw();
}
async function leaderboard(content) {
  content.innerHTML =
    heading(
      "A little friendly competition.",
      "Club standings celebrate results. Skill categories stay separate.",
    ) +
    `<div class="filters"><select id="rank-filter" class="form-select" aria-label="Skill level"><option value="">All skill levels</option>${rankings.map((r, i) => `<option value="${i + 1}">${r}</option>`).join("")}</select><select id="period-filter" class="form-select" aria-label="Time period"><option value="">All time</option><option value="month">Current month (UTC)</option><option value="year">Current year (UTC)</option></select><select id="type-filter" class="form-select" aria-label="Event type"><option value="">All events</option><option value="open-play">Open play</option><option value="tournament">Tournaments</option></select></div><div class="panel" id="leaderboard-table"></div>`;
  const draw = async () => {
    const { players, settings } = await api(
      `/leaderboard?rank=${document.querySelector("#rank-filter").value}&period=${document.querySelector("#period-filter").value}&type=${document.querySelector("#type-filter").value}`,
    );
    document.querySelector("#leaderboard-table").innerHTML =
      `<div class="panel-header"><h3>Club leaderboard</h3><span class="subtle">Ordered by ${settings.leaderboardOrder}${settings.leaderboardOrder === "winRate" ? ` · ${settings.minimumMatches}+ matches` : ""}</span></div>` +
      (players.length
        ? `<div class="table-wrap"><table><thead><tr><th>Position</th><th>Player</th><th>Skill level</th><th>Doubles Elo</th><th>Matches</th><th>Wins</th><th>Losses</th><th>Win rate</th></tr></thead><tbody>${players.map((p, i) => `<tr><td><strong>${String(i + 1).padStart(2, "0")}</strong></td><td><span class="player-name">${avatar(p)}${esc(p.fullName)}</span></td><td>${badge(p)}</td><td><strong>${p.rating.toFixed(1)}</strong><div class="subtle">${p.rankingOverride ? "Manual category" : `${p.doublesRatedMatches || 0} rated matches`}</div></td><td>${p.matches}</td><td>${p.wins}</td><td>${p.losses}</td><td><strong>${p.winRate.toFixed(1)}%</strong></td></tr>`).join("")}</tbody></table></div>`
        : empty("No players match these filters"));
  };
  for (const select of content.querySelectorAll("select"))
    select.onchange = draw;
  await draw();
}
async function playersPage(content) {
  const { players } = await api("/admin/players");
  content.innerHTML =
    heading(
      "The people behind every rally.",
      "Manage club membership and confirm player skill levels.",
    ) +
    `<div class="filters"><input class="form-control" id="player-search" placeholder="Search players" aria-label="Search players"><select class="form-select" id="ranking-status" aria-label="Ranking status"><option value="">All rankings</option><option value="provisional">Provisional</option><option value="confirmed">Confirmed</option></select></div><div class="panel" id="players-table"></div>`;
  const draw = () => {
    const q = document.querySelector("#player-search").value.toLowerCase(),
      status = document.querySelector("#ranking-status").value;
    const rows = players.filter(
      (p) =>
        `${p.fullName} ${p.email}`.toLowerCase().includes(q) &&
        (!status || p.rankingStatus === status),
    );
    document.querySelector("#players-table").innerHTML =
      `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Email</th><th>Skill level</th><th>Doubles Elo</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map((p) => `<tr><td><span class="player-name">${avatar(p)}${esc(p.fullName)}</span></td><td>${esc(p.email)}</td><td>${badge(p)}</td><td>${(p.doublesRating ?? 100 + ((p.officialRanking || p.provisionalRanking) - 1) * 200).toFixed(1)}${p.rankingOverride ? " ? manual" : ""}</td><td>${p.active ? "Active" : "Inactive"}</td><td><div class="inline-actions"><button class="btn btn-secondary btn-sm" data-rank="${p._id}">Manage rating</button>${p.role !== "admin" ? `<button class="btn btn-secondary btn-sm" data-pickle-que="${p._id}">Pickle Que rank review</button><button class="btn btn-secondary btn-sm" data-active="${p._id}">${p.active ? "Deactivate" : "Activate"}</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>`;
    content.querySelectorAll("[data-rank]").forEach(
      (b) =>
        (b.onclick = async () => {
          const p = players.find((p) => p._id === b.dataset.rank);
          if (await manualRatingOverride(p, rankings)) render();
        }),
    );
    content.querySelectorAll("[data-pickle-que]").forEach((b) => {
      b.onclick = async () => {
        if (await reviewPickleQue(b.dataset.pickleQue)) render();
      };
    });
    content.querySelectorAll("[data-active]").forEach(
      (b) =>
        (b.onclick = async () => {
          const p = players.find((p) => p._id === b.dataset.active);
          if (
            await confirm(
              `${p.active ? "Deactivate" : "Activate"} ${p.fullName}?`,
              "This updates their ability to sign in. Existing event history is preserved.",
            )
          ) {
            await api(`/admin/players/${p._id}/active`, "PUT", {
              active: !p.active,
            });
            render();
          }
        }),
    );
  };
  document.querySelector("#player-search").oninput = draw;
  document.querySelector("#ranking-status").onchange = draw;
  draw();
}
async function statistics(content, admin) {
  if (admin) {
    const data = await api("/admin/reports"),
      { logs } = await api("/admin/audit-logs");
    content.innerHTML =
      heading(
        "The bigger picture.",
        "Club participation, growth, and a record of official changes.",
        '<button class="btn btn-secondary" id="export-report">Export participation</button>',
      ) +
      `<div class="stats-grid">${stat("Active members", data.activePlayers, "users", "Registered club players")}${stat("Open play events", data.openPlay, "calendar-days", "All statuses")}${stat("Tournaments", data.tournaments, "trophy", "All statuses")}${stat("Waitlisted", data.pending, "clock", "Awaiting an available spot")}</div><div class="dashboard-grid"><div class="panel"><h3>Event participation</h3><div class="chart-container mt-4"><canvas id="participation"></canvas></div></div><div class="panel"><h3>Ranking distribution</h3><div class="chart-container mt-4"><canvas id="ranks"></canvas></div></div></div><div class="panel"><h3 class="mb-3">Administrator activity</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Administrator</th><th>Action</th><th>Record</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${date(l.timestamp)} ${time(l.timestamp)}</td><td>${esc(l.actorId?.fullName)}</td><td>${esc(l.action)}</td><td>${esc(l.entityType)} · ${esc(l.entityId)}</td></tr>`).join("")}</tbody></table></div></div>`;
    chart(
      "participation",
      "bar",
      data.events.map((e) => e.eventName),
      [
        {
          data: data.events.map((e) => e.confirmedCount),
          backgroundColor: "#b5e61d",
          borderRadius: 5,
        },
      ],
    );
    chart("ranks", "bar", rankings, [
      {
        data: data.rankingDistribution,
        backgroundColor: "#101828",
        borderRadius: 4,
      },
    ]);
    document.querySelector("#export-report").onclick = () =>
      download("club-participation.csv", [
        ["Event", "Type", "Status", "Participants", "Capacity"],
        ...data.events.map((e) => [
          e.eventName,
          e.eventType,
          e.status,
          e.confirmedCount,
          e.capacity,
        ]),
      ]);
    return;
  }
  const data = await api("/players/me/stats"),
    { names } = await api("/players/me/matches");
  content.innerHTML =
    heading(
      "Small gains. A stronger game.",
      "Follow your progress, one match at a time.",
    ) +
    `<div class="stats-grid">${stat("Points scored", data.pointsScored, "target", `${data.pointsConceded} conceded`)}${stat("Point differential", data.pointDifferential, "trending-up", "Scored minus conceded")}${stat("Events joined", data.openPlay + data.tournaments, "calendar-days", `${data.openPlay} open play · ${data.tournaments} tournaments`)}${stat("Championships", data.championships, "trophy", "Tournament titles")}</div><div class="dashboard-grid"><div class="panel"><h3>Win rate over time</h3><div class="chart-container mt-4"><canvas id="winrate"></canvas></div></div><div class="panel"><h3>Event participation</h3><div class="chart-container mt-4"><canvas id="eventtypes"></canvas></div></div><div class="panel"><h3>Performance by teammate</h3><div class="chart-container mt-4"><canvas id="teammates"></canvas></div></div><div class="panel"><h3>Monthly participation</h3><div class="chart-container mt-4"><canvas id="monthly"></canvas></div></div></div>`;
  chart(
    "winrate",
    "line",
    data.history.map((m) => date(m.completedAt)),
    [
      {
        label: "Win rate",
        data: data.history.map((m) => m.cumulativeWinRate),
        borderColor: "#8cac20",
        backgroundColor: "#b5e61d22",
        tension: 0.3,
      },
    ],
  );
  chart(
    "eventtypes",
    "doughnut",
    ["Open play", "Tournaments"],
    [
      {
        data: [data.openPlay, data.tournaments],
        backgroundColor: ["#b5e61d", "#101828"],
        borderWidth: 0,
      },
    ],
  );
  chart(
    "teammates",
    "bar",
    Object.keys(data.teammates).map((id) => names[id] || "Player"),
    [
      {
        label: "Wins",
        data: Object.values(data.teammates).map((v) => v.wins),
        backgroundColor: "#b5e61d",
      },
    ],
  );
  chart("monthly", "bar", Object.keys(data.monthly), [
    {
      data: Object.values(data.monthly).map((v) => v.matches),
      backgroundColor: "#101828",
      borderRadius: 5,
    },
  ]);
}
async function settings(content) {
  const { settings } = await api("/admin/settings");
  content.innerHTML =
    heading(
      "Your club. Your rules.",
      "Configure how the leaderboard celebrates player results.",
    ) +
    `<section class="panel" style="max-width:700px"><form id="settings-form"><div class="form-grid"><div><label class="form-label" for="leaderboardOrder">Leaderboard ordering</label><select class="form-select" name="leaderboardOrder" id="leaderboardOrder">${[
      ["wins", "Total wins"],
      ["rating", "Current doubles Elo rating"],
      ["winRate", "Win percentage"],
      ["points", "Tournament points (3 per win + 10 per title)"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${settings.leaderboardOrder === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select></div>${field("Minimum matches for win-rate ranking", "minimumMatches", settings.minimumMatches, "number", 'min="0" max="1000" required')}</div><p class="subtle mt-4">Configure automatic ranking below. Administrator overrides lock a skill category until released.</p><div class="form-actions"><button class="btn btn-primary">Save settings</button></div></form></section>`;
  document.querySelector("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    await api(
      "/admin/settings",
      "PUT",
      Object.fromEntries(new FormData(e.target)),
    );
    toast("Settings saved");
  };
  await mountRatingSettings(content, rankings);
}
async function notifications(content) {
  const { notifications } = await api("/notifications");
  content.innerHTML =
    heading(
      "From around the club.",
      "Your registrations, assignments, and results.",
    ) +
    `<section class="panel">${notifications.map((n) => `<article class="notification"><div class="d-flex justify-content-between gap-3"><strong>${esc(n.title)}</strong><span class="subtle">${date(n.createdAt)}</span></div><p>${esc(n.message)}</p>${n.isRead ? '<span class="subtle">Read</span>' : `<button class="btn btn-secondary btn-sm" data-read="${n._id}">Mark as read</button>`}</article>`).join("") || empty("You’re all caught up", "Club updates will appear here.")}</section>`;
  content.querySelectorAll("[data-read]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api(`/notifications/${b.dataset.read}/read`, "PUT", {});
        render();
      }),
  );
}
let rendering = false;
async function render() {
  if (rendering) return;
  rendering = true;
  charts.forEach((c) => c.destroy());
  charts = [];
  try {
    if (user) user = (await api("/auth/me")).user;
    const parts = (location.hash.replace(/^#\/?/, "") || "").split("/"),
      route = parts[0];
    if (!user) {
      if (["login", "register", "forgot", "reset"].includes(route))
        authPage(route);
      else await landing();
    } else {
      if (!route || ["login", "register"].includes(route)) {
        history.replaceState(null, "", "#/dashboard");
      }
      const active = route || "dashboard";
      shell(active);
      const content = document.querySelector("#content");
      if (active === "events" && parts[1] === "new")
        await eventForm(content, state);
      else if (active === "events" && parts[1]) {
        if (parts[2] === "edit") await eventForm(content, state, parts[1]);
        else await eventDetail(content, state, parts[1]);
      } else if (
        [
          "events",
          "open-play",
          "tournaments",
          "my-events",
          "teams",
          "matches",
        ].includes(active)
      )
        await eventsPage(content, active);
      else if (active === "profile") await profile(content);
      else if (active === "history") await historyPage(content);
      else if (active === "ranking") await rankingPage(content, user, chart);
      else if (active === "leaderboard") await leaderboard(content);
      else if (active === "players" && user.role === "admin")
        await playersPage(content);
      else if (["statistics", "reports"].includes(active))
        await statistics(content, user.role === "admin");
      else if (active === "settings" && user.role === "admin")
        await settings(content);
      else if (active === "notifications") await notifications(content);
      else await dashboard(content);
    }
    lucide.createIcons();
  } catch (error) {
    if (error.status === 401) {
      user = null;
      location.hash = "#/login";
    } else {
      const content = document.querySelector("#content") || app;
      content.innerHTML = `<div class="error-message">${esc(error.message)}</div><button class="btn btn-secondary" id="retry">Try again</button>`;
      document.querySelector("#retry").onclick = render;
    }
  } finally {
    rendering = false;
  }
}
let latestNotification;
async function refreshNotifications(showNew = false) {
  try {
    const { notifications } = await api("/notifications");
    const latest = notifications[0];
    if (
      showNew &&
      latest &&
      latest._id !== latestNotification &&
      !latest.isRead &&
      !Swal.isVisible()
    )
      toast(latest.title);
    latestNotification = latest?._id;
    const bell = document.querySelector('a[aria-label="Notifications"]');
    if (bell)
      bell.setAttribute(
        "aria-label",
        `Notifications (${notifications.filter((n) => !n.isRead).length} unread)`,
      );
  } catch (err) {
    if (err.status !== 401) console.warn("Could not refresh notifications");
  }
}
function connectSocket() {
  if (!window.io || socket?.connected) return;
  socket = io();
  socket.on("ranking:result", (result) => {
    toast(
      result.protectionActivated
        ? "STAR PROTECTED"
        : result.doubleStarActivated
          ? "DOUBLE STAR BONUS"
          : `${result.starsChanged >= 0 ? "+" : ""}${result.starsChanged} ranked stars`,
    );
    if (result.rankPromoted || result.rankDemoted)
      document.querySelector("#announcer").textContent =
        `${result.rankPromoted ? "Promoted" : "Demoted"} to ${result.rankTier} ${result.rankDivision || ""}`;
  });
  refreshNotifications();
  socket.on("refresh", () => {
    refreshNotifications(true);
    state.refreshEvent?.();
    document.querySelector("#announcer").textContent =
      "Club information has been updated.";
    if (
      /^#\/(dashboard|ranking|leaderboard|notifications|statistics|reports)$/.test(
        location.hash,
      ) &&
      !document.querySelector("input:focus,select:focus,textarea:focus") &&
      !Swal.isVisible()
    )
      render();
  });
}
window.addEventListener("hashchange", render);
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  Swal.fire({
    icon: "error",
    title: "Something needs attention",
    text: e.reason?.message || "Please try again.",
  });
});
try {
  rankings = (await api("/rankings")).rankings;
  try {
    user = (await api("/auth/me")).user;
  } catch (e) {
    if (e.status !== 401) throw e;
  }
  const action = new URLSearchParams(location.search).get("action");
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (action && token) {
    history.replaceState(null, "", "/");
    if (action === "verify") {
      await api("/auth/action", "POST", { purpose: "verify", token });
      if (user) user.emailVerified = true;
      toast("Email verified");
    } else if (action === "reset") {
      sessionStorage.setItem("resetToken", token);
      user = null;
      location.hash = "#/reset";
    }
  }
  if (user) connectSocket();
  await render();
} catch (e) {
  app.innerHTML = `<div class="loading"><div><h2>We couldn’t connect to the club.</h2><p>${esc(e.message)}</p><button class="btn btn-primary" id="reload">Try again</button></div></div>`;
  document.querySelector("#reload").onclick = () => location.reload();
}
