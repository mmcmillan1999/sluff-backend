// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require('bcrypt');

const state = require('./game/gameState');
const createAuthRoutes = require('./routes/auth');
const createLeaderboardRoutes = require('./routes/leaderboard');
const createAdminRoutes = require('./routes/admin');
const createDbTables = require('./db/createTables');
const transactionManager = require("./db/transactionManager"); // Required for free token

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

let pool;

app.use(cors({ origin: "*" }));
app.use(express.json());

// =================================================================
// AUTHENTICATION MIDDLEWARE
// =================================================================

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

// =================================================================
// SOCKET.IO CONNECTION HANDLER
// =================================================================

io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.user.username} (ID: ${socket.user.id}, Socket: ${socket.id})`);

    const table = Object.values(state.getAllTables()).find(t => t.players[socket.user.id]);
    if (table && table.players[socket.user.id].disconnected) {
        table.reconnectPlayer(socket.user.id, socket.id);
    }
    
    socket.emit("lobbyState", state.getLobbyState());

    // --- CORE EVENT LISTENERS (DELEGATION MODEL) ---

    socket.on("joinTable", async ({ tableId }) => {
        const tableToJoin = state.getTableById(tableId);
        if (!tableToJoin) return socket.emit("error", { message: "Table not found." });

        const previousTable = Object.values(state.getAllTables()).find(t => t.players[socket.user.id] && t.tableId !== tableId);
        if (previousTable) {
            await previousTable.leaveTable(socket.user.id);
            socket.leave(previousTable.tableId);
        }
        
        socket.join(tableId);
        await tableToJoin.joinTable(socket.user, socket.id);
    });

    socket.on("leaveTable", async ({ tableId }) => {
        const tableToLeave = state.getTableById(tableId);
        if (tableToLeave) {
            await tableToLeave.leaveTable(socket.user.id);
        }
        socket.leave(tableId);
        socket.emit("lobbyState", state.getLobbyState());
    });

    socket.on("startGame", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) table.startGame(socket.user.id);
    });
    
    socket.on("dealCards", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) table.dealCards(socket.user.id);
    });

    socket.on("placeBid", ({ tableId, bid }) => {
        const table = state.getTableById(tableId);
        if (table) table.placeBid(socket.user.id, bid);
    });

    socket.on("chooseTrump", ({ tableId, suit }) => {
        const table = state.getTableById(tableId);
        if (table) table.chooseTrump(socket.user.id, suit);
    });

    socket.on("submitFrogDiscards", ({ tableId, discards }) => {
        const table = state.getTableById(tableId);
        if (table) table.submitFrogDiscards(socket.user.id, discards);
    });

    socket.on("playCard", ({ tableId, card }) => {
        const table = state.getTableById(tableId);
        if (table) table.playCard(socket.user.id, card);
    });

    socket.on("requestNextRound", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) table.requestNextRound(socket.user.id);
    });
    
    socket.on("forfeitGame", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) table.forfeitGame(socket.user.id);
    });
    
    socket.on("resetGame", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) await table.reset();
    });

    socket.on("updateInsuranceSetting", ({ tableId, settingType, value }) => {
        const table = state.getTableById(tableId);
        if (table) table.updateInsuranceSetting(socket.user.id, settingType, value);
    });

    socket.on("startTimeoutClock", ({ tableId, targetPlayerName }) => {
        const table = state.getTableById(tableId);
        if (table) table.startForfeitTimer(socket.user.id, targetPlayerName);
    });

    socket.on("requestDraw", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table) table.requestDraw(socket.user.id);
    });
    
    socket.on("submitDrawVote", ({ tableId, vote }) => {
        const table = state.getTableById(tableId);
        if (table) table.submitDrawVote(socket.user.id, vote);
    });

    // --- USER-SPECIFIC & MISC LISTENERS ---

    socket.on("requestUserSync", async () => {
        try {
            const userQuery = "SELECT id, username, email, created_at, wins, losses, washes, is_admin FROM users WHERE id = $1";
            const userResult = await pool.query(userQuery, [socket.user.id]);
            const updatedUser = userResult.rows[0];

            if (updatedUser) {
                const tokenQuery = "SELECT SUM(amount) AS current_tokens FROM transactions WHERE user_id = $1";
                const tokenResult = await pool.query(tokenQuery, [socket.user.id]);
                updatedUser.tokens = parseFloat(tokenResult.rows[0]?.current_tokens || 0).toFixed(2);
                socket.emit("updateUser", updatedUser);
            }
        } catch(err) {
            console.error(`Error during user sync for user ${socket.user.id}:`, err);
        }
    });

    socket.on("requestFreeToken", async () => {
        try {
            await transactionManager.postTransaction(pool, {
                userId: socket.user.id, gameId: null, type: 'free_token_mercy', amount: 1,
                description: 'Mercy token requested by user'
            });
            socket.emit("requestUserSync");
        } catch (err) {
            socket.emit("error", { message: "Could not grant token." });
        }
    });

    socket.on("disconnect", () => {
        console.log(`Socket disconnected: ${socket.user.username} (ID: ${socket.user.id}, Socket: ${socket.id})`);
        const tablePlayerIsOn = Object.values(state.getAllTables()).find(t => t.players[socket.user.id]);
        if (tablePlayerIsOn) {
            tablePlayerIsOn.disconnectPlayer(socket.user.id);
        }
    });
});

// =================================================================
// SERVER STARTUP
// =================================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Sluff Game Server (v${require('./game/constants').SERVER_VERSION}) running on port ${PORT}`);
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pool.connect();
    console.log("✅ Database connection successful.");
    await createDbTables(pool);
    
    const authRoutes = createAuthRoutes(pool, bcrypt, jwt);
    app.use('/api/auth', authRoutes);

    const leaderboardRoutes = createLeaderboardRoutes(pool);
    app.use('/api/leaderboard', leaderboardRoutes);

    const adminRouter = createAdminRoutes(pool);
    app.use('/api/admin', adminRouter);

    state.initializeGameTables(io, pool);

  } catch (err) {
    console.error("❌ DATABASE CONNECTION FAILED:", err);
    process.exit(1);
  }
});