import express from "express";
import session from "express-session";
import passport from "passport";
import pg from "pg";
import dotenv from "dotenv";
import GoogleStrategy from "passport-google-oauth20";
import authRoutes from "./routes/auth.js";
import spotRoutes from "./routes/spots.js";
import path from "path";
import cookieParser from "cookie-parser";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


// DB Connection
const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,

    ssl: {
        require: true,
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 10000
 });
export default pool;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: "zoo-guide-secret", resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(cookieParser());
app.set('view engine', 'ejs');
// app.use(express.static(path.join(__dirname, "public")));

app.use('/LandingAssets', express.static(path.join(__dirname, 'public', 'Landing')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'Dashboard')));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


// Routes
app.use("", authRoutes);
app.use("/spot", spotRoutes);





app.listen(PORT, () => console.log(`Server running on port ${PORT}`));