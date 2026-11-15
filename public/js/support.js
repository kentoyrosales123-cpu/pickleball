import { api, esc, icon, date, avatar, empty, toast } from "./api.js";

export const SUPPORT_LABELS = {
  scam: "Scam or fraud",
  bug: "Bug or error",
  account: "Account problem",
  other: "Other",
};
const STATUS_LABELS = {
  open: "Open",
  "in-progress": "In review",
  resolved: "Resolved",
};
const statusBadge = (s) =>
  `<span class="badge ${s === "resolved" ? "green" : s === "in-progress" ? "blue" : "orange"}">${STATUS_LABELS[s] || esc(s)}</span>`;
const categoryBadge = (c) =>
  `<span class="badge ${c === "scam" ? "orange" : ""}">${esc(SUPPORT_LABELS[c] || c)}</span>`;

function reportForm() {
  return `<section class="panel mb-4"><div class="panel-header"><div><h3>Send a report</h3><p>Reports go straight to the club administrators.</p></div>${icon("life-buoy")}</div><form id="support-form"><div class="form-grid"><div><label class="form-label" for="support-category">What is this about?</label><select class="form-select" id="support-category" name="category" required>${Object.entries(
    SUPPORT_LABELS,
  )
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join(
      "",
    )}</select></div><div><label class="form-label" for="support-page">Where did it happen? (optional)</label><input class="form-control" id="support-page" name="page" maxlength="200" placeholder="e.g. Live session, event page, a message"></div><div class="wide"><label class="form-label" for="support-subject">Subject</label><input class="form-control" id="support-subject" name="subject" required minlength="5" maxlength="120" placeholder="A short summary"></div><div class="wide"><label class="form-label" for="support-message">Details</label><textarea class="form-control" id="support-message" name="message" rows="6" required minlength="10" maxlength="4000" placeholder="What happened? For scams, include who contacted you, how, and what they asked for. For bugs, describe the steps and what you expected."></textarea><small class="subtle">Never include your password in a report.</small></div></div><div id="support-error" role="alert"></div><div class="form-actions"><button class="btn btn-primary" type="submit">Send report ${icon("send")}</button></div></form></section>`;
}

function myReports(tickets) {
  return `<section class="panel mb-4"><div class="panel-header"><div><h3>Your reports</h3><p>Track the status and replies from the club.</p></div></div>${
    tickets.length
      ? tickets
          .map(
            (t) =>
              `<article class="notification"><div class="d-flex justify-content-between gap-3 flex-wrap"><strong>${esc(t.subject)}</strong><span>${categoryBadge(t.category)} ${statusBadge(t.status)}</span></div><p class="subtle mb-1">Sent ${date(t.createdAt)}${t.page ? ` · ${esc(t.page)}` : ""}</p><p>${esc(t.message)}</p>${t.adminReply ? `<div class="notice"><strong>Club reply:</strong> ${esc(t.adminReply)}</div>` : ""}</article>`,
          )
          .join("")
      : empty("No reports yet", "Anything you send will appear here.")
  }</section>`;
}

function inboxItem(t) {
  const who = t.userId || { fullName: "Deleted user" };
  return `<article class="notification" data-ticket="${esc(t._id)}"><div class="d-flex justify-content-between gap-3 flex-wrap"><span class="player-name">${avatar(who)}<span><strong>${esc(t.subject)}</strong><br><small class="subtle">${esc(who.fullName)}${who.username ? ` (@${esc(who.username)})` : ""}${who.email ? ` · ${esc(who.email)}` : ""} · ${date(t.createdAt)}</small></span></span><span>${categoryBadge(t.category)} ${statusBadge(t.status)}</span></div>${t.page ? `<p class="subtle mb-1 mt-2">Where: ${esc(t.page)}</p>` : ""}<p class="mt-2" style="white-space:pre-wrap">${esc(t.message)}</p><form class="support-update"><div class="form-grid"><div><label class="form-label" for="status-${esc(t._id)}">Status</label><select class="form-select" id="status-${esc(t._id)}" name="status">${Object.entries(
    STATUS_LABELS,
  )
    .map(
      ([v, l]) =>
        `<option value="${v}" ${t.status === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="wide"><label class="form-label" for="reply-${esc(t._id)}">Reply to player (optional)</label><textarea class="form-control" id="reply-${esc(t._id)}" name="adminReply" rows="2" maxlength="2000">${esc(t.adminReply)}</textarea></div></div><div class="form-actions"><button class="btn btn-secondary btn-sm" type="submit">Save &amp; notify player</button>${t.handledBy ? `<span class="subtle">Last handled by ${esc(t.handledBy.fullName)}</span>` : ""}</div></form></article>`;
}

async function mountInbox(container) {
  container.innerHTML = `<section class="panel mb-4"><div class="panel-header"><div><h3>Support inbox</h3><p id="support-counts">Reports from club members.</p></div><div class="filters mb-0"><select class="form-select" id="inbox-status" aria-label="Filter by status"><option value="">All statuses</option>${Object.entries(
    STATUS_LABELS,
  )
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join(
      "",
    )}</select><select class="form-select" id="inbox-category" aria-label="Filter by category"><option value="">All categories</option>${Object.entries(
    SUPPORT_LABELS,
  )
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join("")}</select></div></div><div id="inbox-list"></div></section>`;
  const status = container.querySelector("#inbox-status");
  const category = container.querySelector("#inbox-category");
  const list = container.querySelector("#inbox-list");
  status.value = "open";
  const load = async () => {
    const { tickets, counts } = await api(
      `/admin/support/tickets?status=${status.value}&category=${category.value}`,
    );
    container.querySelector("#support-counts").textContent =
      `${counts.open || 0} open · ${counts["in-progress"] || 0} in review · ${counts.resolved || 0} resolved`;
    list.innerHTML =
      tickets.map(inboxItem).join("") ||
      empty("Nothing here", "No reports match these filters.");
    list.querySelectorAll(".support-update").forEach((form) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const id = form.closest("[data-ticket]").dataset.ticket;
        await api(
          `/admin/support/tickets/${id}`,
          "PUT",
          Object.fromEntries(new FormData(form)),
        );
        toast("Report updated");
        await load();
        lucide.createIcons();
      };
    });
    lucide.createIcons();
  };
  status.onchange = category.onchange = load;
  await load();
}

export async function supportPage(content, user, heading) {
  const admin = ["admin", "super-admin"].includes(user.role);
  const { tickets } = await api("/support/tickets/mine");
  content.innerHTML =
    heading(
      "We’re here to help.",
      "Report scams, suspicious messages, bugs, or account problems to the club.",
    ) +
    `<div class="notice mb-4">${icon("shield-alert")} <strong>Stay safe:</strong> CourtSide administrators will never ask for your password, your email verification link, or payment to a personal account. If someone does, don’t respond. Report it here as <em>Scam or fraud</em>.</div>` +
    (admin ? '<div id="support-inbox"></div>' : "") +
    reportForm() +
    `<div id="my-reports">${myReports(tickets)}</div>`;
  if (admin) await mountInbox(content.querySelector("#support-inbox"));
  const form = content.querySelector("#support-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const error = content.querySelector("#support-error");
    error.textContent = "";
    const data = Object.fromEntries(new FormData(form));
    if (!data.page) delete data.page;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const { message } = await api("/support/tickets", "POST", data);
      form.reset();
      toast(message);
      const mine = await api("/support/tickets/mine");
      content.querySelector("#my-reports").innerHTML = myReports(mine.tickets);
    } catch (err) {
      error.innerHTML = `<div class="error-message">${esc(err.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  };
}
