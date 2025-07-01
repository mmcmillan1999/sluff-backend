// --- Backend/server.js (v5.0.0 - Database & Auth Foundation) ---
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");

// --- INITIALIZATIONS ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const SERVER_VERSION = "5.0.0 - Database & Auth Foundation";

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- MIDDLEWARE ---
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- GAME CONSTANTS ---
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"];
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];
const BID_MULTIPLIERS = { "Frog": 1, "Solo": 2, "Heart Solo": 3 };
const PLACEHOLDER_ID = "ScoreAbsorber";
const MAX_PLAYERS_PER_TABLE = 4;
const NUM_TABLES = 3;

// --- IN-MEMORY GAME STATE (To be migrated to database) ---
let tables = {};
let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- DATABASE SETUP FUNCTION ---
const createTables = async () => {
    const userTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `;
    // Add CREATE TABLE for games, etc. here in the future
    try {
        await pool.query(userTableQuery);
        console.log("Database tables are ready.");
    } catch (err) {
        console.error("Error creating database tables:", err);
    }
};

// --- API ROUTES for AUTHENTICATION ---
// NOTE: These are placeholders. You will build out the logic for these next.
app.post("/api/auth/register", async (req, res) => {
    const { username, email, password } = req.body;
    // TODO: 1. Validate input
    // TODO: 2. Hash the password using bcrypt
    // TODO: 3. Save the new user to the database
    // TODO: 4. Return a success message or token
    res.status(501).json({ message: "Register endpoint not implemented" });
});

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    // TODO: 1. Find user by email in the database
    // TODO: 2. Compare provided password with the stored hash using bcrypt
    // TODO: 3. If match, generate a JWT (JSON Web Token)
    // TODO: 4. Return the token to the client
    res.status(501).json({ message: "Login endpoint not implemented" });
});


// --- GAME LOGIC (temporary) ---
// This section will be heavily refactored to use the database
// and authenticated user IDs instead of in-memory objects.

function getInitialGameData(tableId) {
    return {
        tableId: tableId,
        state: "Waiting for Players",
        players: {},
        // ... other initial game data fields
        serverVersion: SERVER_VERSION,
    };
}

function initializeGameTables() {
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
}


// --- SOCKET.IO LOGIC ---
io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // NOTE: The old 'login' and 'reconnectPlayer' events are removed.
    // The new flow will be:
    // 1. User logs in via the '/api/auth/login' HTTP route.
    // 2. Client receives a JWT.
    // 3. Client connects to socket.io and sends the JWT for authentication.

    socket.on("authenticate", (token) => {
        // TODO: Verify the JWT. If valid, associate the socket with the user ID.
        console.log(`Socket ${socket.id} is attempting to authenticate.`);
    });
    
    // All other game-related socket events (joinTable, playCard, etc.) will go here.
    // They will need to be updated to use the authenticated user's ID.

    socket.on("disconnect", () => {
        console.log(`Socket disconnected: ${socket.id}`);
        // TODO: Update disconnect logic for authenticated users.
    });
});


// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`);
  await createTables(); //