// --- Backend/server.js (v6.1.0 - Corrected Merge) ---
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

const SERVER_VERSION = "6.1.0 - Corrected Merge";
let pool; 

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
const NUM_TABLES = 3;

// --- IN-MEMORY STATE ---
let tables = {};
let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- HELPER FUNCTIONS ---
const getLobbyState = () => Object.fromEntries(Object.entries(tables).map(([tableId, table]) => { const allPlayers = Object.values(table.players); const activePlayers = allPlayers.filter(p => !p.isSpectator); return [tableId, { tableId: table.tableId, state: table.state, players: activePlayers.map(p => ({ userId: p.userId, playerName: p.playerName, disconnected: p.disconnected })), playerCount: activePlayers.length, spectatorCount: allPlayers.length - activePlayers.length, }]; }));
const emitLobbyUpdate = () => io.emit("lobbyState", getLobbyState());
const emitTableUpdate = (tableId) => { if (tables[tableId]) io.to(tableId).emit("gameState", tables[tableId]); };
const getPlayerNameByUserId = (userId, table) => table?.players[userId]?.playerName || String(userId);
const getSuit = (cardStr) => cardStr ? cardStr.slice(-1) : null;
const getRank = (cardStr) => cardStr ? cardStr.slice(0, -1) : null;
const shuffle = (array) => { let currentIndex = array.length, randomIndex; while (currentIndex !== 0) { randomIndex = Math.floor(Math.random() * currentIndex); currentIndex--; [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]; } return array; };
const calculateCardPoints = (cardsArray) => { if (!cardsArray || cardsArray.length === 0) return 0; return cardsArray.reduce((sum, cardString) => sum + (CARD_POINT_VALUES[getRank(cardString)] || 0), 0); };
const getInitialInsuranceState = () => ({ isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0, defenderOffers: {}, dealExecuted: false, executedDetails: null });

const getInitialGameData = (tableId) => ({
    tableId: tableId, state: "Waiting for Players", players: {}, playerOrderActive: [], dealer: null, hands: {},
    widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [],
    currentHighestBidDetails: null, biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null,
    soloBidMadeAfterFrog: false, trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
    trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
    trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [], lastCompletedTrick: null,
    playersWhoPassedThisRound: [], playerMode: null, serverVersion: SERVER_VERSION, insurance: getInitialInsuranceState(),
});

const initializeGameTables = () => { for (let i = 1; i <= NUM_TABLES; i++) tables[`table-${i}`] = getInitialGameData(`table-${i}`); console.log("In-memory game tables initialized."); };

const createDbTables = async (dbPool) => {
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
        console.log("Database 'users' table is ready.");
    } catch (err) {
        console.error("Error creating database tables:", err);
        throw err; // Propagate error to stop server start if DB is not ready
    }
};

const resetTable = (tableId, keepPlayersAsSpectators = true) => {
    if (!tables[tableId]) return;
    const originalPlayers = { ...tables[tableId].players };
    const originalScores = { ...tables[tableId].scores };
    tables[tableId] = getInitialGameData(tableId);
    if (keepPlayersAsSpectators) {
        for (const userId in originalPlayers) {
            tables[tableId].players[userId] = { ...originalPlayers[userId], isSpectator: true, disconnected: originalPlayers[userId].disconnected };
            tables[tableId].scores[originalPlayers[userId].playerName] = originalScores[originalPlayers[userId].playerName] ?? 120;
        }
    }
    emitTableUpdate(tableId);
    emitLobbyUpdate();
};

