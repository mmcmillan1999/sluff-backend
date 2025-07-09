// backend/routes/leaderboard.js

const express = require('express');
const jwt = require('jsonwebtoken');

// Middleware to protect routes
const protectedRoute = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) return res.sendStatus(401); // if there isn't any token

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); // if the token is invalid
        req.user = user;
        next();
    });
};


function createLeaderboardRoutes(pool) {
    const router = express.Router();

    router.get('/', protectedRoute, async (req, res) => {
        try {
            // --- MODIFICATION: Added a WHERE clause to filter out users with 0 games played ---
            const query = `
                SELECT username, email, wins, losses, washes, tokens 
                FROM users 
                WHERE (wins + losses + washes) > 0
                ORDER BY tokens DESC;
            `;
            const { rows } = await pool.query(query);
            res.json(rows);
        } catch (err) {
            console.error("Error fetching leaderboard data:", err);
            res.status(500).json({ message: "Server error fetching leaderboard." });
        }
    });

    return router;
}

module.exports = createLeaderboardRoutes;
