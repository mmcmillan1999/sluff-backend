// --- Backend/server.js (v5.0.4 - Socket Authentication) ---
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// --- INITIALIZATIONS ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const SERVER_VERSION = "5.0.4 - Socket Authentication";
let pool; 

// --- MIDDLEWARE ---
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- GAME CONSTANTS & IN-MEMORY STATE ---
const NUM_TABLES = 3;
let tables = {};

// --- HELPER FUNCTIONS ---
function getLobbyState() {
    return Object.fromEntries(
        Object.entries(tables).map(([tableId, table]) => {
            const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
            return [
                tableId,
                {
                    tableId: table.tableId,
                    state: table.state,
                    players: activePlayers.map(p => ({ playerName: p.playerName, disconnected: p.disconnected })),
                    playerCount: activePlayers.length,
                    spectatorCount: Object.values(table.players).length - activePlayers.length,
                },
            ];
        })
    );
}

function getInitialGameData(tableId) {
    return {
        tableId: tableId,
        state: "Waiting for Players",
        players: {},
        serverVersion: SERVER_VERSION,
        // ... all other initial game data fields from your old version
    };
}

function initializeGameTables() {
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log("In-memory game tables initialized.");
}


// --- DATABASE SETUP FUNCTION ---
const createTables = async (dbPool) => {
    const userTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `;
    try {
        await dbPool.query(userTableQuery);
        console.log("Database tables are ready.");
    } catch (err) {
        console.error("Error creating database tables:", err);
    }
};

// --- API ROUTES for AUTHENTICATION ---
app.post("/api/auth/register", async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: "Username, email, and password are required." });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const newUserQuery = `
            INSERT INTO users (username, email, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, username, email;
        `;
        const result = await pool.query(newUserQuery, [username, email, passwordHash]);
        res.status(201).json({ message: "User created successfully", user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: "Username or email already exists." });
        }
        console.error(err);
        res.status(500).json({ message: "Server error during registration." });
    }
});

app.post("/api/auth/login", async (req, res) => {
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
        console.error(err);
        res.status(500).json({ message: "Server error during login." });
    }
});

// --- SOCKET.IO LOGIC ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication error: No token provided."));
    }
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return next(new Error("Authentication error: Invalid token."));
        }
        socket.user = user;
        next();
    });
});

io.on("connection", (socket) => {
    console.log(`Socket connected and authenticated for user: ${socket.user.username} (ID: ${socket.user.id})`);
    
    socket.emit("lobbyState", getLobbyState());

    // TODO: Re-implement game logic socket handlers here, using socket.user to identify the player.
    // Example:
    // socket.on("joinTable", ({ tableId }) => { ... });

    socket.on("disconnect", () => {
        console.log(`Socket for ${socket.user.username} disconnected.`);
        // TODO: Update disconnect logic for authenticated users.
    });
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`);
  try {
    pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
      ssl: true,
    });
    console.log("Database connection pool established.");
    await createTables(pool);
    initializeGameTables();
  } catch (err) {
    console.error("Failed to connect to the database:", err);
  }
});