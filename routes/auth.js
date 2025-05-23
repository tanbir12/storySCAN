import express from "express";
import passport from "passport";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../index.js";
import { sendMail } from "./mailSender.js";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { authenticate, isAdmin, isSuperAdmin } from "../middlewares/auth_check.js";
import dotenv from "dotenv";
import multer from "multer";
import { storage, cloudinary } from "../cloudinary.js";  // << added cloudinary
import fs from "fs";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set");
}
const router = express.Router();
router.get("/", (req, res) => res.render("index"));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALL_BACK_URL,

}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (user.rows.length === 0) {
      user = await pool.query(
        "INSERT INTO users (email, name, google_id, picture) VALUES ($1, $2, $3, $4) RETURNING *",
        [email, profile.displayName, profile.id, profile._json.picture]
      );
    }
    return done(null, user.rows[0]);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  done(null, result.rows[0]);
});

// Google OAuth Routes
router.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
router.get("/auth/google/callback", passport.authenticate("google", { failureRedirect: "/login" }), (req, res) => {
  const token = jwt.sign({ id: req.user.id }, JWT_SECRET);
  res.cookie("jwtToken", token, { httpOnly: true,  maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.redirect(req.user.is_admin ? "/admin/dashboard" : "/user/dashboard");
});

// Email Register/Login
router.get("/register", async (req, res) => { res.render('user/register'); });
router.post("/register", async (req, res) => {
  const { email, password, fullName } = req.body;
  const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (user.rows.length === 0) {
    const hashed = await bcrypt.hash(password, 10);
    try {
      const result = await pool.query(
        "INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING *",
        [email, hashed, fullName]
      );
      res.render('messages/success', { message: 'Registration successful', user: result.rows[0] });
    } catch (e) {
      res.status(400).render('messages/error-404', { error: "Email already exists" });
    }
  }
  else res.render('messages/error-404', { error: "Email Already Exist." });
});

// Login Routes
router.get("/login", async (req, res) => { res.render('user/login.ejs'); });
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (user.rows.length === 0) return res.render('messages/error-404', { error: "Invalid credentials" });
  if (!user.rows[0].password) return res.render('messages/error-404', { error: "Kindly Login Through Google.." });
  const match = await bcrypt.compare(password, user.rows[0].password);
  if (!match) return res.render('messages/error-404', { error: "Invalid credentials" });

  const token = jwt.sign({ id: user.rows[0].id }, JWT_SECRET);
  res.cookie("jwtToken", token, { httpOnly: true,  maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.redirect(user.rows[0].is_admin ? "/admin/dashboard" : "/user/dashboard");
});

// Logout Route
router.post("/logout", (req, res) => {
  res.clearCookie("jwtToken");
  res.redirect("/");
});

// Getting picture of user from Google
router.get("/user/photo", authenticate, async (req, res) => {
  const imageUrl = req.user.picture;
  const response = await fetch(imageUrl);
  const buffer = await response.arrayBuffer();
  res.set("Content-Type", "image/jpeg");
  res.send(Buffer.from(buffer));
});

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<            ADMIN SECTION          >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

router.get("/admin/dashboard", authenticate, isAdmin, (req, res) => {
  res.render("admin/admindashboard", { user: req.user });
});

router.get("/admin/dashboard/spots", authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM spots WHERE user_id = $1  ORDER BY id DESC", [req.user.id]);
    const spots = result.rows;
    res.render("admin/all-spots", { spots, user: req.user });
  } catch (err) {
    console.error("Error fetching spots data:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

router.get("/admin/dashboard/update/:id", authenticate, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM spots WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.render('messages/error-404', { error: "Spot not found" });
    }
    const spot = result.rows[0];
    res.render("admin/update-spots", { spot, user: req.user });
  } catch (err) {
    console.error("Error fetching spot data:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

const upload = multer({ dest: "temp/" }); // Save temporarily for Cloudinary

router.post("/admin/dashboard/update", authenticate, isAdmin, upload.fields([
  { name: "imageFile", maxCount: 1 },
  { name: "voiceFile", maxCount: 1 }
]), async (req, res) => {
  const { id, title, category, desc, nfc_id } = req.body;

  try {
    const result = await pool.query("SELECT * FROM spots WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.render('messages/error-404', { error: "Spot not found" });
    }

    if (req.user.id != result.rows[0].user_id && !req.user.is_superadmin) {
      // checks for the user id of the spot and the user id of the logged in user  
      return res.render('messages/error-403', { error: "You are not authorized to update this spot" });
    }

    const spot = result.rows[0];
    const fields = [];
    const values = [];
    let idx = 1;

    if (title && title !== spot.title) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (category && category !== spot.category) {
      fields.push(`category = $${idx++}`);
      values.push(category);
    }
    if (desc && desc !== spot.description) {
      fields.push(`description = $${idx++}`);
      values.push(desc);
    }
    if (nfc_id && nfc_id !== spot.nfc_id) {
      fields.push(`nfc_id = $${idx++}`);
      values.push(nfc_id);
    }

    if (req.files) {
      const { imageFile, voiceFile } = req.files;
      if (imageFile) {
        const imageUpload = await cloudinary.uploader.upload(imageFile[0].path, {
          folder: "images",
        });
        fields.push(`image = $${idx++}`);
        values.push(imageUpload.secure_url);
        // Delete temp image file
        fs.unlinkSync(imageFile[0].path);
      }
      if (voiceFile) {
        const voiceUpload = await cloudinary.uploader.upload(voiceFile[0].path, {
          folder: "audio",
          resource_type: "video",
        });
        fields.push(`audio = $${idx++}`);
        values.push(voiceUpload.secure_url);
        // Delete temp voice file
        fs.unlinkSync(voiceFile[0].path);
      }
    }

    if (fields.length === 0) {
      return res.redirect("/admin/dashboard/spots");
    }

    values.push(id);
    const query = `UPDATE spots SET ${fields.join(", ")} WHERE id = $${idx}`;
    await pool.query(query, values);

    res.redirect("/admin/dashboard/spots");
  } catch (err) {
    console.error("Error updating spot:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

router.post("/admin/dashboard/delete/:id", authenticate, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM spots WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.render('messages/error-404', { error: "Spot not found" });
    }
    if (req.user.id !== result.rows[0].user_id && !req.user.is_superadmin) {
      // checks for the user id of the spot and the user id of the logged in user  
      return res.render('messages/error-403', { error: "You are not authorized to delete this spot" });
    }
    await pool.query("DELETE FROM spots WHERE id = $1", [id]);
    res.json({ success: true, message: "Spot successfully deleted" });
  } catch (err) {
    console.error("Error deleting spot:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<            USER SECTION          >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

router.get("/user/dashboard", authenticate, (req, res) => {
  res.render("user/userdashboard", { user: req.user });
});

router.get("/user/request-admin", authenticate, (req, res) => {
  res.render('user/request-admin', { user: req.user });
});

router.post("/user/admin-request", authenticate, async (req, res) => {
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: "Reason is required" });
  }

  try {
    const existing = await pool.query(
      "SELECT * FROM admin_requests WHERE user_id = $1",
      [req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).render('messages/success', { message: "Your Request Already Sent" });
    }

    await pool.query(
      "INSERT INTO admin_requests (user_id, reason, status) VALUES ($1, $2, $3)",
      [req.user.id, reason, "pending"]
    );

    res.render('messages/success', { message: "Your Request Sent Successfully" });
  } catch (err) {
    console.error(err.message);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});




// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<            SUPER ADMIN SECTION          >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

router.get("/superadmin/dashboard", authenticate, isSuperAdmin, (req, res) => {
  res.render("super-admin/super-admindashboard", { user: req.user });
});

// View all admin requests
router.get("/super-admin/dashboard/admin-requests", authenticate, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ar.id, ar.reason, ar.status, u.name, u.email 
      FROM admin_requests ar 
      JOIN users u ON ar.user_id = u.id 
      ORDER BY ar.id DESC
    `);
    const requests = result.rows;
    res.render("super-admin/adminRequests", { requests, user: req.user });
  } catch (err) {
    console.error("Error fetching admin requests:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

router.get("/super-admin/dashboard/spots", authenticate, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM spots  ORDER BY id DESC");
    const spots = result.rows;
    res.render("admin/all-spots", { spots, user: req.user });
  } catch (err) {
    console.error("Error fetching spots data:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

// Approve or reject an admin request
router.post("/admin-requests/:id/:name/:email/approve", authenticate, isSuperAdmin, async (req, res) => {
  const requestId = req.params.id;

  // Update users table
  const result = await pool.query(`
    UPDATE users
    SET is_admin = true
    WHERE id = (SELECT user_id FROM admin_requests WHERE id = $1)
    RETURNING id
  `, [requestId]);

  sendMail(
    req.params.email,
    "Admin Request Approved",
    `Dear ${req.params.name},

We are pleased to inform you that your request to become an admin has been approved.

Congratulations! You now have administrative access to the platform. With this role, you can manage content, upload spots, and contribute to enhancing the experience for all users.

If you have any questions or need assistance getting started, feel free to reach out to our support team.

Welcome aboard!

Best regards,
The storySCAN Team`
  );

  if (result.rows.length > 0) {
    await pool.query(`UPDATE admin_requests SET status = 'approved' WHERE id = $1`, [requestId]);
  }

  res.redirect("/super-admin/dashboard/admin-requests");
});




router.post("/admin-requests/:id/:name/:email/reject", authenticate, isAdmin, async (req, res) => {
  const requestId = req.params.id;

  await pool.query(`UPDATE users SET is_admin = false WHERE id = (SELECT user_id FROM admin_requests WHERE id = $1)`, [requestId]);

  await pool.query(`DELETE FROM admin_requests WHERE id = $1`, [requestId]);

  // Send email to user about rejection
  sendMail(
    req.params.email,
    "Admin Request Rejected",
    `Dear ${req.params.name},

Thank you for your interest in becoming an admin on our platform.

After careful consideration, we regret to inform you that your request has not been approved at this time. This decision was based on our current requirements and review criteria.

We appreciate your enthusiasm and encourage you to continue contributing as a valued user. You are welcome to reapply in the future as opportunities arise.

If you have any questions or would like feedback on your application, please feel free to contact us.

Warm regards,
The storySCAN Team`
  );

  res.redirect("/super-admin/dashboard/admin-requests");
});


const contactFormUpload = multer().none();

router.get("/messages/success", (req, res) => {
  res.render('messages/success', { message: "Your message has been sent successfully." });
});

router.post("/forms/contact-details", contactFormUpload, async (req, res) => {
  console.log("Contact form POST received with body:", req.body);
  const { userName, email, subject, message } = req.body;

  if (!userName || !email || !subject || !message) {
    return res.status(400).render('messages/error-404', { error: "All fields are required" });
  }

  const mailSubject = `Contact Form: ${subject}`;
  const mailText = `You have received a new message from the contact form on your website.\n\n` +
    `Name: ${userName}\n` +
    `Email: ${email}\n` +
    `Subject: ${subject}\n` +
    `Message:\n${message}`;

  try {
    await sendMail('pradhantanbir@gmail.com', mailSubject, mailText);
    res.redirect('/messages/success');
  } catch (error) {
    console.error("Error sending contact form email:", error);
    res.status(500).render('messages/error-500', { error: "Failed to send message. Please try again later." });
  }
});


// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<           DEVICE SECTION          >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

import axios from "axios";
import archiver from "archiver";

router.get("/admin/dashboard/download-audios", authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT audio, nfc_id FROM spots WHERE user_id = $1 AND nfc_id IS NOT NULL", [req.user.id]);
    const spots = result.rows;

    if (spots.length === 0) {
      return res.status(404).render('messages/error-404', { error: "No spots found for this admin" });
    }

    res.attachment("audio_files.zip");
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      throw err;
    });

    archive.pipe(res);

    for (const spot of spots) {
      if (spot.audio) {
        try {
          const response = await axios.get(spot.audio, { responseType: "arraybuffer" });
          archive.append(Buffer.from(response.data), { name: `${spot.nfc_id}.mp3` });
        } catch (err) {
          console.error(`Failed to download audio for spot ${spot.nfc_id}:`, err.message);
        }
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error in download-audios route:", err);
    res.status(500).render('messages/error-500', { error: "Server error" });
  }
});

export default router;
