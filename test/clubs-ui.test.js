import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  hostTab,
  paymentPanel,
  wirePaymentPanel,
  clubPage,
  meetupForm,
  attendanceHistory,
} from "../public/js/clubs.js";

const player = (id, fullName) => ({
  id,
  fullName,
  username: id,
  provisionalRanking: 3,
});
const state = (user = { id: "owner" }) => ({
  user,
  rankings: Array.from({ length: 12 }, (_, i) => `Level ${i + 1}`),
  eventCard: (e) => `<article>${e.eventName}</article>`,
  render: () => {},
});
function setup(t, routes) {
  const dom = new JSDOM("<main></main>", { url: "http://localhost/" });
  t.after(() => dom.window.close());
  const prev = {
    Swal: globalThis.Swal,
    lucide: globalThis.lucide,
    location: globalThis.location,
    FormData: globalThis.FormData,
  };
  t.after(() => Object.assign(globalThis, prev));
  globalThis.Swal = { fire: async () => ({ isConfirmed: true }) };
  globalThis.lucide = { createIcons: () => {} };
  globalThis.location = dom.window.location;
  globalThis.FormData = dom.window.FormData;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body && JSON.parse(options.body) });
    const handler = routes[`${method} ${url.replace(/\?.*/, "")}`];
    assert.ok(handler, `unexpected ${method} ${url}`);
    return { ok: true, json: async () => handler() };
  });
  return { container: dom.window.document.querySelector("main"), calls };
}
const heading = (title, sub, action = "") => `<h1>${title}</h1>${action}`;