const initializeNewRoundState = (table) => {
    Object.assign(table, {
        hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [], bidsThisRound: [],
        currentHighestBidDetails: null, trumpSuit: null, bidWinnerInfo: null, biddingTurnPlayerName: null,
        bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
        trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [],
        lastCompletedTrick: null, playersWhoPassedThisRound: [], insurance: getInitialInsuranceState(),
    });
    table.playerOrderActive.forEach(pName => { if (pName && table.scores[pName] !== undefined) table.capturedTricks[pName] = []; });
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
        const newUserQuery = `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email;`;
        const result = await pool.query(newUserQuery, [username, email, passwordHash]);
        res.status(201).json({ message: "User created successfully", user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') { return res.status(409).json({ message: "Username or email already exists." }); }
        console.error("Error during registration:", err);
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
        if (!user) { return res.status(401).json({ message: "Invalid credentials." }); }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) { return res.status(401).json({ message: "Invalid credentials." }); }
        const payload = { id: user.id, username: user.username };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({ message: "Logged in successfully", token: token, user: payload });
    } catch (err) {
        console.error("Error during login:", err);
        res.status(500).json({ message: "Server error during login." });
    }
});

// --- SOCKET.IO AUTHENTICATION MIDDLEWARE ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) { return next(new Error("Authentication error: No token provided.")); }
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) { return next(new Error("Authentication error: Invalid token.")); }
        socket.user = user; // Attach user payload to the socket object
        next();
    });
});

