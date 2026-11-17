import {
  api,
  esc,
  icon,
  date,
  time,
  avatar,
  empty,
  toast,
  confirm,
  download,
} from "./api.js";

const ROLE_BADGE = { owner: "orange", host: "blue", member: "green" };
const METHODS = [
  ["gcash", "GCash"],
  ["maya", "Maya"],
  ["bank", "Bank transfer"],
  ["cash", "Cash on site"],
  ["other", "Other"],
];
const methodName = (m) => METHODS.find(([k]) => k === m)?.[1] || m || "";
const PAYMENT_BADGE = {
  unpaid: ["", "Unpaid"],
  submitted: ["orange", "To confirm"],
  paid: ["green", "Paid"],
  waived: ["blue", "Waived"],
};
const ATTENDANCE_BADGE = {
  pending: ["", "Not checked in"],
  present: ["green", "Checked in"],
  "no-show": ["orange", "No-show"],
};
const pill = ([color, text]) => `<span class="badge ${color}">${text}</span>`;
const rankOf = (state, p) =>
  state.rankings[(p.officialRanking || p.provisionalRanking) - 1] || "Unranked";
const who = (state, p, extra = "") =>
  `<span class="player-name">${avatar(p)}<span><strong>${esc(p.fullName)}</strong> ${extra}<br><small class="subtle">@${esc(p.username)} · ${esc(rankOf(state, p))}</small></span></span>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  `<div><label class="form-label" for="${name}">${label}</label><input class="form-control" id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
const area = (label, name, value = "", extra = "", wide = true) =>
  `<div class="${wide ? "wide" : ""}"><label class="form-label" for="${name}">${label}</label><textarea class="form-control" id="${name}" name="${name}" rows="3" ${extra}>${esc(value)}</textarea></div>`;
const localDate = (value) => {
  const d = new Date(value);
  return new Date(+d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
// Disables the submit button while a request runs, so taps can't double-post.
async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function clubCard(c) {
  return `<a class="club-card panel" href="#/clubs/${esc(c.id)}"><div class="club-mark">${esc(c.name.slice(0, 1).toUpperCase())}</div><div class="club-card-body"><h3>${esc(c.name)}</h3><div class="event-meta">${icon("map-pin")}${esc(c.location || "Location not set")}</div><div class="event-meta">${icon("users")}${c.memberCount} member${c.memberCount === 1 ? "" : "s"}</div></div>${c.myRole ? `<span class="badge ${ROLE_BADGE[c.myRole]}">${c.myRole.toUpperCase()}</span>` : ""}</a>`;
}
const clubFields = (c = {}) =>
  `<div class="form-grid">${field("Club name", "name", c.name, "text", 'required minlength="3" maxlength="80"')}${field("Home courts / area", "location", c.location, "text", 'maxlength="200" placeholder="e.g. Matina, Davao City"')}${area("About the club", "description", c.description, 'maxlength="2000" placeholder="Who you are, when you play, skill levels welcome…"')}${area("How players pay you", "paymentInstructions", c.paymentInstructions, 'maxlength="500" placeholder="e.g. GCash 0917 123 4567 (Juan D.). Send your ref no. in the app."')}</div>`;

export async function clubsPage(content, state, heading) {
  content.innerHTML =
    heading(
      "Clubs",
      "Find your crew, follow their meetups, or start a club of your own.",
      `<button class="btn btn-primary" id="new-club">${icon("plus")} Start a club</button>`,
    ) +
    `<form class="panel mb-4" id="club-form" hidden><div class="panel-header"><div><h3>Start a club</h3><p>You’ll be the owner. You can make other members hosts later.</p></div></div>${clubFields()}<div class="form-actions"><button type="button" class="btn btn-secondary" id="cancel-club">Cancel</button><button class="btn btn-primary">Create club</button></div></form><div id="my-clubs"></div><section class="panel"><div class="panel-header"><div><h3>Discover clubs</h3><p>Join a club to get notified when it posts a meetup.</p></div></div><form id="club-search" role="search" class="mb-3"><input class="form-control" id="club-q" type="search" maxlength="60" placeholder="Search clubs by name" aria-label="Search clubs" autocomplete="off"></form><div class="clubs-grid" id="club-list"></div></section>`;
  const form = content.querySelector("#club-form");
  content.querySelector("#new-club").onclick = () => {
    form.hidden = false;
    form.querySelector("input").focus();
  };
  content.querySelector("#cancel-club").onclick = () => (form.hidden = true);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { club } = await busy(e.submitter, () =>
      api("/clubs", "POST", Object.fromEntries(new FormData(form))),
    );
    toast("Club created");
    location.hash = `#/clubs/${club.id}`;
  };
  let q = "";
  const load = async () => {
    const term = q;
    const { clubs } = await api(
      `/clubs${term ? `?q=${encodeURIComponent(term)}` : ""}`,
    );
    if (term !== q) return;
    const mine = clubs.filter((c) => c.myRole);
    if (!term)
      content.querySelector("#my-clubs").innerHTML = mine.length
        ? `<section class="panel mb-4"><div class="panel-header"><h3>My clubs</h3></div><div class="clubs-grid">${mine.map(clubCard).join("")}</div></section>`
        : "";
    const others = term ? clubs : clubs.filter((c) => !c.myRole);
    content.querySelector("#club-list").innerHTML = others.length
      ? others.map(clubCard).join("")
      : empty(
          term ? `No clubs match “${term}”` : "No other clubs yet",
          term ? "" : "Be the first: start a club and invite your friends.",
        );
    lucide.createIcons();
  };
  let timer;
  content.querySelector("#club-q").oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = e.target.value.trim();
      load();
    }, 250);
  };
  content.querySelector("#club-search").onsubmit = (e) => e.preventDefault();
  await load();
}

