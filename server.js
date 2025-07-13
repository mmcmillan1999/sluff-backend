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
            const tableCost = TABLE_COSTS[table.theme] || 0;
            transactionPromises.push(transactionManager.postTransaction(pool, {
                userId: forfeitingPlayer.userId, gameId: table.gameId, type: 'forfeit_loss',
                amount: -tableCost, description: `Forfeited game on table ${table.tableName}`
            }));
        }

        remainingPlayers.forEach(player => {
            const payoutInfo = tokenChanges[player.playerName];
            if (payoutInfo && payoutInfo.totalGain > 0) {
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
                console.log(`[SYNC] Sent updated user data to ${updatedUser.username}.`);
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
            return socket.emit("error", "Cannot start timer: Player is not disconnected.");
        }

        console.log(`[${tableId}] Timeout clock started for ${targetPlayerName} by ${socket.user.username}.`);
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
                userId: socket.user.id,
                gameId: null,
                type: 'free_token_mercy',
                amount: 1,
                description: 'Mercy token requested by user'
            });
            socket.emit("requestUserSync");
        } catch (err) {
            console.error("Error giving free token:", err);
            socket.emit("error", "Could not grant token.");
        }
    });

    socket.on("sacrificeToken", async () => {
        try {
             await transactionManager.postTransaction(pool, {
                userId: socket.user.id,
                gameId: null,
                type: 'admin_adjustment',
                amount: -1,
                description: 'User sacrificed a token to the gods of Sluff.'
            });
            socket.emit("requestUserSync");
        } catch (err) {
            console.error("Error sacrificing token:", err);
            socket.emit("error", "Could not sacrifice token.");
        }
    });

    socket.on("joinTable", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table) return socket.emit("error", "Table not found.");
        
        const { id, username } = socket.user;
        const isPlayerAlreadyInGame = table.players[id];
        if (!isPlayerAlreadyInGame) {
            const tableCost = TABLE_COSTS[table.theme] || 0;
            try {
                const tokenResult = await pool.query("SELECT SUM(amount) as tokens FROM transactions WHERE user_id = $1", [id]);
                const userTokens = parseFloat(tokenResult.rows[0].tokens || 0);

                if (userTokens < tableCost) {
                    return socket.emit("error", `You need ${tableCost} tokens to join. You have ${userTokens.toFixed(2)}.`);
                }
            } catch (err) {
                console.error("Database error during joinTable token check:", err);
                return socket.emit("error", "A server error occurred trying to join the table.");
            }
        }

        if (table.gameStarted && !isPlayerAlreadyInGame) {
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
                const userIdToNameMap = Object.values(table.players).reduce((acc, player) => {
                    acc[player.userId] = player.playerName;
                    return acc;
                }, {});

                tokenResult.rows.forEach(row => {
                    const playerName = userIdToNameMap[row.user_id];
                    if (playerName) {
                        playerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2);
                    }
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

    // --- CORRECTED startGame HANDLER ---
    socket.on("startGame", async ({ tableId }) => {
        const table = state.getTableById(tableId);
        if (!table || table.gameStarted) return;
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        if (activePlayers.length < 3) {
            return socket.emit("error", "Need at least 3 players to start.");
        }
        
        // FIX: Set playerMode and get IDs before database calls
        table.playerMode = activePlayers.length;
        const activePlayerIds = activePlayers.map(p => p.userId);
        
        try {
            // Now create the record, after playerMode is set
            const gameId = await transactionManager.createGameRecord(pool, table);
            table.gameId = gameId;

            // Use the robust transaction handler
            await transactionManager.handleGameStartTransaction(pool, activePlayerIds, gameId);
            
            // Set up the rest of the game state
            table.gameStarted = true;
            activePlayers.forEach(p => { if (table.scores[p.playerName] === undefined) table.scores[p.playerName] = 120; });
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
            
            // Re-fetch token balances AFTER the transaction and attach them
            try {
                const tokenQuery = `SELECT user_id, SUM(amount) as tokens FROM transactions WHERE user_id = ANY($1::int[]) GROUP BY user_id;`;
                const tokenResult = await pool.query(tokenQuery, [activePlayerIds]);
                
                const playerTokens = {};
                const userIdToNameMap = activePlayers.reduce((acc, player) => {
                    acc[player.userId] = player.playerName;
                    return acc;
                }, {});

                tokenResult.rows.forEach(row => {
                    const playerName = userIdToNameMap[row.user_id];
                    if (playerName) {
                        playerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2);
                    }
                });
                table.playerTokens = playerTokens;
            } catch (err) {
                console.error(`Error fetching tokens after game start for table ${tableId}:`, err);
            }

            // Emit the final, updated state
            emitTableUpdate(tableId);
            emitLobbyUpdate();
            console.log(`Game ${gameId} successfully started on table ${tableId}`);

        } catch (err) {
            console.error("Error during startGame:", err);
            socket.emit("error", { message: err.message || "A server error occurred during buy-in." });
            // Reset state if start fails
            table.gameStarted = false; 
            table.playerMode = null;
            return;
        }
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

    socket.on("hardResetServer", ({ secret }) => {
        const correctSecret = "Mouse_4357835210";
        if (secret === correctSecret) {
            console.log(`[ADMIN] User ${socket.user.username} initiated a successful hard server reset.`);
            state.initializeGameTables();
            io.emit("forceDisconnectAndReset", "The game server was reset by an administrator.");
        } else {
            console.log(`[ADMIN] User ${socket.user.username} failed a hard server reset attempt.`);
            socket.emit("error", "Incorrect secret for server reset.");
        }
    });

    socket.on("resetAllTokens", async ({ secret }) => {
        const correctSecret = "Ben_Celica_2479_Gines";
        if (secret !== correctSecret) {
            console.log(`[ADMIN] User ${socket.user.username} failed a token reset attempt.`);
            return socket.emit("error", "Incorrect secret for token reset.");
        }
        try {
            console.log(`[ADMIN] User ${socket.user.username} initiated a successful token reset.`);
            const STARTING_TOKENS = 8.00;
    
            await pool.query("TRUNCATE TABLE transactions, game_history RESTART IDENTITY;");
    
            const usersResult = await pool.query("SELECT id FROM users;");
            const allUsers = usersResult.rows;
    
            const startingBalancePromises = allUsers.map(user => {
                return transactionManager.postTransaction(pool, {
                    userId: user.id,
                    gameId: null,
                    type: 'admin_adjustment',
                    amount: STARTING_TOKENS,
                    description: `Season Reset - Starting Balance`
                });
            });
            await Promise.all(startingBalancePromises);
            
            console.log(`Granted ${STARTING_TOKENS} tokens to ${allUsers.length} users.`);
    
            const allSockets = await io.fetchSockets();
            for (const sock of allSockets) {
                const userQuery = "SELECT id, username, email, created_at, wins, losses, washes FROM users WHERE id = $1";
                const userResult = await pool.query(userQuery, [sock.userId]);
                const updatedUser = userResult.rows[0];
    
                if (updatedUser) {
                    const tokenQuery = "SELECT SUM(amount) AS current_tokens FROM transactions WHERE user_id = $1";
                    const tokenResult = await pool.query(tokenQuery, [sock.userId]);
                    updatedUser.tokens = parseFloat(tokenResult.rows[0].current_tokens || 0).toFixed(2);
                    
                    sock.emit("updateUser", updatedUser);
                }
            }
            emitLobbyUpdate();
    
        } catch (err) {
            console.error("Error during token reset:", err);
            socket.emit("error", "Server error during token reset.");
        }
    });

    socket.on("disconnect", (reason) => {
        const userId = socket.userId;
        if (!userId) return;
        console.log(`Socket disconnected for user ID: ${userId}, Reason: ${reason}`);
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
    
    // Setup routes
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
})