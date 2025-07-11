// backend/routes/auth.js

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

function createAuthRoutes(pool) {
    const router = express.Router();

    // --- MODIFICATION: New user registration now creates a starting token balance ---
    router.post("/register", async (req, res) => {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ message: "Username, email, and password are required." });
        }

        const client = await pool.connect(); // Get a client from the pool for a transaction
        try {
            await client.query('BEGIN'); // Start the transaction

            // Step 1: Create the new user
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);
            const newUserQuery = `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email;`;
            const result = await client.query(newUserQuery, [username, email, passwordHash]);
            const newUser = result.rows[0];

            // Step 2: Create the starting balance transaction for the new user
            const STARTING_TOKENS = 8.00;
            const transactionQuery = `
                INSERT INTO transactions (user_id, transaction_type, amount, description)
                VALUES ($1, 'admin_adjustment', $2, 'Initial starting balance on registration');
            `;
            await client.query(transactionQuery, [newUser.id, STARTING_TOKENS]);

            await client.query('COMMIT'); // Commit the transaction
            
            res.status(201).json({ message: "User created successfully", user: newUser });

        } catch (err) {
            await client.query('ROLLBACK'); // Rollback on error
            if (err.code === '23505') { // Unique constraint violation
                return res.status(409).json({ message: "Username or email already exists." });
            }
            console.error("Error during registration:", err);
            res.status(500).json({ message: "Server error during registration." });
        } finally {
            client.release(); // Release the client back to the pool
        }
    });

    // --- MODIFICATION: Login now calculates token balance and uses a cleaner JWT payload ---
    router.post("/login", async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required." });
        }
        try {
            // Step 1: Fetch user data (excluding tokens column)
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
            
            // Step 2: Calculate the user's current token balance from the ledger
            const tokenQuery = "SELECT SUM(amount) AS current_tokens FROM transactions WHERE user_id = $1";
            const tokenResult = await pool.query(tokenQuery, [user.id]);
            // Attach the calculated balance to the user object that will be sent to the client
            user.tokens = parseFloat(tokenResult.rows[0].current_tokens || 0).toFixed(2);
            
            // Step 3: Create a clean JWT payload for authentication
            const payload = { 
                id: user.id, 
                username: user.username,
            };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

            // Step 4: Return the token and full user object (with tokens, without password hash)
            delete user.password_hash;
            res.json({ message: "Logged in successfully", token: token, user: user });

        } catch (err) {
            console.error("Error during login:", err);
            res.status(500).json({ message: "Server error during login." });
        }
    });

    return router;
}

module.exports = createAuthRoutes;