export async function clubPage(content, state, heading, id) {
  const { club, canManage, members, meetups } = await api(`/clubs/${id}`);
  const owner = club.myRole === "owner";
  const now = Date.now();
  const upcoming = meetups.filter(
    (e) => +new Date(e.endDateTime) >= now && e.status !== "cancelled",
  );
  const recent = meetups.filter((e) => !upcoming.includes(e));
  const joinButton = !club.myRole
    ? `<button class="btn btn-primary" id="join-club">${icon("user-plus")} Join club</button>`
    : owner
      ? ""
      : `<button class="btn btn-secondary" id="leave-club">Leave club</button>`;
  content.innerHTML = `<div class="page-heading"><div><a href="#/clubs" class="subtle">← All clubs</a><div class="mt-3 mb-2">${club.myRole ? `<span class="badge ${ROLE_BADGE[club.myRole]}">${club.myRole.toUpperCase()}</span>` : ""}</div><h1>${esc(club.name)}</h1><p>${club.location ? `${esc(club.location)} · ` : ""}${club.memberCount} member${club.memberCount === 1 ? "" : "s"} · Owner ${esc(club.owner.fullName)}</p></div><div class="inline-actions">${canManage ? `<a class="btn btn-primary" href="#/clubs/${esc(id)}/meetups/new">${icon("calendar-plus")} Post a meetup</a>` : ""}${owner ? `<button class="btn btn-secondary" id="edit-club">${icon("sliders-horizontal")} Edit</button>` : ""}${joinButton}</div></div>
  <form class="panel mb-4" id="club-form" hidden><div class="panel-header"><h3>Edit club</h3></div>${clubFields(club)}<div class="form-actions"><button type="button" class="btn btn-danger me-auto" id="delete-club">Delete club</button><button type="button" class="btn btn-secondary" id="cancel-edit">Cancel</button><button class="btn btn-primary">Save changes</button></div></form>
  <div class="profile-grid"><div><section class="panel mb-4"><div class="panel-header"><div><h3>Upcoming meetups</h3><p>${club.myRole ? "You’ll get a notification for each new meetup." : "Join the club to be notified of new meetups."}</p></div></div><div class="events-grid">${upcoming.map(state.eventCard).join("") || empty("No meetups scheduled", canManage ? "Post one so members can RSVP." : "Check back soon.")}</div></section>${recent.length ? `<section class="panel"><div class="panel-header"><h3>Recent</h3></div>${recent.map((e) => `<div class="social-row"><span><a href="#/events/${e._id}"><strong>${esc(e.eventName)}</strong></a><br><small class="subtle">${date(e.startDateTime)} · ${e.confirmedCount} played</small></span>${e.status === "cancelled" ? '<span class="badge">cancelled</span>' : ""}</div>`).join("")}</section>` : ""}</div>
  <div><section class="panel mb-4"><h3>About</h3><p class="mt-3 mb-0" style="white-space:pre-line">${esc(club.description) || "No description yet."}</p></section><section class="panel"><div class="panel-header"><h3>Members</h3><span class="badge">${members.length}</span></div>${members
    .map((m) => {
      const self = m.id === state.user.id;
      const controls = [];
      if (owner && m.role !== "owner")
        controls.push(
          m.role === "host"
            ? `<button class="btn btn-secondary btn-sm" data-role="member" data-user="${esc(m.id)}">Remove host</button>`
            : `<button class="btn btn-secondary btn-sm" data-role="host" data-user="${esc(m.id)}">Make host</button>`,
        );
      if (
        canManage &&
        !self &&
        m.role !== "owner" &&
        (m.role === "member" || owner)
      )
        controls.push(
          `<button class="btn btn-secondary btn-sm" data-kick="${esc(m.id)}" data-name="${esc(m.fullName)}" aria-label="Remove ${esc(m.fullName)}">${icon("x")}</button>`,
        );
      return `<div class="social-row">${who(state, m, m.role !== "member" ? `<span class="badge ${ROLE_BADGE[m.role]}">${m.role}</span>` : "")}<div class="social-actions">${!self ? `<a class="btn btn-secondary btn-sm" href="#/messages/${esc(m.id)}" aria-label="Message ${esc(m.fullName)}">${icon("message-circle")}</a>` : ""}${controls.join("")}</div></div>`;
    })
    .join("")}</section></div></div>`;

  const $ = (s) => content.querySelector(s);
  if ($("#join-club"))
    $("#join-club").onclick = async (e) => {
      const { message } = await busy(e.currentTarget, () =>
        api(`/clubs/${id}/join`, "POST", {}),
      );
      toast(message);
      state.render();
    };
  if ($("#leave-club"))
    $("#leave-club").onclick = async () => {
      if (
        !(await confirm(
          `Leave ${club.name}?`,
          "You’ll stop getting its meetup notifications.",
        ))
      )
        return;
      await api(`/clubs/${id}/join`, "DELETE");
      toast("You left the club");
      state.render();
    };
  const form = $("#club-form");
  if ($("#edit-club")) {
    $("#edit-club").onclick = () => (form.hidden = false);
    $("#cancel-edit").onclick = () => (form.hidden = true);
    form.onsubmit = async (e) => {
      e.preventDefault();
      await busy(e.submitter, () =>
        api(`/clubs/${id}`, "PUT", Object.fromEntries(new FormData(form))),
      );
      toast("Club updated");
      state.render();
    };
    $("#delete-club").onclick = async () => {
      if (
        !(await confirm(
          `Delete ${club.name}?`,
          "Members are removed and past meetups stay in the event history. Cancel upcoming meetups first. This can’t be undone.",
        ))
      )
        return;
      await api(`/clubs/${id}`, "DELETE");
      toast("Club deleted");
      location.hash = "#/clubs";
    };
  }
  content.querySelectorAll("[data-role]").forEach(
    (b) =>
      (b.onclick = async () => {
        await busy(b, () =>
          api(`/clubs/${id}/members/${b.dataset.user}`, "PUT", {
            role: b.dataset.role,
          }),
        );
        toast("Role updated");
        state.render();
      }),
  );
  content.querySelectorAll("[data-kick]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirm(`Remove ${b.dataset.name} from the club?`))) return;
        await busy(b, () =>
          api(`/clubs/${id}/members/${b.dataset.kick}`, "DELETE"),
        );
        toast("Member removed");
        state.render();
      }),
  );
}

