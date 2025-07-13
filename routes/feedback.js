// In a new file at: /routes/feedback.js

const express = require('express');

// A simple middleware to ensure the user is authenticated via JWT.
// This is a simplified version for Express routes.
const checkAuth = (jwt) => (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Authentication required.');
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).send('Invalid or expired token.');
        }
        req.user = user; // Attach user payload to the request
        next();
    });
};

const createFeedbackRoutes = (pool, jwt) => {
    const router = express.Router();
    
    router.post('/', checkAuth(jwt), async (req, res) => {
        const { id: userId, username } = req.user;
        const { feedback_text, game_state_json } = req.body;

        if (!feedback_text) {
            return res.status(400).json({ message: 'Feedback text is required.' });
        }

        try {
            const tableId = game_state_json?.tableId || null;

            const query = `
                INSERT INTO feedback (user_id, username, feedback_text, table_id, game_state_json)
                VALUES ($1, $2, $3, $4, $5)
            `;
            const values = [userId, username, feedback_text, tableId, game_state_json];
            
            await pool.query(query, values);
            
            res.status(201).json({ message: 'Feedback submitted successfully. Thank you!' });

        } catch (error) {
            console.error('Error submitting feedback:', error);
            res.status(500).json({ message: 'An internal error occurred while submitting your feedback.' });
        }
    });

    return router;
};

module.exports = createFeedbackRoutes;