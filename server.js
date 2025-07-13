// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors =require("cors");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require('bcrypt');

const { SUITS, BID_HIERARCHY, PLACEHOLDER_ID, deck, TABLE_COSTS, SERVER_VERSION } = require('./game/constants');
const gameLogic = require('./game/logic');
const state = require('./game/gameState');
const createAuthRoutes = require('./routes/auth');
const createLeaderboardRoutes = require('./routes/leaderboard');
const createAdminRoutes = require('./routes/admin');
const transactionManager = require('./db/transactionManager');
const createDbTables = require('./db/createTables');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
let pool;
let activeTimers = {};

app.use(cors({ origin: "*" }));
app.use(express.json());

const emitLobbyUpdate = () => {
    io.emit("lobbyState", state.getLobbyState());
};

const emitTableUpdate = (tableId) => {
    const table = state.getTableById(tableId);
    if (table) {
        io.to(tableId).emit("gameState", table);
    }
};

const getPlayerNameByUserId = (userId, table) => {
    if (!table || !table.players || !table.players[userId]) {
        return String(userId);
    }
    return table.players[userId].playerName;
};

const shuffle = (array) => {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
    }
    return array;
};

const dealCards = (players) => {
    const shuffledDeck = shuffle([...deck]);
    const hands = {};
    const widow = [];
    players.forEach(p => hands[p] = []);
    for (let i = 0; i < 33; i++) {
        hands[players[i % 3]].push(shuffledDeck.pop());
    }
    widow.push(...shuffledDeck);
    return { hands, widow };
};

/**
 * [BAND-AID FIX]
 * This function handles advancing the game after a round is skipped because all players passed.
 * It's designed to be called from a setTimeout within the gameLogic module, where the server's
 * scope isn't directly available. It finds the stalled table and prepares it for the next round.
 */
const prepareNextRound = () => {
    // Find the table that needs advancing because a round was skipped.
    const tableToAdvance = Object.values(state.getAllTables()).find(t => t.state === "Round Skipped");

    if (!tableToAdvance) {
        // This can happen if another event changes the state before the timeout fires.
        // It's not an error, so we just log it and move on.
        console.log("[prepareNextRound] No table found in 'Round Skipped' state. Ignoring.");
        return;
    }

    const table = tableToAdvance;
    const tableId = table.tableId;
    console.log(`[prepareNextRound] Automatically advancing skipped round for table ${tableId}`);

    // --- Rotate the dealer and player order ---
    // The player to the left of the dealer (first in play order) becomes the new dealer.
    const newPlayerOrderActive = [...table.playerOrderActive];
    const newDealerName = newPlayerOrderActive.shift(); // The first player in the order becomes the new dealer.
    newPlayerOrderActive.push(newDealerName); // Move them to the end of the order for the next round.
    table.playerOrderActive = newPlayerOrderActive;

    // Find the full player object for the new dealer to get their userId.
    const newDealer = Object.values(table.players).find(p => p.playerName === newDealerName);
    if (!newDealer) {
        console.error(`[prepareNextRound] FATAL: Could not find player object for new dealer: ${newDealerName} on table ${tableId}. Resetting table.`);
        // As a fallback, reset the entire table to a safe state.
        state.resetTable(tableId, pool, { emitTableUpdate, emitLobbyUpdate });
        return;
    }
    table.dealer = newDealer.userId;

    // --- Reset the table for the new round ---
    state.initializeNewRoundState(table);
    table.state = "Dealing Pending"; // Set state to allow the new dealer to deal.

    // --- Notify clients of the update ---
    console.log(`[prepareNextRound] Table ${tableId} advanced. New dealer is ${newDealerName}. State is now 'Dealing Pending'.`);
    emitTableUpdate(tableId);
};


