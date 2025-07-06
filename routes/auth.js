// backend/routes/auth.js (v8.0.0 - Major Refactor)

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

/**
 * Creates and configures the Express router for authentication endpoints.
 * @param {object} pool - The connected 'pg' database pool.
 * @returns {object} The configured Express router.
 */
function createAuthRoutes(pool) {
    const router = express.Router();

    // --- API Route: /api/auth/register ---
    router.post("/register", async (req, res) => {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ message: "Username, email, and password are required." });
        }
        try {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);
            const newUserQuery = `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email;`;
            const result = await pool.query(newUserQuery, [username, email, passwordHash]);
            res.status(201).json({ message: "User created successfully", user: result.rows[0] });
        } catch (err) {
            if (err.code === '23505') { // Unique constraint violation
                return res.status(409).json({ message: "Username or email already exists." });
            }
            console.error("Error during registration:", err);
            res.status(500).json({ message: "Server error during registration." });
        }
    });

    // --- API Route: /api/auth/login ---
    router.post("/login", async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required." });
        }
        try {
            const userQuery = "SELECT * FROM users WHERE email = $1";
            const result = await pool.query(userQuery, [email]);
            const user = result.rows[0];
            if (!user) {
                return res.status(401).json({ message: "Invalid credentials." });
            }
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (!isMatch) {
                return res.status(401).json({ message: "Invalid credentials." });
            }
            const payload = { id: user.id, username: user.username };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });
            res.json({ message: "Logged in successfully", token: token, user: payload });
        } catch (err) {
            console.error("Error during login:", err);
            res.status(500).json({ message: "Server error during login." });
        }
    });

    return router;
}

module.exports = createAuthRoutes;
