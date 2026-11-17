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
} from "./api.js";

const rankOf = (state, p) =>
  state.rankings[(p.officialRanking || p.provisionalRanking) - 1] || "Unranked";
const who = (state, p) =>
  `<span class="player-name">${avatar(p)}<span><strong>${esc(p.fullName)}</strong><br><small class="subtle">@${esc(p.username)} · ${esc(rankOf(state, p))}</small></span></span>`;

function actions(p) {
  const id = esc(p.id);
  switch (p.status) {
    case "friends":
      return `<a class="btn btn-primary btn-sm" href="#/messages/${id}">${icon("message-circle")} Message</a><button class="btn btn-secondary btn-sm" data-remove="${id}" data-name="${esc(p.fullName)}" data-friend="1">Remove</button>`;
    case "incoming":
      return `<button class="btn btn-primary btn-sm" data-respond="${esc(p.requestId)}" data-accept="1">${icon("user-check")} Accept</button><button class="btn btn-secondary btn-sm" data-respond="${esc(p.requestId)}" data-accept="0">Decline</button>`;
    case "outgoing":
      return `<span class="badge">Request sent</span><button class="btn btn-secondary btn-sm" data-remove="${id}" data-name="${esc(p.fullName)}">Cancel</button>`;
    default:
      return `<button class="btn btn-primary btn-sm" data-add="${id}">${icon("user-plus")} Add friend</button>`;
  }
}
const row = (state, p) =>
  `<div class="social-row">${who(state, p)}<div class="social-actions">${actions(p)}</div></div>`;

// Wires Add / Accept / Decline / Cancel / Remove buttons inside `root`.
function wire(root, after) {
  root.querySelectorAll("[data-add]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const { message } = await api("/friends/requests", "POST", {
          userId: b.dataset.add,
        });
        toast(message);
      } finally {
        await after();
      }
    };
  });
  root.querySelectorAll("[data-respond]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const { message } = await api(
          `/friends/requests/${b.dataset.respond}`,
          "PUT",
          {
            accept: b.dataset.accept === "1",
          },
        );
        toast(message);
      } finally {
        await after();
      }
    };
  });
  root.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = async () => {
      const friend = b.dataset.friend === "1";
      if (
        friend &&
        !(await confirm(
          `Remove ${b.dataset.name}?`,
          "You won’t be able to message each other until one of you sends a new friend request.",
        ))
      )
        return;
      b.disabled = true;
      try {
        const { message } = await api(`/friends/${b.dataset.remove}`, "DELETE");
        toast(message);
      } finally {
        await after();
      }
    };
  });
}

export async function friendsPage(content, state, heading) {
  content.innerHTML =
    heading(
      "Friends",
      "Find players from the club, add them as friends, and message them.",
    ) +
    `<section class="panel mb-4"><div class="panel-header"><div><h3>Find players</h3><p>Search by name or username.</p></div>${icon("search")}</div><form id="player-search" role="search"><div class="d-flex gap-2"><input class="form-control" id="player-q" name="q" type="search" minlength="2" maxlength="60" placeholder="e.g. Maria or @maria" aria-label="Search players" autocomplete="off"><button class="btn btn-primary" type="submit">Search</button></div></form><div id="search-results" class="mt-3"></div></section><div id="friend-lists"></div>`;
  const results = content.querySelector("#search-results");
  const lists = content.querySelector("#friend-lists");
  const input = content.querySelector("#player-q");
  let lastQuery = "";

  const search = async () => {
    const q = input.value.trim().replace(/^@/, "");
    lastQuery = q;
    if (q.length < 2) {
      results.innerHTML = "";
      return;
    }
    try {
      const { players } = await api(
        `/players/search?q=${encodeURIComponent(q)}`,
      );
      if (q !== lastQuery) return; // a newer search is in flight
      results.innerHTML = players.length
        ? players.map((p) => row(state, p)).join("")
        : `<p class="subtle mb-0">No players match “${esc(q)}”.</p>`;
      wire(results, refresh);
      lucide.createIcons();
    } catch (err) {
      results.innerHTML = `<div class="error-message">${esc(err.message)}</div>`;
    }
  };
  const loadLists = async () => {
    const { friends, incoming, outgoing } = await api("/friends");
    const block = (title, sub, items, status) =>
      `<section class="panel mb-4"><div class="panel-header"><div><h3>${title}</h3><p>${sub}</p></div></div>${
        items.length
          ? items.map((p) => row(state, { ...p, status })).join("")
          : empty(
              status === "friends" ? "No friends yet" : "Nothing here",
              status === "friends"
                ? "Search for players above to send your first request."
                : "",
            )
      }</section>`;
    lists.innerHTML =
      (incoming.length
        ? block(
            `Friend requests <span class="badge orange">${incoming.length}</span>`,
            "Players who want to connect with you.",
            incoming,
            "incoming",
          )
        : "") +
      block(
        `Your friends <span class="badge">${friends.length}</span>`,
        "Message a friend or remove them from your list.",
        friends,
        "friends",
      ) +
      (outgoing.length
        ? block(
            "Sent requests",
            "Waiting for these players to respond.",
            outgoing,
            "outgoing",
          )
        : "");
    wire(lists, refresh);
    lucide.createIcons();
  };
  const refresh = async () => {
    await Promise.all([loadLists(), lastQuery.length >= 2 ? search() : null]);
  };

  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 300);
  };
  content.querySelector("#player-search").onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(timer);
    search();
  };
  state.refreshFriends = refresh;
  await loadLists();
  return () => {
    clearTimeout(timer);
    state.refreshFriends = null;
  };
}

