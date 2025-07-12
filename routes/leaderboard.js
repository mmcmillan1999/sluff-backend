const express = require('express');
const router = express.Router();

// This function will be called from server.js with the db (pool)
module.exports = function(pool) {

    router.get('/', async (req, res) => {
        try {
            // --- MODIFICATION: Corrected the JOIN condition and GROUP BY clause ---
            const query = `
                SELECT 
                    u.id as user_id,
                    u.username, 
                    u.email, 
                    u.wins, 
                    u.losses, 
                    u.washes,
                    u.is_admin,
                    COALESCE(SUM(t.amount), 0) as tokens
                FROM 
                    users u
                LEFT JOIN 
                    transactions t ON u.id = t.user_id
                GROUP BY 
                    u.id, u.username, u.email, u.wins, u.losses, u.washes, u.is_admin
                ORDER BY 
                    tokens DESC;
            `;
            const { rows } = await pool.query(query);
            res.json(rows);
        } catch (error) {
            console.error("Error fetching leaderboard data:", error);
            res.status(500).json({ message: "Internal server error" });
        }
    });

    return router;
};
