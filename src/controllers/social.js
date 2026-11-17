import mongoose from "mongoose";
import { z } from "zod";
import { Friendship, Message, User, pairKey } from "../models/index.js";
import { ensure } from "../middleware/security.js";
import { emitTo, notify, publishTo } from "../services/notifications.js";

export const friendRequestSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
});
export const friendResponseSchema = z.object({ accept: z.boolean() });
export const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

// Fields other players may see. Email and phone stay private.
const card =
  "fullName username profileImage officialRanking provisionalRanking role";
const objectId = (value, message = "Player not found") => {
  ensure(/^[a-f\d]{24}$/i.test(value ?? ""), message, 404);
  return new mongoose.Types.ObjectId(value);
};
const view = (u) => ({
  id: String(u._id),
  fullName: u.fullName,
  username: u.username,
  profileImage: u.profileImage,
  officialRanking: u.officialRanking,
  provisionalRanking: u.provisionalRanking,
  role: u.role,
});
const msgView = (m) => ({
  id: String(m._id),
  from: String(m.from),
  to: String(m.to),
  body: m.body,
  readAt: m.readAt,
  createdAt: m.createdAt,
});
// Relationship of `me` to the other side of a friendship document.
function relation(f, me) {
  if (!f) return { status: "none" };
  if (f.status === "accepted") return { status: "friends", requestId: f._id };
  return {
    status: String(f.requester) === String(me) ? "outgoing" : "incoming",
    requestId: f._id,
  };
}
async function activePlayer(id) {
  const player = await User.findOne({ _id: id, active: true }, card);
  ensure(player, "Player not found", 404);
  return player;
}
const areFriends = async (a, b) =>
  Boolean(
    await Friendship.exists({ pairKey: pairKey(a, b), status: "accepted" }),
  );