export async function meetupForm(content, state, clubId, eventId) {
  const { club, canManage } = await api(`/clubs/${clubId}`);
  if (!canManage)
    throw new Error("Only club owners and hosts can post meetups");
  const start = new Date(Date.now() + 86400_000);
  start.setMinutes(0, 0, 0);
  const e = eventId
    ? (await api(`/events/${eventId}`)).event
    : {
        eventName: "",
        description: "",
        location: club.location,
        startDateTime: start,
        endDateTime: new Date(+start + 3 * 3600_000),
        registrationDeadline: start,
        capacity: 16,
        minRanking: 1,
        maxRanking: 12,
        fee: 0,
        waitlistEnabled: true,
        courts: ["1", "2"],
        format: "random",
      };
  const levels = (name, current) =>
    `<div><label class="form-label" for="${name}">${name === "minRanking" ? "Lowest level" : "Highest level"}</label><select class="form-select" id="${name}" name="${name}">${state.rankings.map((r, i) => `<option value="${i + 1}" ${current === i + 1 ? "selected" : ""}>${i + 1} · ${esc(r)}</option>`).join("")}</select></div>`;
  const formats = [
    ["random", "Live queue (random, best for drop-in)"],
    ["rotating", "Rotating partners"],
    ["balanced", "Skill-balanced"],
    ["round-robin", "Round robin"],
  ];
  content.innerHTML = `<div class="page-heading"><div><a href="#/clubs/${esc(clubId)}" class="subtle">← ${esc(club.name)}</a><h1 class="mt-2">${eventId ? "Edit meetup" : "Post a meetup"}</h1><p>Members of ${esc(club.name)} get notified, and anyone can RSVP.</p></div></div><form class="panel" id="meetup-form"><div class="form-grid">${field("Title", "eventName", e.eventName, "text", 'required minlength="3" maxlength="120" placeholder="e.g. Tuesday Night Open Play"')}${field("Venue", "location", e.location, "text", 'required minlength="2" maxlength="200"')}${field("Starts", "startDateTime", localDate(e.startDateTime), "datetime-local", "required")}${field("Ends", "endDateTime", localDate(e.endDateTime), "datetime-local", "required")}${field("RSVP closes", "registrationDeadline", localDate(e.registrationDeadline), "datetime-local", "required")}${field("Player slots", "capacity", e.capacity, "number", 'required min="4" max="256"')}${field("Fee per player (₱)", "fee", e.fee, "number", 'required min="0" max="100000" step="1"')}${field("Courts (comma-separated)", "courts", e.courts.join(", "), "text", "required")}${levels("minRanking", e.minRanking)}${levels("maxRanking", e.maxRanking)}<div><label class="form-label" for="format">Play format</label><select class="form-select" id="format" name="format">${formats.map(([k, t]) => `<option value="${k}" ${e.format === k ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="d-flex align-items-end"><label class="form-check"><input class="form-check-input" type="checkbox" name="waitlistEnabled" ${e.waitlistEnabled ? "checked" : ""}> Waitlist when full</label></div>${area("Details", "description", e.description, 'maxlength="3000" placeholder="What to bring, parking, ball type, court rules…"')}</div><div class="form-actions">${eventId ? `<button type="button" class="btn btn-danger me-auto" id="cancel-meetup">Cancel meetup</button>` : ""}<a class="btn btn-secondary" href="#/clubs/${esc(clubId)}">Back</a><button class="btn btn-primary">${eventId ? "Save changes" : "Post meetup"}</button></div></form>`;
  const form = content.querySelector("#meetup-form");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const iso = (v) => new Date(v).toISOString();
    const body = {
      ...d,
      startDateTime: iso(d.startDateTime),
      endDateTime: iso(d.endDateTime),
      registrationDeadline: iso(d.registrationDeadline),
      courts: d.courts
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      waitlistEnabled: form.elements.waitlistEnabled.checked,
    };
    const { event } = await busy(ev.submitter, () =>
      eventId
        ? api(`/clubs/${clubId}/meetups/${eventId}`, "PUT", body)
        : api(`/clubs/${clubId}/meetups`, "POST", body),
    );
    toast(eventId ? "Meetup updated" : "Meetup posted");
    location.hash = `#/events/${event._id}`;
  };
  const cancel = content.querySelector("#cancel-meetup");
  if (cancel)
    cancel.onclick = async () => {
      if (
        !(await confirm(
          "Cancel this meetup?",
          "Everyone who joined will be notified. This can’t be undone.",
        ))
      )
        return;
      await api(`/clubs/${clubId}/meetups/${eventId}/cancel`, "POST", {});
      toast("Meetup cancelled");
      location.hash = `#/clubs/${clubId}`;
    };
}

