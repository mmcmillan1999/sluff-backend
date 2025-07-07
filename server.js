// --- Backend/server.js (v9.0.1 - Free Token Button) ---
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

// --- IMPORTS FROM MODULES ---
const { SUITS, BID_HIERARCHY, PLACEHOLDER_ID, deck, TABLE_COSTS } = require('./game/constants');
const gameLogic = require('./game/logic');
const state = require('./game/gameState');
const createAuthRoutes = require('./routes/auth');

// --- INITIALIZATIONS ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
let pool; 

// --- MIDDLEWARE ---
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- HELPERS (Networking & Utility) ---
const emitLobbyUpdate = () => io.emit("lobbyState", state.getLobbyState());
const emitTableUpdate = (tableId) => {
    const table = state.getTableById(tableId);
    if (table) io.to(tableId).emit("gameState", table);
};
const getPlayerNameByUserId = (userId, table) => table?.players[userId]?.playerName || String(userId);
const shuffle = (array) => { let currentIndex = array.length, randomIndex; while (currentIndex !== 0) { randomIndex = Math.floor(Math.random() * currentIndex); currentIndex--; [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]; } return array; };

const createDbTables = async (dbPool) => {
    const userTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            tokens INTEGER DEFAULT 8 NOT NULL,
            wins INTEGER DEFAULT 0 NOT NULL,
            losses INTEGER DEFAULT 0 NOT NULL,
            washes INTEGER DEFAULT 0 NOT NULL
        );
    `;
    try {
        await dbPool.query(userTableQuery);
        console.log("Database 'users' table is ready.");
    } catch (err) {
        console.error("Error creating database tables:", err);
        throw err;
    }
};

// --- SOCKET.IO AUTHENTICATION MIDDLEWARE ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) { return next(new Error("Authentication error: No token provided.")); }
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) { return next(new Error("Authentication error: Invalid token.")); }
        socket.user = user;
        next();
    });
});

// --- MAIN SOCKET.IO CONNECTION HANDLER ---
io.on("connection", (socket) => {
    console.log(`Socket connected for user: ${socket.user.username} (ID: ${socket.user.id})`);
    
    socket.userId = socket.user.id; 

    for (const table of Object.values(state.getAllTables())) {
        if (table.players[socket.userId]?.disconnected) {
            console.log(`Reconnecting user ${socket.user.username} to table ${table.tableId}`);
            table.players[socket.userId].disconnected = false;
            table.players[socket.userId].socketId = socket.id;
            socket.join(table.tableId);
            emitTableUpdate(table.tableId);
        }
    }

    socket.emit("lobbyState", state.getLobbyState());

    // --- NEW: Handler for free token requests ---
    socket.on("requestFreeToken", async () => {
        try {
            const result = await pool.query(
                "UPDATE users SET tokens = tokens + 1 WHERE id = $1 RETURNING *",
                [socket.user.id]
            );
            if (result.rows.length > 0) {
                const updatedUser = result.rows[0];
                delete updatedUser.password_hash; // Don't send the hash
                socket.emit("updateUser", updatedUser); // Send updated user data back
            }
        } catch (err) {
            console.error("Error giving free token:", err);
            socket.emit("error", "Could not grant token.");
        }
    });

    socket.on("joinTable", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table) return socket.emit("error", "Table not found.");
        const { id, username } = socket.user;

        if (table.gameStarted && !table.players[id]) {
            return socket.emit("error", "Game has already started.");
        }

        const previousTable = Object.values(state.getAllTables()).find(t => t.players[id]);
        if (previousTable && previousTable.tableId !== tableId) {
            delete previousTable.players[id];
            socket.leave(previousTable.tableId);
            emitTableUpdate(previousTable.tableId);
        }

        const activePlayersBeforeJoin = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        const canTakeSeat = activePlayersBeforeJoin.length < 4 && !table.gameStarted;
        
        table.players[id] = { 
            userId: id, 
            playerName: username, 
            socketId: socket.id,
            isSpectator: table.players[id]?.isSpectator ?? !canTakeSeat, 
            disconnected: false 
        };

        if (!table.scores[username]) table.scores[username] = 120;
        
        const activePlayersAfterJoin = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        table.playerOrderActive = activePlayersAfterJoin.map(p => p.playerName);
        if (activePlayersAfterJoin.length >= 3 && !table.gameStarted) table.state = "Ready to Start";
        else if (activePlayersAfterJoin.length < 3 && !table.gameStarted) table.state = "Waiting for Players";

        socket.join(tableId);
        socket.emit("joinedTable", { tableId, gameState: table });
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("startGame", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.gameStarted) return;
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        if (activePlayers.length < 3) return socket.emit("error", "Need at least 3 players to start.");

        const tableCost = TABLE_COSTS[table.theme] || 0;

        try {
            const playerCheckPromises = activePlayers.map(p => pool.query("SELECT tokens FROM users WHERE id = $1", [p.userId]));
            const playerCheckResults = await Promise.all(playerCheckPromises);

            for (let i = 0; i < activePlayers.length; i++) {
                const player = activePlayers[i];
                const dbPlayer = playerCheckResults[i].rows[0];
                if (!dbPlayer || dbPlayer.tokens < tableCost) {
                    const playerSocket = io.sockets.sockets.get(player.socketId);
                    if(playerSocket) playerSocket.emit("error", `You need ${tableCost} tokens to play at this table.`);
                    return;
                }
            }

            const tokenDeductionPromises = activePlayers.map(p => 
                pool.query("UPDATE users SET tokens = tokens - $1 WHERE id = $2", [tableCost, p.userId])
            );
            await Promise.all(tokenDeductionPromises);

        } catch (err) {
            console.error("Database error during startGame token check/deduction:", err);
            socket.emit("error", "A server error occurred. Could not start game.");
            return;
        }
        
        table.gameStarted = true;
        table.playerMode = activePlayers.length;

        activePlayers.forEach(p => { 
            if (table.scores[p.playerName] === undefined) table.scores[p.playerName] = 120; 
        });

        if (table.playerMode === 3 && table.scores[PLACEHOLDER_ID] === undefined) {
            table.scores[PLACEHOLDER_ID] = 120;
        }

        const shuffledPlayerIds = shuffle(activePlayers.map(p => p.userId));
        table.dealer = shuffledPlayerIds[0];

        const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
        table.playerOrderActive = [];
        const numPlayers = shuffledPlayerIds.length;
        for (let i = 1; i <= numPlayers; i++) {
            const playerIndex = (dealerIndex + i) % numPlayers;
            const playerId = shuffledPlayerIds[playerIndex];
            if (table.playerMode === 4 && playerId === table.dealer) continue;
            table.playerOrderActive.push(getPlayerNameByUserId(playerId, table));
        }

        state.initializeNewRoundState(table);
        table.state = "Dealing Pending";
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("dealCards", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.state !== "Dealing Pending" || socket.user.id !== table.dealer) return;
        
        const shuffledDeck = shuffle([...deck]);
        const numActivePlayers = table.playerOrderActive.length;
        
        table.playerOrderActive.forEach((pName, i) => {
            table.hands[pName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        table.widow = shuffledDeck.slice(11 * numActivePlayers);
        table.originalDealtWidow = [...table.widow];
        
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        emitTableUpdate(tableId);
    });

    socket.on("placeBid", ({ tableId, bid }) => {
        const table = state.getTableById(tableId);
        const { id, username } = socket.user;
        if (!table || username !== table.biddingTurnPlayerName) return;
        
        const logicHelpers = { getPlayerNameByUserId, getTableById: state.getTableById, resetTable: (id) => state.resetTable(id, { emitTableUpdate, emitLobbyUpdate }), initializeNewRoundState: state.initializeNewRoundState, shuffle };

        if (table.state === "Awaiting Frog Upgrade Decision") {
            if (id !== table.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
            if (bid === "Heart Solo") {
                table.currentHighestBidDetails = { userId: id, playerName: username, bid: "Heart Solo" };
            }
            table.biddingTurnPlayerName = null;
            gameLogic.resolveBiddingFinal(table, io, logicHelpers);
            return;
        }

        if (table.state !== "Bidding Phase") return;
        if (!BID_HIERARCHY.includes(bid) || table.playersWhoPassedThisRound.includes(username)) return;

        const currentHighestBidIndex = table.currentHighestBidDetails ? BID_HIERARCHY.indexOf(table.currentHighestBidDetails.bid) : -1;
        if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;

        if (bid !== "Pass") {
            table.currentHighestBidDetails = { userId: id, playerName: username, bid };
            if (bid === "Frog" && !table.originalFrogBidderId) {
                table.originalFrogBidderId = id;
            }
            if (bid === "Solo" && table.originalFrogBidderId && id !== table.originalFrogBidderId) {
                table.soloBidMadeAfterFrog = true;
            }
        } else {
            table.playersWhoPassedThisRound.push(username);
        }

        const activeBiddersRemaining = table.playerOrderActive.filter(name => !table.playersWhoPassedThisRound.includes(name));
        let endBidding = false;
        if (table.currentHighestBidDetails && activeBiddersRemaining.length <= 1) {
             endBidding = true;
        } else if (table.playersWhoPassedThisRound.length === table.playerOrderActive.length) {
            endBidding = true;
        }

        if (endBidding) {
            table.biddingTurnPlayerName = null;
            gameLogic.checkForFrogUpgrade(table, io, logicHelpers);
        } else {
            let currentBidderIndex = table.playerOrderActive.indexOf(username);
            let nextBidderName = null;
            for (let i = 1; i < table.playerOrderActive.length; i++) {
                let potentialNextBidder = table.playerOrderActive[(currentBidderIndex + i) % table.playerOrderActive.length];
                if (!table.playersWhoPassedThisRound.includes(potentialNextBidder)) {
                    nextBidderName = potentialNextBidder;
                    break;
                }
            }
            if (nextBidderName) {
                table.biddingTurnPlayerName = nextBidderName;
            } else {
                gameLogic.checkForFrogUpgrade(table, io, logicHelpers);
            }
        }
        emitTableUpdate(tableId);
    });

    socket.on("chooseTrump", ({ tableId, suit }) => {
        const table = state.getTableById(tableId);
        const { id } = socket.user;
        if(!table || table.state !== "Trump Selection" || table.bidWinnerInfo.userId !== id) return;
        if(!["S", "C", "D"].includes(suit)) return;
        table.trumpSuit = suit;
        gameLogic.transitionToPlayingPhase(table, io);
    });

    socket.on("submitFrogDiscards", ({ tableId, discards }) => {
        const table = state.getTableById(tableId);
        const { id, username } = socket.user;
        if(!table || table.state !== "Frog Widow Exchange" || table.bidWinnerInfo.userId !== id) return;
        if(!Array.isArray(discards) || discards.length !== 3) return;
        
        const currentHand = table.hands[username];
        if(!discards.every(card => currentHand.includes(card))) return socket.emit("error", "Invalid discard selection.");

        table.widowDiscardsForFrogBidder = discards;
        table.hands[username] = currentHand.filter(card => !discards.includes(card));
        gameLogic.transitionToPlayingPhase(table, io);
    });

    socket.on("playCard", ({ tableId, card }) => {
        const table = state.getTableById(tableId);
        if (!table) return;
        const { username, id } = socket.user;
        
        if (table.state !== "Playing Phase" || username !== table.trickTurnPlayerName) return;
        const hand = table.hands[username];
        if (!hand || !hand.includes(card)) return;

        const isLeading = table.currentTrickCards.length === 0;
        const playedSuit = gameLogic.getSuit(card);

        if (isLeading) {
            if (playedSuit === table.trumpSuit && !table.trumpBroken) {
                const isHandAllTrump = hand.every(c => gameLogic.getSuit(c) === table.trumpSuit);
                if (!isHandAllTrump) return socket.emit("error", "Cannot lead trump until it is broken.");
            }
        } else {
            const leadCardSuit = table.leadSuitCurrentTrick;
            const hasLeadSuit = hand.some(c => gameLogic.getSuit(c) === leadCardSuit);
            if (playedSuit !== leadCardSuit && hasLeadSuit) return socket.emit("error", `Must follow suit (${SUITS[leadCardSuit]}).`);
            if (!hasLeadSuit) {
                const hasTrump = hand.some(c => gameLogic.getSuit(c) === table.trumpSuit);
                if (hasTrump && playedSuit !== table.trumpSuit) return socket.emit("error", "You must play trump if you cannot follow suit.");
            }
        }

        table.hands[username] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ userId: id, playerName: username, card });
        if (isLeading) table.leadSuitCurrentTrick = playedSuit;
        if (playedSuit === table.trumpSuit) table.trumpBroken = true;

        const expectedCardsInTrick = table.playerOrderActive.length;
        if (table.currentTrickCards.length === expectedCardsInTrick) {
            const winnerInfo = gameLogic.determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            table.lastCompletedTrick = { cards: [...table.currentTrickCards], winnerName: winnerInfo.playerName };
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerInfo.playerName;

            if (winnerInfo.playerName) {
                if (!table.capturedTricks[winnerInfo.playerName]) table.capturedTricks[winnerInfo.playerName] = [];
                table.capturedTricks[winnerInfo.playerName].push(table.currentTrickCards.map(p => p.card));
            }
            
            if (table.tricksPlayedCount === 11) {
                gameLogic.calculateRoundScores(table, io, pool, getPlayerNameByUserId);
            } else {
                table.state = "TrickCompleteLinger";
                emitTableUpdate(tableId);
                setTimeout(() => {
                    const currentTable = state.getTableById(tableId);
                    if (currentTable && currentTable.state === "TrickCompleteLinger") {
                        currentTable.currentTrickCards = [];
                        currentTable.leadSuitCurrentTrick = null;
                        currentTable.trickTurnPlayerName = winnerInfo.playerName;
                        currentTable.state = "Playing Phase";
                        emitTableUpdate(tableId);
                    }
                }, 1000);
            }
        } else {
            const currentTurnPlayerIndex = table.playerOrderActive.indexOf(username);
            table.trickTurnPlayerName = table.playerOrderActive[(currentTurnPlayerIndex + 1) % expectedCardsInTrick];
            emitTableUpdate(tableId);
        }
    });
    
    socket.on("updateInsuranceSetting", ({ tableId, settingType, value }) => {
        const table = state.getTableById(tableId);
        const { username } = socket.user;
        if (!username || !table) return socket.emit("error", "Player or table not found.");
        if (!table.insurance.isActive) return socket.emit("error", "Insurance is not currently active.");
        if (table.insurance.dealExecuted) return socket.emit("error", "Insurance deal already made, settings are locked.");
        
        const multiplier = table.insurance.bidMultiplier;
        const parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) return socket.emit("error", "Invalid value. Must be a whole number.");

        if (settingType === 'bidderRequirement') {
            if (username !== table.insurance.bidderPlayerName) return socket.emit("error", "Only the bid winner can update the requirement.");
            const minReq = -120 * multiplier; const maxReq = 120 * multiplier;
            if (parsedValue < minReq || parsedValue > maxReq) return socket.emit("error", `Requirement out of range [${minReq}, ${maxReq}].`);
            table.insurance.bidderRequirement = parsedValue;
        } else if (settingType === 'defenderOffer') {
            if (!table.insurance.defenderOffers.hasOwnProperty(username)) return socket.emit("error", "You are not a listed defender.");
            const minOffer = -60 * multiplier; const maxOffer = 60 * multiplier;
            if (parsedValue < minOffer || parsedValue > maxOffer) return socket.emit("error", `Offer out of range [${minOffer}, ${maxOffer}].`);
            table.insurance.defenderOffers[username] = parsedValue;
        } else {
            return socket.emit("error", "Invalid insurance setting type.");
        }

        const { bidderRequirement, defenderOffers } = table.insurance;
        const sumOfDefenderOffers = Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0);
        if (bidderRequirement <= sumOfDefenderOffers) {
            table.insurance.dealExecuted = true;
            table.insurance.executedDetails = {
                agreement: { bidderPlayerName: table.insurance.bidderPlayerName, bidderRequirement: bidderRequirement, defenderOffers: { ...defenderOffers } },
            };
            console.log(`[${tableId}] INSURANCE DEAL EXECUTED!`);
        }
        emitTableUpdate(tableId);
    });

    socket.on("requestNextRound", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table && table.state === "Awaiting Next Round Trigger" && socket.user.id === table.roundSummary?.dealerOfRoundId) {
            const helpers = { resetTable: (id) => state.resetTable(id, { emitTableUpdate, emitLobbyUpdate }), getPlayerNameByUserId, initializeNewRoundState: state.initializeNewRoundState, shuffle };
            gameLogic.prepareNextRound(table, io, helpers);
        } else {
            socket.emit("error", "Cannot start next round: Not the correct state or you are not the dealer.");
        }
    });

    socket.on("hardResetServer", () => {
        console.log(`[ADMIN] User ${socket.user.username} initiated a hard server reset.`);
        state.initializeGameTables();
        io.emit("forceDisconnectAndReset", "The game server was reset by an administrator.");
    });

    socket.on("disconnect", (reason) => {
        const userId = socket.userId;
        if (!userId) return;

        console.log(`Socket disconnected for user ID: ${userId}, Reason: ${reason}`);

        const table = Object.values(state.getAllTables()).find(t => t.players[userId]);
        if (table) {
            const playerInfo = table.players[userId];
            if (playerInfo) {
                playerInfo.disconnected = true;
                if (table.gameStarted && !playerInfo.isSpectator) {
                    emitTableUpdate(table.tableId);
                    emitLobbyUpdate();
                } else {
                    delete table.players[userId];
                    emitTableUpdate(table.tableId);
                    emitLobbyUpdate();
                }
            }
        }
    });

    socket.on("resetGame", ({ tableId }) => {
        state.resetTable(tableId, { emitTableUpdate, emitLobbyUpdate });
    });
});


// --- SERVER STARTUP ---
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
    const authRoutes = createAuthRoutes(pool);
    app.use('/api/auth', authRoutes);

    state.initializeGameTables();
  } catch (err) {
    console.error("❌ DATABASE CONNECTION FAILED:", err);
    process.exit(1);
  }
});