const bubble = (m, me) =>
  `<div class="chat-msg ${m.from === me ? "mine" : "theirs"}" data-id="${esc(m.id)}"><div class="chat-bubble">${esc(m.body)}</div><small class="subtle">${time(m.createdAt)}</small></div>`;
const dayLabel = (d) => {
  const day = new Date(d).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 864e5).toDateString()) return "Yesterday";
  return date(d);
};
function renderMessages(messages, me) {
  let lastDay = "";
  return messages
    .map((m) => {
      const day = new Date(m.createdAt).toDateString();
      const sep =
        day !== lastDay
          ? `<div class="chat-day">${dayLabel(m.createdAt)}</div>`
          : "";
      lastDay = day;
      return sep + bubble(m, me);
    })
    .join("");
}

export async function messagesPage(content, state, heading, userId) {
  const me = state.user.id;
  content.innerHTML =
    heading("Messages", "Chat with your friends from the club.") +
    `<div class="chat ${userId ? "has-thread" : ""}"><aside class="chat-list panel" aria-label="Conversations"><div id="conversations"><div class="loading">Loading…</div></div></aside><section class="chat-thread panel" id="thread" aria-live="polite"></section></div>`;
  const listEl = content.querySelector("#conversations");
  const threadEl = content.querySelector("#thread");
  let thread = null; // { player, friends, messages, hasMore }

  const loadConversations = async () => {
    const { conversations } = await api("/messages");
    listEl.innerHTML = conversations.length
      ? conversations
          .map(
            (c) =>
              `<a class="chat-convo ${c.player.id === userId ? "active" : ""}" href="#/messages/${esc(c.player.id)}">${avatar(c.player)}<span class="chat-convo-text"><strong>${esc(c.player.fullName)}</strong><small class="subtle">${
                c.lastMessage
                  ? `${c.lastMessage.from === me ? "You: " : ""}${esc(c.lastMessage.body.slice(0, 60))}`
                  : "Say hello 👋"
              }</small></span>${c.unread ? `<span class="badge orange" aria-label="${c.unread} unread">${c.unread}</span>` : ""}</a>`,
          )
          .join("")
      : empty("No conversations yet", "Add friends to start chatting.") +
        `<a class="btn btn-primary btn-sm mt-3" href="#/friends">${icon("user-plus")} Find friends</a>`;
    lucide.createIcons();
  };

  const scrollToEnd = () => {
    const box = threadEl.querySelector(".chat-messages");
    if (box) box.scrollTop = box.scrollHeight;
  };
  const seenMarker = () => {
    const mine = thread.messages.filter((m) => m.from === me);
    const last = mine.at(-1);
    threadEl.querySelectorAll(".chat-seen").forEach((n) => n.remove());
    if (last?.readAt && thread.messages.at(-1) === last)
      threadEl
        .querySelector(`.chat-msg[data-id="${CSS.escape(last.id)}"]`)
        ?.insertAdjacentHTML(
          "beforeend",
          '<small class="chat-seen subtle">Seen</small>',
        );
  };
  const paint = () => {
    const box = threadEl.querySelector(".chat-messages");
    box.innerHTML =
      (thread.hasMore
        ? '<button class="btn btn-secondary btn-sm chat-older" id="older">Load earlier messages</button>'
        : "") +
      (thread.messages.length
        ? renderMessages(thread.messages, me)
        : `<p class="subtle text-center my-4">No messages yet. Say hello to ${esc(thread.player.fullName)}!</p>`);
    seenMarker();
    const older = box.querySelector("#older");
    if (older)
      older.onclick = async () => {
        older.disabled = true;
        const prevHeight = box.scrollHeight;
        const more = await api(
          `/messages/${userId}?before=${encodeURIComponent(thread.messages[0].id)}`,
        );
        thread.messages = [...more.messages, ...thread.messages];
        thread.hasMore = more.hasMore;
        paint();
        box.scrollTop = box.scrollHeight - prevHeight;
      };
  };

  const openThread = async () => {
    if (!userId) {
      threadEl.innerHTML = empty(
        "Pick a conversation",
        "Choose a friend on the left to start chatting.",
      );
      return;
    }
    thread = await api(`/messages/${userId}`);
    const p = thread.player;
    threadEl.innerHTML = `<header class="chat-head"><a class="icon-button chat-back" href="#/messages" aria-label="Back to conversations">${icon("arrow-left")}</a>${avatar(p)}<div class="flex-grow-1"><strong>${esc(p.fullName)}</strong><br><small class="subtle">@${esc(p.username)} · ${esc(rankOf(state, p))}</small></div><a class="icon-button" href="#/support" title="Report a problem with this conversation" aria-label="Report a problem">${icon("flag")}</a></header><div class="chat-messages"></div>${
      thread.friends
        ? `<form class="chat-compose" id="compose"><label class="visually-hidden" for="chat-body">Message ${esc(p.fullName)}</label><textarea class="form-control" id="chat-body" name="body" rows="1" maxlength="2000" placeholder="Write a message…" required></textarea><button class="btn btn-primary" type="submit" aria-label="Send">${icon("send")}</button></form><div id="chat-error" role="alert"></div>`
        : `<div class="notice m-3">You can only message players on your friends list. <a href="#/friends">Add ${esc(p.fullName)} as a friend</a> to continue the conversation.</div>`
    }`;
    paint();
    scrollToEnd();
    const form = threadEl.querySelector("#compose");
    if (!form) return;
    const box = form.querySelector("textarea");
    const send = async () => {
      const body = box.value.trim();
      if (!body) return;
      const button = form.querySelector("button");
      button.disabled = true;
      threadEl.querySelector("#chat-error").innerHTML = "";
      try {
        const { message } = await api(`/messages/${userId}`, "POST", { body });
        addMessage(message);
        box.value = "";
        box.style.height = "";
      } catch (err) {
        threadEl.querySelector("#chat-error").innerHTML =
          `<div class="error-message mx-3 mb-3">${esc(err.message)}</div>`;
      } finally {
        button.disabled = false;
        box.focus();
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      send();
    };
    box.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    };
    box.oninput = () => {
      box.style.height = "";
      box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
    };
    box.focus();
  };

  const addMessage = (m) => {
    if (!thread || thread.messages.some((x) => x.id === m.id)) return;
    thread.messages.push(m);
    paint();
    scrollToEnd();
  };

  // Called by the socket handler in app.js. Returns true when the message
  // was shown in the open thread (so no toast is needed).
  state.onMessage = (m) => {
    const inThread = userId && (m.from === userId || m.to === userId);
    if (inThread) {
      addMessage(m);
    }
    const read =
      inThread && m.from === userId
        ? api(`/messages/${userId}/read`, "PUT", {})
        : Promise.resolve();
    read
      .then(loadConversations)
      .then(() => state.refreshUnread?.())
      .catch(() => {});
    return inThread && document.visibilityState === "visible";
  };
  state.onMessageRead = ({ by, at }) => {
    if (!thread || by !== userId) return;
    for (const m of thread.messages)
      if (m.from === me && !m.readAt) m.readAt = at;
    seenMarker();
  };

  await openThread(); // marks the thread read before counting unread below
  await loadConversations();
  state.refreshUnread?.();
  lucide.createIcons();
  return () => {
    state.onMessage = null;
    state.onMessageRead = null;
  };
}