async function resolveForfeit(tableId, forfeitingPlayerName, reason) {
    const table = state.getTableById(tableId);
    if (!table || table.state === "Game Over" || !table.gameId) return;

    console.log(`[${tableId}] Resolving forfeit for ${forfeitingPlayerName}. Reason: ${reason}`);
    
    try {
        if (activeTimers[tableId]) {
            clearInterval(activeTimers[tableId]);
            delete activeTimers[tableId];
        }
        table.forfeiture = { targetPlayerName: null, timeLeft: null };

        const forfeitingPlayer = Object.values(table.players).find(p => p.playerName === forfeitingPlayerName);
        const remainingPlayers = Object.values(table.players).filter(p => !p.isSpectator && p.playerName !== forfeitingPlayerName);
        
        const tokenChanges = gameLogic.calculateForfeitPayout(table, forfeitingPlayerName);
        
        const transactionPromises = [];
        if (forfeitingPlayer) {
            // FIX: The forfeit transaction itself is for 0 tokens.
            // The financial loss is the original buy-in, which is already accounted for.
            // This transaction is now just a record of the event.
            transactionPromises.push(transactionManager.postTransaction(pool, {
                userId: forfeitingPlayer.userId, gameId: table.gameId, type: 'forfeit_loss',
                amount: 0, description: `Forfeited game on table ${table.tableName}`
            }));
        }

        remainingPlayers.forEach(player => {
            const payoutInfo = tokenChanges[player.playerName];
            if (payoutInfo && payoutInfo.totalGain > 0) {
                // Remaining players get their own buy-in back PLUS the proportional share.
                transactionPromises.push(transactionManager.postTransaction(pool, {
                    userId: player.userId, gameId: table.gameId, type: 'forfeit_payout',
                    amount: payoutInfo.totalGain, description: `Payout from ${forfeitingPlayerName}'s forfeit`
                }));
            }
        });
        await Promise.all(transactionPromises);

        const statUpdatePromises = [];
        if (forfeitingPlayer) {
            statUpdatePromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [forfeitingPlayer.userId]));
        }
        remainingPlayers.forEach(player => {
            statUpdatePromises.push(pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [player.userId]));
        });
        await Promise.all(statUpdatePromises);
        
        const outcomeMessage = `${forfeitingPlayerName} has forfeited the game due to ${reason}.`;
        await transactionManager.updateGameRecordOutcome(pool, table.gameId, outcomeMessage);

        Object.values(table.players).forEach(p => io.sockets.sockets.get(p.socketId)?.emit("requestUserSync"));

        table.roundSummary = {
            message: `${outcomeMessage} The game has ended.`, isGameOver: true,
            gameWinner: `Payout to remaining players.`, finalScores: table.scores, payouts: tokenChanges,
        };
        table.state = "Game Over";
        emitTableUpdate(tableId);
        emitLobbyUpdate();

    } catch (err) {
        console.error(`Database error during forfeit resolution for table ${tableId}:`, err);
    }
}


io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) { return next(new Error("Authentication error: No token provided.")); }
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) { return next(new Error("Authentication error: Invalid token.")); }
        socket.user = user;
        socket.userId = user.id; 
        socket.username = user.username;
        socket.is_admin = user.is_admin;
        next();
    });
});

