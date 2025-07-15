// backend/routes/chat.js

const express = require('express');

// Middleware to verify JWT token
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
        req.user = user;
        next();
    });
};

const createChatRoutes = (pool, io, jwt) => {
    const router = express.Router();

    // GET /api/chat - Fetch recent chat messages
    router.get('/', checkAuth(jwt), async (req, res) => {
        try {
            const query = `
                SELECT id, username, message, created_at 
                FROM lobby_chat_messages 
                ORDER BY created_at ASC 
                LIMIT 50;
            `;
            const { rows } = await pool.query(query);
            res.json(rows);
        } catch (error) {
            console.error('Failed to fetch chat history:', error);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/chat - Post a new message
    router.post('/', checkAuth(jwt), async (req, res) => {
        const { id: userId, username } = req.user;
        const { message } = req.body;

        if (!message || message.trim() === '') {
            return res.status(400).json({ message: 'Message cannot be empty.' });
        }

        try {
            const query = `
                INSERT INTO lobby_chat_messages (user_id, username, message)
                VALUES ($1, $2, $3)
                RETURNING id, username, message, created_at;
            `;
            const values = [userId, username, message.trim()];
            const { rows } = await pool.query(query, values);
            const newMessage = rows[0];

            // Broadcast the new message to all connected clients
            io.emit('new_lobby_message', newMessage);

            res.status(201).json(newMessage);

        } catch (error) {
            console.error('Failed to post chat message:', error);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    return router;
};

module.exports = createChatRoutes;