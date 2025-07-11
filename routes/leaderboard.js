// backend/routes/leaderboard.js

const express = require('express');
const jwt = require('jsonwebtoken');

// Middleware to protect routes
const protectedRoute = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

function createLeaderboardRoutes(pool) {
    const router = express.Router();

    router.get('/', protectedRoute, async (req, res) => {
        try {
            // --- REVISED QUERY (using a CTE for robustness) ---
            const query = `
                WITH user_tokens AS (
                    SELECT
                        user_id,
                        SUM(amount) AS total_tokens
                    FROM
                        transactions
                    GROUP BY
                        user_id
                )
                SELECT
                    u.username,
                    u.email,
                    u.wins,
                    u.losses,
                    u.washes,
                    COALESCE(ut.total_tokens, 0) AS tokens
                FROM
                    users u
                LEFT JOIN
                    user_tokens ut ON u.id = ut.user_id
                WHERE (u.wins + u.losses + u.washes) > 0
                ORDER BY
                    tokens DESC;
            `;
            const { rows } = await pool.query(query);
            
            const formattedRows = rows.map(row => ({
                ...row,
                tokens: parseFloat(row.tokens).toFixed(2)
            }));
            res.json(formattedRows);
        } catch (err) {
            console.error("Error fetching leaderboard data:", err);
            res.status(500).json({ message: "Server error fetching leaderboard." });
        }
    });

    return router;
}

module.exports = createLeaderboardRoutes;