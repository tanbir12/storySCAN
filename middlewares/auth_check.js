import jwt from "jsonwebtoken";
import pool from "../index.js";
import dotenv from "dotenv";
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set");
}

// Middleware to check if user is logged in via cookies
export const authenticate = async (req, res, next) => {
    const token = req.cookies.jwtToken; // Retrieve token from cookies
    if (!token) return res.redirect("/login"); // Redirect to login if no token
  
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);
      if (user.rows.length === 0) return res.redirect("/login");
      
      req.user = user.rows[0];
      next();
    } catch (err) {
      res.clearCookie("jwtToken"); // Clear invalid token
      res.redirect("/login");
    }
  };
  
  // Middleware to check if user is an admin
export const isAdmin = (req, res, next) => {
    if (!req.user.is_admin) return res.render('messages/error-403');
    next();
  };

export const isSuperAdmin = (req, res, next) => {
    if (!req.user.is_superadmin) return res.render('messages/error-403');
    next();
};