test("host tab shows check-in and payment status and confirms payments", async (t) => {
  const event = {
    _id: "e1",
    eventName: "Night <Dinks>",
    fee: 150,
    waitlistEnabled: true,
    startDateTime: new Date(Date.now() + 3600_000).toISOString(),
  };
  const roster = [
    {
      player: player("p1", "Ana <b>"),
      registrationStatus: "confirmed",
      attendance: "present",
      checkedInAt: new Date().toISOString(),
      paymentStatus: "submitted",
      paymentMethod: "gcash",
      paymentReference: "REF123",
    },
    {
      player: player("p2", "Ben"),
      registrationStatus: "waitlisted",
      waitlistPosition: 1,
      attendance: "pending",
      paymentStatus: "unpaid",
    },
  ];
  const summary = {
    confirmed: 1,
    waitlisted: 1,
    present: 1,
    noShow: 0,
    paid: 0,
    awaitingConfirmation: 1,
    collected: 0,
  };
  const { container, calls } = setup(t, {
    "GET /api/events/e1/roster": () => ({ roster, summary }),
    "PUT /api/events/e1/roster/p1/payment": () => ({}),
    "PUT /api/events/e1/roster/p1/attendance": () => ({}),
  });
  await hostTab(container, state(), event);
  assert.match(container.textContent, /To confirm/);
  assert.match(container.textContent, /GCash · REF123/);
  assert.match(container.textContent, /1 waiting for you to confirm/);
  assert.match(container.textContent, /#1/, "waitlist shown with position");
  assert.equal(container.querySelector("b"), null, "names are escaped");
  assert.equal(
    container
      .querySelector('[data-attend="present"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  await container.querySelector('[data-pay="paid"]').onclick();
  await container.querySelector('[data-attend="no-show"]').onclick();
  assert.deepEqual(
    calls.filter((c) => c.method === "PUT").map((c) => [c.url, c.body]),
    [
      ["/api/events/e1/roster/p1/payment", { paymentStatus: "paid" }],
      ["/api/events/e1/roster/p1/attendance", { attendance: "no-show" }],
    ],
  );
});

test("host tab hides check-in buttons until 2 hours before start", async (t) => {
  const { container } = setup(t, {
    "GET /api/events/e1/roster": () => ({
      roster: [
        {
          player: player("p1", "Ana"),
          registrationStatus: "confirmed",
          attendance: "pending",
          paymentStatus: "unpaid",
        },
      ],
      summary: {
        confirmed: 1,
        waitlisted: 0,
        present: 0,
        noShow: 0,
        paid: 0,
        awaitingConfirmation: 0,
        collected: 0,
      },
    }),
  });
  await hostTab(container, state(), {
    _id: "e1",
    eventName: "Free play",
    fee: 0,
    startDateTime: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  assert.equal(container.querySelector("[data-attend]"), null);
  assert.equal(
    container.querySelector("[data-pay]"),
    null,
    "free events have no payment column",
  );
  assert.match(container.textContent, /Check-in opens 2 hours before/);
});

test("players see payment instructions and submit a reference", async (t) => {
  const { container, calls } = setup(t, {
    "PUT /api/events/e1/payment": () => ({ message: "Payment submitted." }),
  });
  const event = { fee: 200 };
  const club = { paymentInstructions: "GCash 0917 <x>" };
  assert.equal(paymentPanel({ fee: 0 }, club, { paymentStatus: "unpaid" }), "");
  container.innerHTML = paymentPanel(event, club, {
    registrationStatus: "confirmed",
    paymentStatus: "unpaid",
  });
  assert.match(container.textContent, /₱200/);
  assert.match(container.textContent, /GCash 0917 <x>/);
  const s = state();
  wirePaymentPanel(container, "e1", s);
  const form = container.querySelector("#payment-form");
  form.elements.paymentReference.value = "9988";
  await form.onsubmit({
    preventDefault() {},
    submitter: form.querySelector("button"),
  });
  assert.deepEqual(calls[0].body, {
    paymentMethod: "gcash",
    paymentReference: "9988",
  });

  container.innerHTML = paymentPanel(event, club, {
    registrationStatus: "confirmed",
    paymentStatus: "paid",
  });
  assert.equal(container.querySelector("#payment-form"), null);
  assert.match(container.textContent, /confirmed your payment/);
});

test("club page shows join for visitors and host controls for owners", async (t) => {
  const club = (myRole) => ({
    club: {
      id: "c1",
      name: "Davao Dinkers",
      location: "Davao",
      memberCount: 2,
      owner: player("owner", "Olive"),
      myRole,
      description: "",
    },
    canManage: myRole === "owner",
    members: [
      { ...player("owner", "Olive"), role: "owner" },
      { ...player("m1", "Mia"), role: "member" },
    ],
    meetups: [
      {
        _id: "e1",
        eventName: "Upcoming Dinks",
        endDateTime: new Date(Date.now() + 86400_000).toISOString(),
        status: "registration-open",
      },
    ],
  });
  let role = null;
  const { container, calls } = setup(t, {
    "GET /api/clubs/c1": () => club(role),
    "POST /api/clubs/c1/join": () => ({ message: "Welcome" }),
    "PUT /api/clubs/c1/members/m1": () => ({}),
  });
  await clubPage(container, state({ id: "visitor" }), heading, "c1");
  assert.ok(container.querySelector("#join-club"));
  assert.equal(container.querySelector("[data-role]"), null);
  assert.match(container.textContent, /Upcoming Dinks/);
  await container
    .querySelector("#join-club")
    .onclick({ currentTarget: container.querySelector("#join-club") });

  role = "owner";
  await clubPage(container, state(), heading, "c1");
  assert.ok(container.querySelector('a[href="#/clubs/c1/meetups/new"]'));
  assert.equal(
    container.querySelector("#leave-club"),
    null,
    "owners can't leave",
  );
  await container.querySelector('[data-role="host"]').onclick();
  assert.deepEqual(calls.at(-1), {
    url: "/api/clubs/c1/members/m1",
    method: "PUT",
    body: { role: "host" },
  });
});

test("meetup form posts ISO dates, court list and waitlist flag", async (t) => {
  const { container, calls } = setup(t, {
    "GET /api/clubs/c1": () => ({
      club: { name: "Davao Dinkers", location: "Matina" },
      canManage: true,
    }),
    "POST /api/clubs/c1/meetups": () => ({ event: { _id: "new1" } }),
  });
  await meetupForm(container, state(), "c1");
  const form = container.querySelector("#meetup-form");
  assert.equal(form.elements.location.value, "Matina");
  form.elements.eventName.value = "Sunday Social";
  form.elements.courts.value = "A, B , ,C";
  form.elements.waitlistEnabled.checked = false;
  await form.onsubmit({
    preventDefault() {},
    submitter: form.querySelector("button.btn-primary"),
  });
  const body = calls.at(-1).body;
  assert.equal(body.eventName, "Sunday Social");
  assert.deepEqual(body.courts, ["A", "B", "C"]);
  assert.equal(body.waitlistEnabled, false);
  assert.match(body.startDateTime, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(globalThis.location.hash, "#/events/new1");
});

test("attendance history summarises shows and no-shows", async (t) => {
  const { container } = setup(t, {
    "GET /api/players/me/attendance": () => ({
      summary: { attended: 3, noShows: 1, recorded: 4 },
      history: [
        {
          eventId: "e1",
          eventName: "Dinks",
          location: "Matina",
          startDateTime: new Date().toISOString(),
          status: "completed",
          attendance: "no-show",
          paymentStatus: null,
        },
      ],
    }),
  });
  await attendanceHistory(container);
  assert.match(container.textContent, /3 of 4 recorded games \(75%\)/);
  assert.match(container.textContent, /1 no-show/);
  assert.match(container.textContent, /Free/);
});