export const socialController = {
  search: async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    ensure(q.length >= 2, "Type at least 2 characters to search.");
    ensure(q.length <= 60, "Search is too long.");
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const players = await User.find(
      {
        _id: { $ne: req.user._id },
        active: true,
        $or: [{ fullName: pattern }, { username: pattern }],
      },
      card,
    )
      .sort({ fullName: 1 })
      .limit(20);
    const links = await Friendship.find({
      pairKey: { $in: players.map((p) => pairKey(p._id, req.user._id)) },
    });
    const byKey = new Map(links.map((f) => [f.pairKey, f]));
    res.json({
      players: players.map((p) => ({
        ...view(p),
        ...relation(byKey.get(pairKey(p._id, req.user._id)), req.user._id),
      })),
    });
  },
  friends: async (req, res) => {
    const me = req.user._id;
    const links = await Friendship.find({
      $or: [{ requester: me }, { recipient: me }],
    })
      .sort({ updatedAt: -1 })
      .populate("requester", card)
      .populate("recipient", card);
    const result = { friends: [], incoming: [], outgoing: [] };
    for (const f of links) {
      const mine = String(f.requester._id) === String(me);
      const other = mine ? f.recipient : f.requester;
      const row = {
        ...view(other),
        requestId: String(f._id),
        since: f.acceptedAt || f.createdAt,
      };
      if (f.status === "accepted") result.friends.push(row);
      else (mine ? result.outgoing : result.incoming).push(row);
    }
    result.friends.sort((a, b) => a.fullName.localeCompare(b.fullName));
    res.json(result);
  },
  request: async (req, res) => {
    const me = req.user._id;
    const otherId = objectId(req.body.userId);
    ensure(
      String(otherId) !== String(me),
      "You can’t add yourself as a friend.",
    );
    const other = await activePlayer(otherId);
    const key = pairKey(me, otherId);
    const existing = await Friendship.findOne({ pairKey: key });
    if (existing?.status === "accepted")
      return res.json({
        status: "friends",
        message: "You’re already friends.",
      });
    if (existing && String(existing.requester) === String(me))
      return res.json({
        status: "outgoing",
        message: "Friend request already sent.",
      });
    if (existing) {
      // They already asked us: sending a request back accepts theirs.
      existing.status = "accepted";
      existing.acceptedAt = new Date();
      await existing.save();
      await notify(
        [otherId],
        "Friend request accepted",
        `${req.user.fullName} accepted your friend request.`,
        "friend",
      );
      publishTo([otherId, me]);
      return res.json({
        status: "friends",
        requestId: existing._id,
        message: `You and ${other.fullName} are now friends.`,
      });
    }
    let friendship;
    try {
      friendship = await Friendship.create({
        pairKey: key,
        requester: me,
        recipient: otherId,
      });
    } catch (error) {
      // Two simultaneous requests for the same pair: the unique key wins.
      if (error.code === 11000)
        return res.status(409).json({
          message: "A friend request already exists. Refresh and try again.",
        });
      throw error;
    }
    await notify(
      [otherId],
      "New friend request",
      `${req.user.fullName} (@${req.user.username}) wants to be friends.`,
      "friend",
    );
    publishTo([otherId]);
    res.status(201).json({
      status: "outgoing",
      requestId: friendship._id,
      message: `Friend request sent to ${other.fullName}.`,
    });
  },
  respond: async (req, res) => {
    const id = objectId(req.params.id, "Friend request not found");
    const f = await Friendship.findOne({
      _id: id,
      recipient: req.user._id,
      status: "pending",
    });
    ensure(f, "Friend request not found", 404);
    if (!req.body.accept) {
      await f.deleteOne();
      return res.json({ status: "none", message: "Friend request declined." });
    }
    f.status = "accepted";
    f.acceptedAt = new Date();
    await f.save();
    await notify(
      [f.requester],
      "Friend request accepted",
      `${req.user.fullName} accepted your friend request.`,
      "friend",
    );
    publishTo([f.requester]);
    res.json({ status: "friends", message: "Friend request accepted." });
  },
  // Cancels an outgoing request or removes an existing friend.
  remove: async (req, res) => {
    const otherId = objectId(req.params.userId);
    const f = await Friendship.findOneAndDelete({
      pairKey: pairKey(req.user._id, otherId),
    });
    ensure(f, "You aren’t connected with this player.", 404);
    publishTo([otherId]);
    res.json({
      status: "none",
      message:
        f.status === "accepted"
          ? "Friend removed."
          : "Friend request cancelled.",
    });
  },
  conversations: async (req, res) => {
    const me = req.user._id;
    const [links, latest, unread] = await Promise.all([
      Friendship.find({
        status: "accepted",
        $or: [{ requester: me }, { recipient: me }],
      }),
      Message.aggregate([
        { $match: { $or: [{ from: me }, { to: me }] } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$pairKey", last: { $first: "$$ROOT" } } },
        { $sort: { "last.createdAt": -1 } },
        { $limit: 200 },
      ]),
      Message.aggregate([
        { $match: { to: me, readAt: null } },
        { $group: { _id: "$from", count: { $sum: 1 } } },
      ]),
    ]);
    const other = (a, b) => (String(a) === String(me) ? b : a);
    const friendIds = new Set(
      links.map((f) => String(other(f.requester, f.recipient))),
    );
    const lastByPlayer = new Map(
      latest.map((c) => [String(other(c.last.from, c.last.to)), c.last]),
    );
    const unreadBy = new Map(unread.map((u) => [String(u._id), u.count]));
    const ids = [...new Set([...friendIds, ...lastByPlayer.keys()])];
    const players = await User.find({ _id: { $in: ids } }, `${card} active`);
    const conversations = players
      .map((p) => {
        const last = lastByPlayer.get(String(p._id));
        return {
          player: view(p),
          friends: friendIds.has(String(p._id)) && p.active,
          lastMessage: last ? msgView(last) : null,
          unread: unreadBy.get(String(p._id)) || 0,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.lastMessage?.createdAt || 0) -
            new Date(a.lastMessage?.createdAt || 0) ||
          a.player.fullName.localeCompare(b.player.fullName),
      );
    res.json({ conversations });
  },
  unread: async (req, res) =>
    res.json({
      count: await Message.countDocuments({ to: req.user._id, readAt: null }),
    }),
  thread: async (req, res) => {
    const me = req.user._id;
    const otherId = objectId(req.params.userId);
    const player = await User.findById(otherId, `${card} active`);
    ensure(player, "Player not found", 404);
    const key = pairKey(me, otherId);
    const filter = { pairKey: key };
    // `before` is the id of the oldest message the client already has.
    if (req.query.before)
      filter._id = { $lt: objectId(req.query.before, "Message not found") };
    const rows = await Message.find(filter).sort({ _id: -1 }).limit(51);
    const hasMore = rows.length > 50;
    const messages = rows.slice(0, 50).reverse();
    const now = new Date();
    const marked = await Message.updateMany(
      { pairKey: key, to: me, readAt: null },
      { readAt: now },
    );
    if (marked.modifiedCount)
      emitTo([otherId], "message:read", { by: String(me), at: now });
    res.json({
      player: view(player),
      friends: player.active && (await areFriends(me, otherId)),
      messages: messages.map(msgView),
      hasMore,
    });
  },
  send: async (req, res) => {
    const me = req.user._id;
    const otherId = objectId(req.params.userId);
    ensure(String(otherId) !== String(me), "You can’t message yourself.");
    await activePlayer(otherId);
    ensure(
      await areFriends(me, otherId),
      "You can only message players on your friends list.",
      403,
    );
    const message = await Message.create({
      pairKey: pairKey(me, otherId),
      from: me,
      to: otherId,
      body: req.body.body,
    });
    const payload = {
      ...msgView(message),
      sender: { fullName: req.user.fullName },
    };
    emitTo([me, otherId], "message", payload);
    res.status(201).json({ message: msgView(message) });
  },
  markRead: async (req, res) => {
    const me = req.user._id;
    const otherId = objectId(req.params.userId);
    const now = new Date();
    const marked = await Message.updateMany(
      { pairKey: pairKey(me, otherId), to: me, readAt: null },
      { readAt: now },
    );
    if (marked.modifiedCount)
      emitTo([otherId], "message:read", { by: String(me), at: now });
    res.json({ ok: true });
  },
};
