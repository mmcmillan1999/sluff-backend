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
            const insertQuery = 'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)';
            await pool.query(insertQuery, [username, email, hashedPassword]);
            res.status(201).json({ message: "User registered successfully!" });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'Email or username already exists.' });
            }
            console.error("Registration error:", error);
            res.status(500).json({ message: "Internal server error during registration." });
        }
    });

    // LOGIN ROUTE
    router.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ message: "Email and password are required." });
            }

            // --- MODIFICATION 1 of 3: Add is_admin to the SELECT query ---
            const userQuery = 'SELECT user_id, username, password_hash, tokens, is_admin FROM users WHERE email = ?';
            const [users] = await pool.query(userQuery, [email]);

            if (users.length === 0) {
                return res.status(401).json({ message: "Invalid credentials." });
            }

            const user = users[0];
            const isPasswordValid = await bcrypt.compare(password, user.password_hash);

            if (!isPasswordValid) {
                return res.status(401).json({ message: "Invalid credentials." });
            }

            // --- MODIFICATION 2 of 3: Add is_admin to the JWT payload ---
            const payload = { id: user.user_id, username: user.username, is_admin: user.is_admin };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

            res.json({
                token,
                // --- MODIFICATION 3 of 3: Add is_admin to the user object ---
                user: {
                    id: user.user_id,
                    username: user.username,
                    tokens: user.tokens,
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
