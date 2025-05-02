// routes/spotRoutes.js
import express from "express";
import pool from "../index.js";
import multer from "multer";
import slugify from "slugify";
import QRCode from "qrcode";
import { authenticate, isAdmin } from "../middlewares/auth_check.js";
import { cloudinary } from "../cloudinary.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();


const router = express.Router();
const upload = multer({ dest: "temp/" }); // Save temporarily for Cloudinary

// ======================= QR Scanner Page =======================
router.get('', (req, res) => {
  if (req.query.url) {
    return res.redirect(req.query.url);
  }
  res.render('scan-qr');
});

// ======================= Get Spot HTML =======================
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const result = await pool.query("SELECT * FROM spots WHERE slug = $1", [slug]);
    if (result.rows.length === 0) {
      return res.render('messages/error-404', { error: "Spot not found" });
    }

    const spot = result.rows[0];
    await pool.query("UPDATE spots SET visit = visit + 1 WHERE slug = $1", [slug]);

    res.render("view-spot", { spot });
  } catch (err) {
    console.error("Error in /:slug route:", err.message);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

// ======================= Create New Spot =======================
router.post("/create", authenticate, isAdmin, upload.fields([
  { name: "imageFile", maxCount: 1 },
  { name: "voiceFile", maxCount: 1 }
]), async (req, res) => {
  try {
    console.log("Received request body:", req.body);
    console.log("Files uploaded:", req.files);

    const { title, category, desc, nfc_id } = req.body;
    const userId = req.user?.id;

    if (!userId || !title || !desc || !category) {
      console.error("❌ Missing required fields:", { userId, title, category, desc });
      return res.render('messages/error-400', { error: "Title, category, description, and user ID are required." });
    }

    if (!req.files.imageFile || !req.files.voiceFile) {
      console.error("❌ Image or audio file missing.", req.files);
      return res.render('messages/error-400', { error: "Both image and audio files are required." });
    }

    // Normalize the paths
    const imagePath = path.normalize(req.files.imageFile[0].path);
    const audioPath = path.normalize(req.files.voiceFile[0].path);

    // Check if files exist
    if (!fs.existsSync(imagePath)) {
      console.error("❌ Image file does not exist at path:", imagePath);
      return res.render('messages/error-400', { error: "Image file not found" });
    }

    if (!fs.existsSync(audioPath)) {
      console.error("❌ Audio file does not exist at path:", audioPath);
      return res.render('messages/error-400', { error: "Audio file not found" });
    }

    // Upload to Cloudinary
    const imageUpload = await cloudinary.uploader.upload(imagePath, {
      folder: "spot_images",
    });
    console.log("Image uploaded to Cloudinary:", imageUpload.secure_url);

    const audioUpload = await cloudinary.uploader.upload(audioPath, {
      folder: "spot_audios",
      resource_type: "video", // Cloudinary treats audio as 'video'
    });
    console.log("Audio uploaded to Cloudinary:", audioUpload.secure_url);

    // Delete temp files
    fs.unlinkSync(imagePath);
    fs.unlinkSync(audioPath);
    console.log("Temporary files deleted.");

    const slug = slugify(title, { lower: true }) + "-" + Date.now();
    console.log("Generated slug:", slug);

    // Insert into the database
    const result = await pool.query(
      `INSERT INTO spots (user_id, title, category, description, image, audio, slug, nfc_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [userId, title, category, desc, imageUpload.secure_url, audioUpload.secure_url, slug, nfc_id || null]
    );
    console.log("Database insert result:", result.rows[0]);

    res.redirect(`/spot/qr/${slug}`);
  } catch (err) {
    console.error("Error in /create route:", err.message);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

// ======================= QR Code Page =======================
router.get("/qr/:slug", authenticate, isAdmin, async (req, res) => {
  const { slug } = req.params;
  const url = `${process.env.BASE_URL}/spot/${slug}`;
  try {
    const qrImage = await QRCode.toDataURL(url);
    res.render('admin/qr-page', { user: req.user, qr_image: qrImage });
  } catch (err) {
    console.error("Error generating QR code:", err.message);
    res.status(500).render('messages/error-500', { error: "Error generating QR" });
  }
});



export default router;
