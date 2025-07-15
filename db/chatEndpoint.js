// Example Express endpoint for lobby chat
// This server file is illustrative only; the actual backend repository is not included.

const express = require('express');
const router = express.Router();

// Expected database table: lobby_chat_messages
// Fields: id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT,
// message TEXT, created_at TIMESTAMP DEFAULT NOW()

// GET /api/chat - return chat history
router.get('/', async (req, res) => {
    // TODO: implement database fetch
    res.json([]);
});

// POST /api/chat - add a new message
router.post('/', async (req, res) => {
    const { message } = req.body;
    // TODO: insert message into database
    // Return the saved message with id, username, etc.
    res.json({ id: 0, username: req.user.username, message });
});

module.exports = router;