// Player-facing payment box on the event overview.
export function paymentPanel(event, club, mine) {
  if (!event.fee || !mine || mine.registrationStatus === "cancelled") return "";
  const status = mine.paymentStatus;
  const settled = ["paid", "waived"].includes(status);
  const howTo = club?.paymentInstructions
    ? `<p class="mt-2 mb-3" style="white-space:pre-line">${esc(club.paymentInstructions)}</p>`
    : `<p class="subtle mt-2 mb-3">Ask the host how to pay.</p>`;
  return `<div class="divider"></div><h3>Payment · ₱${event.fee.toLocaleString()}</h3><div class="mt-2">${pill(PAYMENT_BADGE[status])}</div>${
    settled
      ? `<p class="subtle mt-2 mb-0">${status === "paid" ? "The host confirmed your payment." : "The host waived your fee."}</p>`
      : `${status === "submitted" ? `<p class="subtle mt-2">Sent via ${esc(methodName(mine.paymentMethod))}${mine.paymentReference ? ` · ref ${esc(mine.paymentReference)}` : ""}. Waiting for the host to confirm. You can correct it below.</p>` : ""}${howTo}<form id="payment-form" class="d-grid gap-2"><select class="form-select" name="paymentMethod" aria-label="Payment method">${METHODS.map(([k, t]) => `<option value="${k}" ${mine.paymentMethod === k ? "selected" : ""}>${t}</option>`).join("")}</select><input class="form-control" name="paymentReference" maxlength="100" placeholder="Reference no. (not needed for cash)" aria-label="Payment reference number" value="${esc(mine.paymentReference || "")}"><button class="btn btn-primary">${status === "submitted" ? "Update payment" : "I’ve paid"}</button></form>`
  }`;
}
export function wirePaymentPanel(root, eventId, state) {
  const form = root.querySelector("#payment-form");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { message } = await busy(e.submitter, () =>
      api(
        `/events/${eventId}/payment`,
        "PUT",
        Object.fromEntries(new FormData(form)),
      ),
    );
    toast(message);
    state.render();
  };
}

