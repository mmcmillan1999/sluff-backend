const express = require('express');
const router = express.Router();

// This function will be called from server.js with the db (pool), bcrypt, and jwt dependencies
module.exports = function(pool, bcrypt, jwt) {

    // REGISTRATION ROUTE
    router.post('/register', async (req, res) => {
        try {
            const { username, email, password } = req.body;
            if (!username || !email || !password) {
                return res.status(400).json({ message: "Username, email, and password are required." });
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            
            // Step 1: Insert the new user and get their ID back
            const insertUserQuery = 'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id';
            const userResult = await pool.query(insertUserQuery, [username, email, hashedPassword]);
            const newUserId = userResult.rows[0].id;

            // Step 2: Create the initial transaction for the starting 8 tokens
            const startingTokens = 8.00;
            // --- MODIFICATION: Changed to a valid ENUM value ---
            const transactionType = 'admin_adjustment'; 
            const description = 'New user starting balance';
            const insertTransactionQuery = 'INSERT INTO transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)';
            await pool.query(insertTransactionQuery, [newUserId, startingTokens, transactionType, description]);
            
            res.status(201).json({ message: "User registered successfully!" });
        } catch (error) {
            console.error("Registration error:", error);
            const detailedErrorMessage = error.message || "An unknown database error occurred.";
            res.status(500).json({ message: detailedErrorMessage });
        }
    });

    // LOGIN ROUTE
    router.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ message: "Email and password are required." });
            }

            // Using $1 for PostgreSQL
            const userQuery = 'SELECT id, username, password_hash, is_admin FROM users WHERE email = $1';
            const userResult = await pool.query(userQuery, [email]);

            if (userResult.rows.length === 0) {
                return res.status(401).json({ message: "Invalid credentials." });
            }

            const user = userResult.rows[0];
            const isPasswordValid = await bcrypt.compare(password, user.password_hash);

            if (!isPasswordValid) {
                return res.status(401).json({ message: "Invalid credentials." });
            }

            // Using $1 for PostgreSQL
            const tokenQuery = "SELECT SUM(amount) AS tokens FROM transactions WHERE user_id = $1";
            const tokenResult = await pool.query(tokenQuery, [user.id]);
            const tokens = parseFloat(tokenResult.rows[0].tokens || 0).toFixed(2);

            const payload = { id: user.id, username: user.username, is_admin: user.is_admin };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    tokens: tokens,
                    is_admin: user.is_admin
                }
            });

        } catch (error) {
            console.error("Login error:", error);
            res.status(500).json({ message: "Internal server error during login." });
        }
    });

    return router;
};