// --- MAIN SOCKET.IO CONNECTION HANDLER ---
io.on("connection", (socket) => {
    console.log(`Socket connected for user: ${socket.user.username} (ID: ${socket.user.id})`);
    
    socket.userId = socket.user.id; 

    for (const table of Object.values(tables)) {
        if (table.players[socket.userId]?.disconnected) {
            console.log(`Reconnecting user ${socket.user.username} to table ${table.tableId}`);
            table.players[socket.userId].disconnected = false;
            table.players[socket.userId].socketId = socket.id;
            socket.join(table.tableId);
            emitTableUpdate(table.tableId);
        }
    }

    socket.emit("lobbyState", getLobbyState());

    socket.on("joinTable", ({ tableId }) => {
        const table = tables[tableId];
        if (!table) return socket.emit("error", "Table not found.");
        const { id, username } = socket.user;

        if (table.gameStarted && !table.players[id]) {
            return socket.emit("error", "Game has already started.");
        }

        const previousTable = Object.values(tables).find(t => t.players[id]);
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

    socket.on("startGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table || table.gameStarted) return;
        const activePlayerIds = Object.keys(table.players).filter(id => !table.players[id].isSpectator && !table.players[id].disconnected);
        if (activePlayerIds.length < 3) return socket.emit("error", "Need at least 3 players to start.");
        
        table.gameStarted = true;
        table.playerMode = activePlayerIds.length;

        activePlayerIds.forEach(id => { 
            const pName = table.players[id].playerName;
            if (table.scores[pName] === undefined) table.scores[pName] = 120; 
        });

        if (table.playerMode === 3 && table.scores[PLACEHOLDER_ID] === undefined) {
            table.scores[PLACEHOLDER_ID] = 120;
        }

        const shuffledPlayerIds = shuffle(activePlayerIds.map(id => Number(id)));
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

        initializeNewRoundState(table);
        table.state = "Dealing Pending";
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("dealCards", ({ tableId }) => {
        const table = tables[tableId];
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
        const table = tables[tableId];
        const { id, username } = socket.user;
        if (!table || username !== table.biddingTurnPlayerName) return;
        
        if (table.state === "Awaiting Frog Upgrade Decision") {
            if (id !== table.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
            if (bid === "Heart Solo") {
                table.currentHighestBidDetails = { userId: id, playerName: username, bid: "Heart Solo" };
            }
            table.biddingTurnPlayerName = null;
            resolveBiddingFinal(table);
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
            checkForFrogUpgrade(table);
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
                checkForFrogUpgrade(table);
            }
        }
        emitTableUpdate(tableId);
    });

    socket.on("chooseTrump", ({ tableId, suit }) => {
        const table = tables[tableId];
        const { id } = socket.user;
        if(!table || table.state !== "Trump Selection" || table.bidWinnerInfo.userId !== id) return;
        if(!["S", "C", "D"].includes(suit)) return;
        table.trumpSuit = suit;
        transitionToPlayingPhase(table);
    });

    socket.on("submitFrogDiscards", ({ tableId, discards }) => {
        const table = tables[tableId];
        const { id, username } = socket.user;
        if(!table || table.state !== "Frog Widow Exchange" || table.bidWinnerInfo.userId !== id) return;
        if(!Array.isArray(discards) || discards.length !== 3) return;
        
        const currentHand = table.hands[username];
        if(!discards.every(card => currentHand.includes(card))) return socket.emit("error", "Invalid discard selection.");

        table.widowDiscardsForFrogBidder = discards;
        table.hands[username] = currentHand.filter(card => !discards.includes(card));
        transitionToPlayingPhase(table);
    });

    socket.on("playCard", ({ tableId, card }) => {
        const table = tables[tableId];
        if (!table) return;
        const { username, id } = socket.user;
        
        if (table.state !== "Playing Phase" || username !== table.trickTurnPlayerName) return;
        const hand = table.hands[username];
        if (!hand || !hand.includes(card)) return;

        const isLeading = table.currentTrickCards.length === 0;
        const playedSuit = getSuit(card);

        if (isLeading) {
            if (playedSuit === table.trumpSuit && !table.trumpBroken) {
                const isHandAllTrump = hand.every(c => getSuit(c) === table.trumpSuit);
                if (!isHandAllTrump) return socket.emit("error", "Cannot lead trump until it is broken.");
            }
        } else {
            const leadCardSuit = table.leadSuitCurrentTrick;
            const hasLeadSuit = hand.some(c => getSuit(c) === leadCardSuit);
            if (playedSuit !== leadCardSuit && hasLeadSuit) return socket.emit("error", `Must follow suit (${SUITS[leadCardSuit]}).`);
            if (!hasLeadSuit) {
                const hasTrump = hand.some(c => getSuit(c) === table.trumpSuit);
                if (hasTrump && playedSuit !== table.trumpSuit) return socket.emit("error", "You must play trump if you cannot follow suit.");
            }
        }

        table.hands[username] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ userId: id, playerName: username, card });
        if (isLeading) table.leadSuitCurrentTrick = playedSuit;
        if (playedSuit === table.trumpSuit) table.trumpBroken = true;

        const expectedCardsInTrick = table.playerOrderActive.length;
        if (table.currentTrickCards.length === expectedCardsInTrick) {
            const winnerInfo = determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            table.lastCompletedTrick = { cards: [...table.currentTrickCards], winnerName: winnerInfo.playerName };
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerInfo.playerName;

            if (winnerInfo.playerName) {
                if (!table.capturedTricks[winnerInfo.playerName]) table.capturedTricks[winnerInfo.playerName] = [];
                table.capturedTricks[winnerInfo.playerName].push(table.currentTrickCards.map(p => p.card));
            }
            
            if (table.tricksPlayedCount === 11) {
                calculateRoundScores(tableId);
            } else {
                table.state = "TrickCompleteLinger";
                emitTableUpdate(tableId);
                setTimeout(() => {
                    const currentTable = tables[tableId];
                    if (currentTable && currentTable.state === "TrickCompleteLinger") {
                        currentTable.currentTrickCards = [];
                        currentTable.leadSuitCurrentTrick = null;
                        currentTable.trickTurnPlayerName = winnerInfo.playerName;
                        currentTable.state = "Playing Phase";
                        emitTableUpdate(tableId);
                    }
                }, 2000);
            }
        } else {
            const currentTurnPlayerIndex = table.playerOrderActive.indexOf(username);
            table.trickTurnPlayerName = table.playerOrderActive[(currentTurnPlayerIndex + 1) % expectedCardsInTrick];
            emitTableUpdate(tableId);
        }
    });
    
    socket.on("requestNextRound", ({ tableId }) => {
        const table = tables[tableId];
        if (table && table.state === "Awaiting Next Round Trigger" && socket.user.id === table.roundSummary?.dealerOfRoundId) {
            prepareNextRound(tableId);
        } else {
            socket.emit("error", "Cannot start next round: Not the correct state or you are not the dealer.");
        }
    });

    socket.on("hardResetServer", () => {
        console.log(`[ADMIN] User ${socket.user.username} initiated a hard server reset.`);
        initializeGameTables();
        io.emit("forceDisconnectAndReset", "The game server was reset by an administrator.");
    });

    socket.on("disconnect", (reason) => {
        const userId = socket.userId;
        if (!userId) return;

        console.log(`Socket disconnected for user ID: ${userId}, Reason: ${reason}`);

        const table = Object.values(tables).find(t => t.players[userId]);
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
        resetTable(tableId, true);
    });
});

// --- CORE GAME LOGIC FUNCTIONS ---

function transitionToPlayingPhase(table) {
    table.state = "Playing Phase";
    table.tricksPlayedCount = 0;
    table.trumpBroken = false;
    table.currentTrickCards = [];
    table.leadSuitCurrentTrick = null;
    table.lastCompletedTrick = null;
    table.trickLeaderName = table.bidWinnerInfo.playerName;
    table.trickTurnPlayerName = table.bidWinnerInfo.playerName;
    emitTableUpdate(table.tableId);
}

function resolveBiddingFinal(table) {
    if (!table.currentHighestBidDetails) {
        table.state = "AllPassWidowReveal";
        emitTableUpdate(table.tableId);
        setTimeout(() => {
            const currentTable = tables[table.tableId];
            if(currentTable && currentTable.state === "AllPassWidowReveal"){
                prepareNextRound(currentTable.tableId);
            }
        }, 5000);
        return;
    }

    table.bidWinnerInfo = { ...table.currentHighestBidDetails };
    const bid = table.bidWinnerInfo.bid;

    if (bid === "Frog") { 
        table.trumpSuit = "H"; 
        table.state = "Frog Widow Exchange";
        table.revealedWidowForFrog = [...table.widow];
        const bidderHand = table.hands[table.bidWinnerInfo.playerName];
        table.hands[table.bidWinnerInfo.playerName] = [...bidderHand, ...table.widow];
    } 
    else if (bid === "Heart Solo") { 
        table.trumpSuit = "H"; 
        transitionToPlayingPhase(table);
    } 
    else if (bid === "Solo") { 
        table.state = "Trump Selection";
    }

    emitTableUpdate(table.tableId);
    table.originalFrogBidderId = null;
    table.soloBidMadeAfterFrog = false;
}

function checkForFrogUpgrade(table) {
    if (table.soloBidMadeAfterFrog) {
        table.state = "Awaiting Frog Upgrade Decision";
        table.biddingTurnPlayerName = getPlayerNameByUserId(table.originalFrogBidderId, table);
    } else {
        resolveBiddingFinal(table);
    }
    emitTableUpdate(table.tableId);
}

function determineTrickWinner(trickCards, leadSuit, trumpSuit) {
    let winningPlay = null;
    let highestTrumpPlay = null;
    let highestLeadSuitPlay = null;

    for (const play of trickCards) {
        const cardSuit = getSuit(play.card);
        const cardRankIndex = RANKS_ORDER.indexOf(getRank(play.card));

        if (cardSuit === trumpSuit) {
            if (!highestTrumpPlay || cardRankIndex > RANKS_ORDER.indexOf(getRank(highestTrumpPlay.card))) {
                highestTrumpPlay = play;
            }
        } else if (cardSuit === leadSuit) {
            if (!highestLeadSuitPlay || cardRankIndex > RANKS_ORDER.indexOf(getRank(highestLeadSuitPlay.card))) {
                highestLeadSuitPlay = play;
            }
        }
    }
    return highestTrumpPlay || highestLeadSuitPlay;
}

function calculateRoundScores(tableId) {
    const table = tables[tableId];
    if (!table || !table.bidWinnerInfo) return;

    const { bidWinnerInfo, playerOrderActive, playerMode, scores, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const bidType = bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;

    playerOrderActive.forEach(pName => {
        const capturedCards = (capturedTricks[pName] || []).flat();
        const playerTrickPoints = calculateCardPoints(capturedCards);
        if (pName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });

    if (bidType === "Frog") {
        bidderTotalCardPoints += calculateCardPoints(widowDiscardsForFrogBidder);
    } else if (bidType === "Solo") {
        bidderTotalCardPoints += calculateCardPoints(originalDealtWidow);
    } else if (bidType === "Heart Solo") {
        const widowPoints = calculateCardPoints(originalDealtWidow);
        if (table.trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += widowPoints;
        } else {
            defendersTotalCardPoints += widowPoints;
        }
    }

    let roundMessage = "";
    const pointsDelta = Math.abs(bidderTotalCardPoints - 60);
    const exchangeValue = pointsDelta * currentBidMultiplier;

    if (bidderTotalCardPoints > 60) {
        let totalPointsGained = 0;
        playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                scores[pName] -= exchangeValue;
                totalPointsGained += exchangeValue;
            }
        });
        scores[bidWinnerName] += totalPointsGained;
        roundMessage = `${bidWinnerName} succeeded, capturing ${bidderTotalCardPoints} points!`;
    } else {
        let totalPointsLost = 0;
        const opponents = playerOrderActive.filter(pName => pName !== bidWinnerName);
        opponents.forEach(oppName => {
            scores[oppName] += exchangeValue;
            totalPointsLost += exchangeValue;
        });

        if (playerMode === 4) {
            const dealerName = getPlayerNameByUserId(table.dealer, table);
            scores[dealerName] += exchangeValue;
            totalPointsLost += exchangeValue;
        } else {
             scores[PLACEHOLDER_ID] += exchangeValue;
             totalPointsLost += exchangeValue;
        }
        scores[bidWinnerName] -= totalPointsLost;
        roundMessage = `${bidWinnerName} failed, capturing only ${bidderTotalCardPoints} points.`;
    }

    let isGameOver = false;
    let gameWinner = null;
    if(Object.values(scores).filter(s => typeof s === 'number').some(score => score <= 0)) {
        isGameOver = true;
        const finalPlayerScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID);
        if (finalPlayerScores.length > 0) {
            gameWinner = finalPlayerScores.sort((a,b) => b[1] - a[1])[0][0];
        }
        roundMessage += ` GAME OVER! Winner: ${gameWinner}.`;
    }

    table.roundSummary = {
        message: roundMessage,
        bidWinnerName,
        bidderCardPoints: bidderTotalCardPoints,
        defenderCardPoints: defendersTotalCardPoints,
        finalScores: { ...scores },
        isGameOver,
        gameWinner,
        dealerOfRoundId: table.dealer,
        widowForReveal: table.originalDealtWidow,
    };
    
    table.state = isGameOver ? "Game Over" : "Awaiting Next Round Trigger";
    emitTableUpdate(tableId);
}

