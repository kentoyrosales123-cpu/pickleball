import mongoose from "mongoose";
import { User, Migration } from "../models/index.js";
import { lockRatings } from "../services/ratings.js";
import { audit } from "../services/notifications.js";
export async function migrateSuperAdmin() {
  return mongoose.connection.transaction(async (session) => {
    await lockRatings(session);
    if (await Migration.exists({ key: "003-super-admin" }).session(session))
      return { alreadyApplied: true };
    let promoted = null;
    if (
      !(await User.exists({ role: "super-admin", active: true }).session(
        session,
      ))
    ) {
      const user = await User.findOne({ role: "admin", active: true })
        .sort({ createdAt: 1, _id: 1 })
        .session(session);
      if (user) {
        user.role = "super-admin";
        await user.save({ session });
        promoted = String(user._id);
        await audit(
          user._id,
          "migrate-super-admin",
          "User",
          user._id,
          { role: "admin" },
          { role: "super-admin" },
          session,
        );
      }
    }
    await Migration.create(
      [{ key: "003-super-admin", appliedAt: new Date() }],
      { session },
    );
    return { promoted };
  });
}
