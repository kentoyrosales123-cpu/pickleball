import crypto from "node:crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import { ProfilePhoto, User } from "../models/index.js";
import { ensure, publicUser, HttpError } from "../middleware/security.js";

export async function uploadPhoto(req, res) {
  ensure(
    Buffer.isBuffer(req.body) && req.body.length,
    "Choose a JPEG, PNG, or WebP image.",
  );
  let data;
  try {
    const image = sharp(req.body, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    ensure(
      ["jpeg", "png", "webp"].includes(metadata.format) &&
        (metadata.pages || 1) === 1,
      "Choose a non-animated JPEG, PNG, or WebP image.",
    );
    data = await image
      .rotate()
      .resize(512, 512, { fit: "cover", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      "This image could not be read. Choose a valid image under 25 megapixels.",
    );
  }
  const profileImage = `/api/players/${req.user._id}/photo?v=${crypto.randomUUID()}`;
  let user;
  await mongoose.connection.transaction(async (session) => {
    await ProfilePhoto.updateOne(
      { _id: req.user._id },
      { $set: { data } },
      { upsert: true, session },
    );
    user = await User.findByIdAndUpdate(
      req.user._id,
      { profileImage },
      { session, returnDocument: "after" },
    );
  });
  res.json({ user: publicUser(user) });
}
export async function removePhoto(req, res) {
  let user;
  await mongoose.connection.transaction(async (session) => {
    await ProfilePhoto.deleteOne({ _id: req.user._id }, { session });
    user = await User.findByIdAndUpdate(
      req.user._id,
      { profileImage: "" },
      { session, returnDocument: "after" },
    );
  });
  res.json({ user: publicUser(user) });
}
export async function getPhoto(req, res) {
  ensure(/^[a-f\d]{24}$/i.test(req.params.id), "Photo not found", 404);
  const photo = await ProfilePhoto.findById(req.params.id);
  ensure(photo, "Photo not found", 404);
  res.set("Cache-Control", "private, no-store").type("jpeg").send(photo.data);
}