// Host tab: day-of check-in and fee collection for one event.
export async function hostTab(container, state, event) {
  const { roster, summary } = await api(`/events/${event._id}/roster`);
  const fee = event.fee > 0;
  const checkInOpen =
    Date.now() >= +new Date(event.startDateTime) - 2 * 3600_000;
  const confirmed = roster.filter((r) => r.registrationStatus === "confirmed");
  const waiting = roster.filter((r) => r.registrationStatus !== "confirmed");
  const stat = (label, value, foot) =>
    `<div class="stat-card"><div class="stat-top">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;
  const row = (r) => {
    const p = r.player;
    const attendance = checkInOpen
      ? `<div class="segmented" role="group" aria-label="Attendance for ${esc(p.fullName)}">${[
          ["present", "Here"],
          ["no-show", "No-show"],
          ["pending", "—"],
        ]
          .map(
            ([v, t]) =>
              `<button class="btn btn-sm ${r.attendance === v ? (v === "present" ? "btn-primary" : v === "no-show" ? "btn-danger" : "btn-secondary") : "btn-secondary"}" data-attend="${v}" data-user="${esc(p.id)}" aria-pressed="${r.attendance === v}">${t}</button>`,
          )
          .join("")}</div>`
      : pill(ATTENDANCE_BADGE[r.attendance]);
    const payment = fee
      ? `<td>${pill(PAYMENT_BADGE[r.paymentStatus])}${r.paymentMethod ? `<br><small class="subtle">${esc(methodName(r.paymentMethod))}${r.paymentReference ? ` · ${esc(r.paymentReference)}` : ""}</small>` : ""}</td><td><div class="inline-actions">${r.paymentStatus !== "paid" ? `<button class="btn btn-primary btn-sm" data-pay="paid" data-user="${esc(p.id)}">Mark paid</button>` : `<button class="btn btn-secondary btn-sm" data-pay="unpaid" data-user="${esc(p.id)}">Undo</button>`}${r.paymentStatus === "submitted" ? `<button class="btn btn-secondary btn-sm" data-pay="unpaid" data-user="${esc(p.id)}" data-reject="1">Reject</button>` : ""}${["unpaid", "submitted"].includes(r.paymentStatus) ? `<button class="btn btn-secondary btn-sm" data-pay="waived" data-user="${esc(p.id)}">Waive</button>` : ""}</div></td>`
      : "";
    return `<tr><td>${who(state, p)}</td><td>${attendance}${r.checkedInAt ? `<br><small class="subtle">${time(r.checkedInAt)}</small>` : ""}</td>${payment}</tr>`;
  };
  container.innerHTML = `<div class="stats-grid">${stat("Checked in", `${summary.present}<span class="muted fs-6"> / ${summary.confirmed}</span>`, `${summary.noShow} no-show${summary.noShow === 1 ? "" : "s"}`)}${fee ? stat("Paid", `${summary.paid}<span class="muted fs-6"> / ${summary.confirmed}</span>`, `${summary.awaitingConfirmation} waiting for you to confirm`) + stat("Collected", `₱${summary.collected.toLocaleString()}`, `₱${(event.fee * summary.confirmed).toLocaleString()} expected`) : ""}${stat("Waitlist", summary.waitlisted, event.waitlistEnabled ? "Promoted automatically" : "Waitlist off")}</div>
  ${checkInOpen ? "" : `<div class="notice mb-4">Check-in opens 2 hours before the meetup (${date(new Date(+new Date(event.startDateTime) - 2 * 3600_000))} · ${time(new Date(+new Date(event.startDateTime) - 2 * 3600_000))}). You can confirm payments any time.</div>`}
  <section class="panel"><div class="panel-header"><div><h3>Roster</h3><p>${fee ? "Check players in as they arrive and confirm their payments." : "Check players in as they arrive."}</p></div><div class="inline-actions"><input class="form-control" id="roster-q" type="search" placeholder="Find player" aria-label="Find player on roster"><button class="btn btn-secondary" id="export-roster">${icon("download")} Export</button></div></div>${confirmed.length ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Attendance</th>${fee ? "<th>Payment</th><th>Action</th>" : ""}</tr></thead><tbody id="roster-rows">${confirmed.map(row).join("")}</tbody></table></div>` : empty("No confirmed players yet")}${waiting.length ? `<h3 class="mt-4">Waitlist</h3>${waiting.map((r) => `<div class="social-row">${who(state, r.player)}<span class="badge">#${r.waitlistPosition}</span></div>`).join("")}` : ""}</section>`;

  const reload = () =>
    hostTab(container, state, event).then(() => lucide.createIcons());
  container.querySelectorAll("[data-attend]").forEach(
    (b) =>
      (b.onclick = async () => {
        await busy(b, () =>
          api(
            `/events/${event._id}/roster/${b.dataset.user}/attendance`,
            "PUT",
            { attendance: b.dataset.attend },
          ),
        );
        reload();
      }),
  );
  container.querySelectorAll("[data-pay]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          b.dataset.reject &&
          !(await confirm(
            "Reject this payment?",
            "The player is asked to check their reference and resubmit.",
          ))
        )
          return;
        await busy(b, () =>
          api(`/events/${event._id}/roster/${b.dataset.user}/payment`, "PUT", {
            paymentStatus: b.dataset.pay,
          }),
        );
        reload();
      }),
  );
  const search = container.querySelector("#roster-q");
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    container.querySelectorAll("#roster-rows tr").forEach((tr) => {
      tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
    });
  };
  container.querySelector("#export-roster").onclick = () =>
    download(`${event.eventName}-roster.csv`, [
      [
        "Player",
        "Username",
        "Status",
        "Attendance",
        "Payment",
        "Method",
        "Reference",
      ],
      ...roster.map((r) => [
        r.player.fullName,
        r.player.username,
        r.registrationStatus,
        r.attendance,
        fee ? r.paymentStatus : "",
        methodName(r.paymentMethod),
        r.paymentReference || "",
      ]),
    ]);
}