io.on("connection", (socket) => {
    console.log(`Socket connected for user: ${socket.user.username} (ID: ${socket.user.id})`);

    for (const table of Object.values(state.getAllTables())) {
        if (table.players[socket.userId]?.disconnected) {
            console.log(`Reconnecting user ${socket.user.username} to table ${table.tableId}`);
            table.players[socket.userId].disconnected = false;
            table.players[socket.userId].socketId = socket.id;
            socket.join(table.tableId);

            if (table.forfeiture.targetPlayerName === socket.user.username) {
                if (activeTimers[table.tableId]) {
                    clearInterval(activeTimers[table.tableId]);
                    delete activeTimers[table.tableId];
                }
                table.forfeiture = { targetPlayerName: null, timeLeft: null };
                console.log(`[${table.tableId}] Cleared timeout for reconnected player ${socket.user.username}.`);
            }
            emitTableUpdate(table.tableId);
        }
    }

    socket.emit("lobbyState", state.getLobbyState());

    socket.on("requestUserSync", async () => {
        try {
            const userQuery = "SELECT id, username, email, created_at, wins, losses, washes, is_admin FROM users WHERE id = $1";
            const userResult = await pool.query(userQuery, [socket.user.id]);
            const updatedUser = userResult.rows[0];

            if (updatedUser) {
                const tokenQuery = "SELECT SUM(amount) AS current_tokens FROM transactions WHERE user_id = $1";
                const tokenResult = await pool.query(tokenQuery, [socket.user.id]);
                updatedUser.tokens = parseFloat(tokenResult.rows[0].current_tokens || 0).toFixed(2);

                socket.emit("updateUser", updatedUser);
            }
        } catch(err) {
            console.error(`Error during user sync for user ${socket.user.id}:`, err);
        }
    });

    socket.on("forfeitGame", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || !table.players[socket.user.id]) return;
        resolveForfeit(tableId, socket.user.username, "voluntary forfeit");
    });

    socket.on("startTimeoutClock", ({ tableId, targetPlayerName }) => {
        const table = state.getTableById(tableId);
        if (!table || activeTimers[tableId] || !table.players[socket.user.id]) return;

        const targetPlayer = Object.values(table.players).find(p => p.playerName === targetPlayerName);
        if (!targetPlayer || !targetPlayer.disconnected) {
            return socket.emit("error", { message: "Cannot start timer: Player is not disconnected." });
        }

        table.forfeiture.targetPlayerName = targetPlayerName;
        table.forfeiture.timeLeft = 120;
        
        const timerId = setInterval(() => {
            const currentTable = state.getTableById(tableId);
            if (!currentTable || !currentTable.forfeiture.targetPlayerName) {
                clearInterval(timerId);
                delete activeTimers[tableId];
                return;
            }
            currentTable.forfeiture.timeLeft -= 1;
            if (currentTable.forfeiture.timeLeft <= 0) {
                resolveForfeit(tableId, targetPlayerName, "timeout");
            } else {
                emitTableUpdate(tableId);
            }
        }, 1000);
        activeTimers[tableId] = timerId;
        emitTableUpdate(tableId);
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

    socket.on("sacrificeToken", async () => {
        try {
             await transactionManager.postTransaction(pool, {
                userId: socket.user.id, gameId: null, type: 'admin_adjustment', amount: -1,
                description: 'User sacrificed a token to the gods of Sluff.'
            });
            socket.emit("requestUserSync");
        } catch (err) {
            socket.emit("error", { message: "Could not sacrifice token." });
        }
    });

    socket.on("joinTable", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table) return socket.emit("error", { message: "Table not found." });
        
        const { id, username } = socket.user;
        const isPlayerAlreadyInGame = table.players[id];
        if (!isPlayerAlreadyInGame) {
            const tableCost = TABLE_COSTS[table.theme] || 0;
            try {
                const tokenResult = await pool.query("SELECT SUM(amount) as tokens FROM transactions WHERE user_id = $1", [id]);
                const userTokens = parseFloat(tokenResult.rows[0].tokens || 0);

                if (userTokens < tableCost) {
                    return socket.emit("error", { message: `You need ${tableCost} tokens to join. You have ${userTokens.toFixed(2)}.` });
                }
            } catch (err) {
                return socket.emit("error", { message: "A server error occurred trying to join the table." });
            }
        }

        if (table.gameStarted && !isPlayerAlreadyInGame) {
            return socket.emit("error", { message: "Game has already started." });
        }

        const previousTable = Object.values(state.getAllTables()).find(t => t.players[id] && t.tableId !== tableId);
        if (previousTable) {
            delete previousTable.players[id];
            socket.leave(previousTable.tableId);
            emitTableUpdate(previousTable.tableId);
        }

        const activePlayersBeforeJoin = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        const canTakeSeat = activePlayersBeforeJoin.length < 4 && !table.gameStarted;
        
        table.players[id] = { 
            userId: id, playerName: username, socketId: socket.id,
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

        try {
            const playerIds = Object.keys(table.players).map(Number);
            if (playerIds.length > 0) {
                const tokenQuery = `SELECT user_id, SUM(amount) as tokens FROM transactions WHERE user_id = ANY($1::int[]) GROUP BY user_id;`;
                const tokenResult = await pool.query(tokenQuery, [playerIds]);
                
                const playerTokens = {};
                const userIdToNameMap = Object.values(table.players).reduce((acc, player) => { acc[player.userId] = player.playerName; return acc; }, {});
                tokenResult.rows.forEach(row => {
                    const playerName = userIdToNameMap[row.user_id];
                    if (playerName) playerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2);
                });
                table.playerTokens = playerTokens;
            }
        } catch (err) {
            console.error(`Error fetching tokens on join for table ${tableId}:`, err);
        }

        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("leaveTable", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        const userId = socket.user.id;
        if (!table || !table.players[userId]) return;

        const playerInfo = table.players[userId];
        const safeLeaveStates = ["Waiting for Players", "Ready to Start", "Game Over"];
        if (safeLeaveStates.includes(table.state) || playerInfo.isSpectator) {
            delete table.players[userId];
        } else if (table.gameId && table.gameStarted) {
            playerInfo.disconnected = true;
        } else {
            delete table.players[userId];
        }
        
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("startGame", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.gameStarted) return;
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        if (activePlayers.length < 3) {
            return socket.emit("error", { message: "Need at least 3 players to start." });
        }
        
        table.playerMode = activePlayers.length;
        const activePlayerIds = activePlayers.map(p => p.userId);
        
        try {
            const gameId = await transactionManager.createGameRecord(pool, table);
            table.gameId = gameId;

            await transactionManager.handleGameStartTransaction(pool, activePlayerIds, gameId);
            
            table.gameStarted = true;
            activePlayers.forEach(p => { if (table.scores[p.playerName] === undefined) table.scores[p.playerName] = 120; });
            if (table.playerMode === 3 && table.scores[PLACEHOLDER_ID] === undefined) {
                table.scores[PLACEHOLDER_ID] = 120;
            }
            const shuffledPlayerIds = shuffle(activePlayers.map(p => p.userId));
            table.dealer = shuffledPlayerIds[0];
            const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
            table.playerOrderActive = [];
            for (let i = 1; i <= shuffledPlayerIds.length; i++) {
                const playerId = shuffledPlayerIds[(dealerIndex + i) % shuffledPlayerIds.length];
                table.playerOrderActive.push(getPlayerNameByUserId(playerId, table));
            }
            state.initializeNewRoundState(table);
            table.state = "Dealing Pending";
            
            const tokenQuery = `SELECT user_id, SUM(amount) as tokens FROM transactions WHERE user_id = ANY($1::int[]) GROUP BY user_id;`;
            const tokenResult = await pool.query(tokenQuery, [activePlayerIds]);
            const playerTokens = {};
            const userIdToNameMap = activePlayers.reduce((acc, player) => { acc[player.userId] = player.playerName; return acc; }, {});
            tokenResult.rows.forEach(row => {
                const playerName = userIdToNameMap[row.user_id];
                if (playerName) playerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2);
            });
            table.playerTokens = playerTokens;

            emitTableUpdate(tableId);
            emitLobbyUpdate();

        } catch (err) {
            const insufficientFundsMatch = err.message.match(/(.+) has insufficient tokens/);
            if (insufficientFundsMatch) {
                const brokePlayerName = insufficientFundsMatch[1];
                const brokePlayer = Object.values(table.players).find(p => p.playerName === brokePlayerName);
                if (brokePlayer) {
                    delete table.players[brokePlayer.userId];
                    table.playerOrderActive = table.playerOrderActive.filter(pName => pName !== brokePlayerName);
                    table.playerMode = table.playerOrderActive.length;
                    table.state = table.playerMode >= 3 ? "Ready to Start" : "Waiting for Players";
                    table.gameId = null; 
                    io.to(tableId).emit("gameStartFailed", { message: err.message, kickedPlayer: brokePlayerName });
                    emitTableUpdate(tableId);
                    emitLobbyUpdate();
                }
            } else {
                socket.emit("error", { message: err.message || "A server error occurred during buy-in." });
                table.gameStarted = false; 
                table.playerMode = null;
                table.gameId = null;
            }
        }
    });


    socket.on("dealCards", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.state !== "Dealing Pending" || socket.user.id !== table.dealer) return;
        
        const shuffledDeck = shuffle([...deck]);
        table.playerOrderActive.forEach((pName, i) => {
            table.hands[pName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        table.widow = shuffledDeck.slice(11 * table.playerOrderActive.length);
        table.originalDealtWidow = [...table.widow];
        
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        emitTableUpdate(tableId);
    });

    socket.on("placeBid", ({ tableId, bid }) => {
        const table = state.getTableById(tableId);
        const { id, username } = socket.user;
        if (!table || username !== table.biddingTurnPlayerName) return;
        
        const helpers = { resetTable: (id) => state.resetTable(id, pool, { emitTableUpdate, emitLobbyUpdate }), getPlayerNameByUserId, initializeNewRoundState: state.initializeNewRoundState, shuffle, prepareNextRound };

        if (table.state === "Awaiting Frog Upgrade Decision") {
            if (id !== table.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
            if (bid === "Heart Solo") {
                table.currentHighestBidDetails = { userId: id, playerName: username, bid: "Heart Solo" };
            }
            table.biddingTurnPlayerName = null;
            gameLogic.resolveBiddingFinal(table, io, helpers);
            return;
        }

        if (table.state !== "Bidding Phase" || !BID_HIERARCHY.includes(bid) || table.playersWhoPassedThisRound.includes(username)) return;

        const currentHighestBidIndex = table.currentHighestBidDetails ? BID_HIERARCHY.indexOf(table.currentHighestBidDetails.bid) : -1;
        if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;

        if (bid !== "Pass") {
            table.currentHighestBidDetails = { userId: id, playerName: username, bid };
            if (bid === "Frog" && !table.originalFrogBidderId) table.originalFrogBidderId = id;
            if (bid === "Solo" && table.originalFrogBidderId && id !== table.originalFrogBidderId) table.soloBidMadeAfterFrog = true;
        } else {
            table.playersWhoPassedThisRound.push(username);
        }

        const activeBiddersRemaining = table.playerOrderActive.filter(name => !table.playersWhoPassedThisRound.includes(name));
        if ((table.currentHighestBidDetails && activeBiddersRemaining.length <= 1) || table.playersWhoPassedThisRound.length === table.playerOrderActive.length) {
            table.biddingTurnPlayerName = null;
            gameLogic.checkForFrogUpgrade(table, io, helpers);
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
            if (nextBidderName) table.biddingTurnPlayerName = nextBidderName;
            else gameLogic.checkForFrogUpgrade(table, io, helpers);
        }
        emitTableUpdate(tableId);
    });

    socket.on("chooseTrump", ({ tableId, suit }) => {
        const table = state.getTableById(tableId);
        const { id } = socket.user;
        if(!table || table.state !== "Trump Selection" || table.bidWinnerInfo.userId !== id || !["S", "C", "D"].includes(suit)) return;
        table.trumpSuit = suit;
        gameLogic.transitionToPlayingPhase(table, io);
    });

    socket.on("submitFrogDiscards", ({ tableId, discards }) => {
        const table = state.getTableById(tableId);
        const { id, username } = socket.user;
        if(!table || table.state !== "Frog Widow Exchange" || table.bidWinnerInfo.userId !== id || !Array.isArray(discards) || discards.length !== 3) return;
        
        const currentHand = table.hands[username];
        if(!discards.every(card => currentHand.includes(card))) return socket.emit("error", { message: "Invalid discard selection." });

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
            if (playedSuit === table.trumpSuit && !table.trumpBroken && !hand.every(c => gameLogic.getSuit(c) === table.trumpSuit)) {
                return socket.emit("error", { message: "Cannot lead trump until it is broken." });
            }
        } else {
            const leadCardSuit = table.leadSuitCurrentTrick;
            const hasLeadSuit = hand.some(c => gameLogic.getSuit(c) === leadCardSuit);
            if (hasLeadSuit && playedSuit !== leadCardSuit) return socket.emit("error", { message: `Must follow suit (${SUITS[leadCardSuit]}).` });
            if (!hasLeadSuit && hand.some(c => gameLogic.getSuit(c) === table.trumpSuit) && playedSuit !== table.trumpSuit) {
                return socket.emit("error", { message: "You must play trump if you cannot follow suit." });
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
    
            if (winnerInfo.playerName && !table.capturedTricks[winnerInfo.playerName]) table.capturedTricks[winnerInfo.playerName] = [];
            if(winnerInfo.playerName) table.capturedTricks[winnerInfo.playerName].push(table.currentTrickCards.map(p => p.card));
            
            if (table.tricksPlayedCount === 11) {
                gameLogic.calculateRoundScores(table, io, pool);
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
        if (!username || !table || !table.insurance.isActive || table.insurance.dealExecuted) return;
        
        const multiplier = table.insurance.bidMultiplier;
        const parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) return;

        if (settingType === 'bidderRequirement' && username === table.insurance.bidderPlayerName) {
            const minReq = -120 * multiplier; const maxReq = 120 * multiplier;
            if (parsedValue >= minReq && parsedValue <= maxReq) table.insurance.bidderRequirement = parsedValue;
        } else if (settingType === 'defenderOffer' && table.insurance.defenderOffers.hasOwnProperty(username)) {
            const minOffer = -60 * multiplier; const maxOffer = 60 * multiplier;
            if (parsedValue >= minOffer && parsedValue <= maxOffer) table.insurance.defenderOffers[username] = parsedValue;
        }

        const { bidderRequirement, defenderOffers } = table.insurance;
        if (bidderRequirement <= Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0)) {
            table.insurance.dealExecuted = true;
            table.insurance.executedDetails = { agreement: { bidderPlayerName: table.insurance.bidderPlayerName, bidderRequirement, defenderOffers: { ...defenderOffers } } };
        }
        emitTableUpdate(tableId);
    });

    socket.on("requestNextRound", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (table && table.state === "Awaiting Next Round Trigger" && socket.user.id === table.roundSummary?.dealerOfRoundId) {
            const helpers = { resetTable: (id) => state.resetTable(id, pool, { emitTableUpdate, emitLobbyUpdate }), getPlayerNameByUserId, initializeNewRoundState: state.initializeNewRoundState, shuffle };
            gameLogic.prepareNextRound(table, io, helpers);
        }
    });

    socket.on("requestDraw", ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.drawRequest.isActive || table.state !== 'Playing Phase') return;

        table.drawRequest.isActive = true;
        table.drawRequest.initiator = socket.username;
        table.drawRequest.votes = {};
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        activePlayers.forEach(p => {
            table.drawRequest.votes[p.playerName] = (p.playerName === socket.username) ? 'wash' : null;
        });

        table.drawRequest.timer = 30;
        const timerId = setInterval(() => {
            const currentTable = state.getTableById(tableId);
            if (!currentTable || !currentTable.drawRequest.isActive) {
                clearInterval(timerId);
                return;
            }
            currentTable.drawRequest.timer -= 1;
            if (currentTable.drawRequest.timer <= 0) {
                clearInterval(timerId);
                currentTable.drawRequest.isActive = false;
                io.to(tableId).emit("gameState", currentTable);
                io.to(tableId).emit("notification", { message: "Draw request timed out. Game resumes." });
            } else {
                emitTableUpdate(tableId);
            }
        }, 1000);
        emitTableUpdate(tableId);
    });

    socket.on("submitDrawVote", async ({ tableId, vote }) => {
        const table = state.getTableById(tableId);
        if (!table || !table.drawRequest.isActive || !['wash', 'split', 'no'].includes(vote) || table.drawRequest.votes[socket.username] !== null) return;
        
        table.drawRequest.votes[socket.username] = vote;
    
        if (vote === 'no') {
            table.drawRequest.isActive = false;
            emitTableUpdate(tableId);
            io.to(tableId).emit("notification", { message: `${socket.username} vetoed the draw. Game resumes.` });
            return;
        }
    
        const allVotes = Object.values(table.drawRequest.votes);
        if (allVotes.every(v => v !== null)) {
            table.drawRequest.isActive = false;
            
            const voteCounts = allVotes.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
            const tableCost = TABLE_COSTS[table.theme] || 0;
            const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
            let outcomeMessage = "Draw resolved.";
            const transactionPromises = [];
    
            if (voteCounts.wash === activePlayers.length) {
                outcomeMessage = "All players agreed to a wash. All buy-ins returned.";
                activePlayers.forEach(p => {
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p.userId, gameId: table.gameId, type: 'wash_payout', amount: tableCost, description: `Draw Outcome: Wash` }));
                });
            } else if (voteCounts.wash > 0 && voteCounts.split > 0) {
                outcomeMessage = "A split was agreed upon. Payouts calculated by score.";
                const payoutResult = gameLogic.calculateDrawSplitPayout(table);
                if (payoutResult && payoutResult.payouts) {
                    for (const playerName in payoutResult.payouts) {
                        const pData = payoutResult.payouts[playerName];
                        transactionPromises.push(transactionManager.postTransaction(pool, { userId: pData.userId, gameId: table.gameId, type: 'win_payout', amount: pData.totalReturn, description: `Draw Outcome: Split` }));
                    }
                }
            } else {
                outcomeMessage = "The draw resulted in a wash. All buy-ins returned.";
                activePlayers.forEach(p => {
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p.userId, gameId: table.gameId, type: 'wash_payout', amount: tableCost, description: `Draw Outcome: Wash (Default)` }));
                });
            }
            
            await Promise.all(transactionPromises);
            await transactionManager.updateGameRecordOutcome(pool, table.gameId, outcomeMessage);
    
            table.state = "Game Over";
            table.roundSummary = { message: outcomeMessage, isGameOver: true, finalScores: table.scores };
            emitTableUpdate(tableId);
            setTimeout(() => state.resetTable(tableId, pool, { emitTableUpdate, emitLobbyUpdate }), 5000);
        } else {
            emitTableUpdate(tableId);
        }
    });

    socket.on("resetGame", async ({ tableId }) => {
        await state.resetTable(tableId, pool, { emitTableUpdate, emitLobbyUpdate });
    });

    socket.on("disconnect", (reason) => {
        const userId = socket.userId;
        if (!userId) return;
        const table = Object.values(state.getAllTables()).find(t => t.players[userId]);
        if (table) {
            const playerInfo = table.players[userId];
            if (playerInfo && table.gameStarted && !playerInfo.isSpectator) {
                playerInfo.disconnected = true;
            } else if (playerInfo) {
                delete table.players[userId];
            }
            emitTableUpdate(table.tableId);
            emitLobbyUpdate();
        }
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
    
    const authRoutes = createAuthRoutes(pool, bcrypt, jwt);
    app.use('/api/auth', authRoutes);

    const leaderboardRoutes = createLeaderboardRoutes(pool);
    app.use('/api/leaderboard', leaderboardRoutes);

    const adminRouter = createAdminRoutes(pool);
    app.use('/api/admin', adminRouter);

    state.initializeGameTables();
  } catch (err) {
    console.error("❌ DATABASE CONNECTION FAILED:", err);
    process.exit(1);
  }
});