function prepareNextRound(tableId) {
    const table = tables[tableId];
    if (!table || !table.gameStarted) return;

    const allPlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator && !table.players[pId].disconnected).map(Number);
    if (allPlayerIds.length < 3) return resetTable(tableId, true);
    
    const lastDealerId = table.dealer;
    const lastDealerIndex = allPlayerIds.indexOf(lastDealerId);
    const nextDealerIndex = (lastDealerIndex + 1) % allPlayerIds.length;
    table.dealer = allPlayerIds[nextDealerIndex];
    
    const currentDealerIndex = allPlayerIds.indexOf(table.dealer);
    table.playerOrderActive = [];
    const numPlayers = allPlayerIds.length;
    for (let i = 1; i <= numPlayers; i++) {
        const playerIndex = (currentDealerIndex + i) % numPlayers;
        const playerId = allPlayerIds[playerIndex];
        if (table.playerMode === 4 && playerId === table.dealer) continue;
        table.playerOrderActive.push(getPlayerNameByUserId(playerId, table));
    }

    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    emitTableUpdate(tableId);
}


// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`);
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pool.connect();
    console.log("✅ Database connection successful.");
    await createDbTables(pool);
    initializeGameTables();
  } catch (err) {
    console.error("❌ DATABASE CONNECTION FAILED:", err);
    process.exit(1);
  }
});