// Shown on "My events": the player's past meetups and how they went.
export async function attendanceHistory(el) {
  const { summary, history } = await api("/players/me/attendance");
  if (!history.length) {
    el.innerHTML = "";
    return;
  }
  const rate = summary.recorded
    ? Math.round((summary.attended / summary.recorded) * 100)
    : null;
  el.innerHTML = `<section class="panel mt-4"><div class="panel-header"><div><h3>Attendance history</h3><p>${rate === null ? "Hosts haven’t recorded check-ins for your past games yet." : `You showed up to ${summary.attended} of ${summary.recorded} recorded games (${rate}%).`}</p></div>${summary.noShows ? `<span class="badge orange">${summary.noShows} no-show${summary.noShows === 1 ? "" : "s"}</span>` : ""}</div><div class="table-wrap"><table><thead><tr><th>Event</th><th>Date</th><th>Attendance</th><th>Payment</th></tr></thead><tbody>${history
    .map(
      (h) =>
        `<tr><td><a href="#/events/${esc(h.eventId)}"><strong>${esc(h.eventName)}</strong></a><br><small class="subtle">${esc(h.location)}</small></td><td>${date(h.startDateTime)}</td><td>${h.status === "cancelled" ? '<span class="badge">Cancelled</span>' : pill(ATTENDANCE_BADGE[h.attendance])}</td><td>${h.paymentStatus ? pill(PAYMENT_BADGE[h.paymentStatus]) : '<span class="subtle">Free</span>'}</td></tr>`,
    )
    .join("")}</tbody></table></div></section>`;
}
