// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid'); // Import UUID for persistent player IDs

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "4.2.0 - Fully Refactored Game Logic"; // UPDATED SERVER VERSION
console.log(`LOBBY SERVER (${SERVER_VERSION}): Initializing...`);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['polling', 'websocket']
});

io.engine.on("connection_error", (err) => {
  console.error(`!!!! [${SERVER_VERSION} ENGINE EVENT] Connection Error !!!!`);
  console.error(`!!!!    Error Code: ${err.code}`);
  console.error(`!!!!    Error Message: ${err.message}`);
  if (err.context) console.error(`!!!!    Error Context:`, err.context);
});

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

// --- Game Constants ---
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"];
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];
const BID_MULTIPLIERS = { "Frog": 1, "Solo": 2, "Heart Solo": 3 };
const PLACEHOLDER_ID = "ScoreAbsorber";

const deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- Global State Management ---
let tables = {};      // Stores the game state for each table, keyed by tableId.
let players = {};     // Stores global player data, keyed by a persistent playerId.

// --- Helper Functions ---
const getInitialInsuranceState = () => ({ isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0, defenderOffers: {}, dealExecuted: false, executedDetails: null });

const getInitialGameData = (tableId) => ({
    tableId: tableId,
    state: "Waiting for Players to Join",
    players: {}, // { playerId: { name, disconnected: false } }
    playerIds: [], // The ordered list of persistent playerIds for the game instance
    playerOrderActive: [],
    dealer: null, // playerId
    hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [],
    scores: {}, bidsThisRound: [], currentHighestBidDetails: null, biddingTurnPlayerName: null,
    bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
    trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
    trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
    trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
    revealedWidowForFrog: [], lastCompletedTrick: null, playersWhoPassedThisRound: [],
    playerMode: null, serverVersion: SERVER_VERSION,
    insurance: getInitialInsuranceState(),
    spectators: {} // { playerId: name }
});

const initializeTables = () => {
    for (let i = 1; i <= 3; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log(`LOBBY SERVER (${SERVER_VERSION}): ${Object.keys(tables).length} tables initialized.`);
};

const getLobbyInfo = () => {
    const lobbyInfo = {};
    for (const tableId in tables) {
        const table = tables[tableId];
        lobbyInfo[tableId] = {
            tableId: table.tableId,
            playerCount: Object.values(table.players).filter(p => !p.disconnected).length,
            spectatorCount: Object.keys(table.spectators).length,
            state: table.state,
            playerNames: Object.values(table.players).map(p => p.name)
        };
    }
    return lobbyInfo;
};

const getPlayerNameById = (playerId, table) => {
    if (table && table.players[playerId]) return table.players[playerId].name;
    if (players[playerId]) return players[playerId].name;
    return playerId;
};

const shuffle = (array) => {
  let currentIndex = array.length,  randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
};

const calculateCardPoints = (cardsArray) => {
    if (!cardsArray || cardsArray.length === 0) return 0;
    return cardsArray.reduce((sum, cardString) => {
        const rank = cardString ? cardString.slice(0, -1) : null;
        return sum + (CARD_POINT_VALUES[rank] || 0);
    }, 0);
};

const initializeNewRoundState = (table) => {
    table.hands = {}; table.widow = []; table.originalDealtWidow = [];
    table.widowDiscardsForFrogBidder = []; table.bidsThisRound = [];
    table.currentHighestBidDetails = null; table.trumpSuit = null;
    table.bidWinnerInfo = null; table.biddingTurnPlayerName = null;
    table.bidsMadeCount = 0; table.originalFrogBidderId = null;
    table.soloBidMadeAfterFrog = false; table.currentTrickCards = [];
    table.trickTurnPlayerName = null; table.tricksPlayedCount = 0;
    table.leadSuitCurrentTrick = null; table.trumpBroken = false;
    table.trickLeaderName = null; table.capturedTricks = {};
    table.roundSummary = null; table.revealedWidowForFrog = [];
    table.lastCompletedTrick = null; table.playersWhoPassedThisRound = [];
    table.insurance = getInitialInsuranceState();
    const playersToInitTricksFor = table.playerOrderActive.length > 0 ? table.playerOrderActive : Object.values(table.players).map(p => p.name);
    playersToInitTricksFor.forEach(pName => {
        if (pName && table.scores && table.scores[pName] !== undefined) table.capturedTricks[pName] = [];
    });
};

const resetTableData = (tableId) => {
    if (!tables[tableId]) return;
    console.log(`[${SERVER_VERSION}] Performing full data reset for ${tableId}.`);
    const oldTable = { ...tables[tableId] };
    tables[tableId] = getInitialGameData(tableId);
    
    // Players who were playing are moved to spectators
    Object.keys(oldTable.players).forEach(pId => {
       if (players[pId]) tables[tableId].spectators[pId] = players[pId].name;
    });
    // Spectators remain spectators
    Object.keys(oldTable.spectators).forEach(pId => {
        if(players[pId] && !tables[tableId].spectators[pId]) tables[tableId].spectators[pId] = players[pId].name;
    });
};

const determineTrickWinner = (trickCards, leadSuit, trumpSuit) => {
    if (!trickCards || trickCards.length === 0) return null;
    let winningPlay = null;
    let highestTrumpPlay = null;
    let highestLeadSuitPlay = null;
    const getRank = (cardStr) => cardStr ? cardStr.slice(0, -1) : null;
    const getSuit = (cardStr) => cardStr ? cardStr.slice(-1) : null;
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
    if (highestTrumpPlay) winningPlay = highestTrumpPlay;
    else if (highestLeadSuitPlay) winningPlay = highestLeadSuitPlay;
    return winningPlay ? winningPlay.playerId : null; // Return the playerId of the winner
};

const transitionToPlayingPhase = (table) => {
    table.state = "Playing Phase";
    table.tricksPlayedCount = 0;
    table.trumpBroken = false;
    table.currentTrickCards = [];
    table.leadSuitCurrentTrick = null;
    table.lastCompletedTrick = null;

    if (table.bidWinnerInfo && table.bidWinnerInfo.playerId && table.bidWinnerInfo.bid) {
        const bidWinnerName = getPlayerNameById(table.bidWinnerInfo.playerId, table);
        table.trickLeaderName = bidWinnerName;
        table.trickTurnPlayerName = bidWinnerName;
        // Insurance logic can be activated here as before
    } else {
        console.error(`[${SERVER_VERSION} ERROR] Cannot transition to playing phase: bidWinnerInfo missing on table ${table.tableId}.`);
        table.state = "Error - Bid Winner Not Set for Play";
    }
    io.to(table.tableId).emit("gameState", table);
};

// --- Main Connection Handler ---
io.on("connection", (socket) => {
    console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}`);
    socket.emit("connectionEstablished");

    socket.on("requestPlayerId", (existingPlayerId) => {
        let pId = existingPlayerId;
        if (pId && players[pId]) {
            players[pId].socketId = socket.id;
            const tableId = players[pId].currentTableId;
            if (tableId && tables[tableId] && tables[tableId].players[pId]) {
                tables[tableId].players[pId].disconnected = false;
                socket.join(tableId);
                io.to(tableId).emit("gameState", tables[tableId]);
                io.emit("lobbyInfo", getLobbyInfo());
            } else if (tableId && tables[tableId] && tables[tableId].spectators[pId]){
                socket.join(tableId);
                io.to(tableId).emit("gameState", tables[tableId]);
            }
        } else {
            pId = uuidv4();
            players[pId] = { name: null, socketId: socket.id, currentTableId: null };
        }
        socket.emit("playerInfo", { playerId: pId, name: players[pId].name });
        socket.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("submitName", ({ name, playerId }) => {
        if (!players[playerId]) return socket.emit("error", "Invalid player session. Please refresh.");
        if (Object.values(players).some(p => p.name === name && p.socketId !== socket.id)) return socket.emit("error", "Name is already in use.");
        players[playerId].name = name;
        socket.emit("playerInfo", { playerId, name });
        io.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("joinTable", ({ tableId, playerId }) => {
        const table = tables[tableId];
        const player = players[playerId];
        if (!table || !player || !player.name) return socket.emit("error", "Cannot join table: Invalid data.");

        if (player.currentTableId && player.currentTableId !== tableId) return socket.emit("error", "You must leave your current table first.");
        
        player.currentTableId = tableId;
        socket.join(tableId);
        
        const canJoinAsPlayer = Object.keys(table.players).length < 4 && !table.gameStarted;
        if (canJoinAsPlayer) {
            if (!table.players[playerId]) {
                table.players[playerId] = { name: player.name, disconnected: false };
                table.playerIds.push(playerId);
                table.scores[player.name] = 120;
                if (table.spectators[playerId]) delete table.spectators[playerId];
            }
        } else {
            if (!table.spectators[playerId] && !table.players[playerId]) {
                table.spectators[playerId] = player.name;
            }
        }
        
        const numPlayers = Object.keys(table.players).length;
        if (!table.gameStarted) {
            if (numPlayers >= 3) table.state = "Ready to Start 3P or Wait";
            if (numPlayers === 4) table.state = "Ready to Start 4P";
        }

        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    socket.on("leaveTable", ({tableId, playerId}) => {
        const table = tables[tableId];
        const player = players[playerId];
        if (!table || !player) return;

        socket.leave(tableId);
        player.currentTableId = null;

        if(table.players[playerId]){
            if(table.gameStarted){
                table.players[playerId].disconnected = true;
            } else {
                delete table.players[playerId];
                table.playerIds = table.playerIds.filter(id => id !== playerId);
                delete table.scores[player.name];
            }
        }
        if(table.spectators[playerId]) delete table.spectators[playerId];

        const numPlayers = Object.values(table.players).filter(p => !p.disconnected).length;
        if (!table.gameStarted) {
            if (numPlayers < 3) table.state = "Waiting for Players to Join";
            else if (numPlayers === 3) table.state = "Ready to Start 3P or Wait";
        }
        
        socket.emit("gameState", null);
        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });

    // --- Fully Refactored Game Event Handlers ---
    
    // START GAME (3-Player)
    socket.on("startThreePlayerGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table || table.gameStarted) return;
        if (Object.keys(table.players).length !== 3) return socket.emit("error", "Need 3 players for this mode.");
        
        table.playerMode = 3; 
        table.gameStarted = true;
        table.playerIds = shuffle([...table.playerIds]);
        table.dealer = table.playerIds[0];
        table.playerOrderActive = [];
        const dealerIndex = table.playerIds.indexOf(table.dealer);
        for (let i = 0; i < 3; i++) {
             const pId = table.playerIds[(dealerIndex + i + 1) % 3];
             table.playerOrderActive.push(table.players[pId].name);
        }
        if (table.scores[PLACEHOLDER_ID] === undefined) table.scores[PLACEHOLDER_ID] = 120;
        initializeNewRoundState(table); 
        table.state = "Dealing Pending";
        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });

    // START GAME (4-Player)
    socket.on("startGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table || table.gameStarted) return;
        if (Object.keys(table.players).length !== 4) return socket.emit("error", "Need 4 players for this mode.");

        table.playerMode = 4; 
        table.gameStarted = true;
        table.playerIds = shuffle([...table.playerIds]);
        table.dealer = table.playerIds[0];
        table.playerOrderActive = [];
        const dealerIndex = table.playerIds.indexOf(table.dealer);
        for (let i = 1; i <= 3; i++) {
            const pId = table.playerIds[(dealerIndex + i) % 4];
            table.playerOrderActive.push(table.players[pId].name);
        }
        initializeNewRoundState(table); 
        table.state = "Dealing Pending";
        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    // DEAL CARDS
    socket.on("dealCards", ({ tableId, playerId }) => {
        const table = tables[tableId];
        if (!table || table.state !== "Dealing Pending" || !table.dealer || playerId !== table.dealer) return socket.emit("error", "Not dealer or not dealing phase.");
        
        const shuffledDeck = shuffle([...deck]);
        table.playerOrderActive.forEach((activePName, i) => {
            if (activePName) table.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        const cardsDealtToPlayers = 11 * table.playerOrderActive.length;
        table.widow = shuffledDeck.slice(cardsDealtToPlayers, cardsDealtToPlayers + 3);
        table.originalDealtWidow = [...table.widow];
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        io.to(tableId).emit("gameState", table);
    });

    // PLACE BID
    socket.on("placeBid", ({ tableId, playerId, bid }) => {
        const table = tables[tableId];
        const pName = getPlayerNameById(playerId, table);
        if (!table || !pName) return;

        if (table.state === "Bidding Phase") {
            if (pName !== table.biddingTurnPlayerName || table.playersWhoPassedThisRound.includes(pName)) return;

            const currentHighestBidIndex = table.currentHighestBidDetails ? BID_HIERARCHY.indexOf(table.currentHighestBidDetails.bid) : -1;
            if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;

            table.bidsThisRound.push({ playerId, playerName: pName, bid });
            if (bid !== "Pass") {
                table.currentHighestBidDetails = { playerId, playerName: pName, bid };
            } else {
                table.playersWhoPassedThisRound.push(pName);
            }

            const activeBiddersRemaining = table.playerOrderActive.filter(name => !table.playersWhoPassedThisRound.includes(name));
            if (activeBiddersRemaining.length <= 1) {
                // End of Bidding Logic
                table.bidWinnerInfo = table.currentHighestBidDetails;
                if (!table.bidWinnerInfo) {
                    table.state = "Round Skipped"; // Handle all pass scenario
                } else if (table.bidWinnerInfo.bid === "Frog") {
                    table.trumpSuit = "H";
                    table.state = "FrogBidderConfirmWidow";
                } else if (table.bidWinnerInfo.bid === "Heart Solo") {
                    table.trumpSuit = "H";
                    transitionToPlayingPhase(table);
                } else { // Solo
                    table.state = "Trump Selection";
                }
            } else {
                let currentBidderIndex = table.playerOrderActive.indexOf(pName);
                let nextBidderIndex = (currentBidderIndex + 1) % table.playerOrderActive.length;
                while(table.playersWhoPassedThisRound.includes(table.playerOrderActive[nextBidderIndex])) {
                    nextBidderIndex = (nextBidderIndex + 1) % table.playerOrderActive.length;
                }
                table.biddingTurnPlayerName = table.playerOrderActive[nextBidderIndex];
            }
        }
        io.to(tableId).emit("gameState", table);
    });

    // PLAY CARD
    socket.on("playCard", ({ tableId, playerId, card }) => {
        const table = tables[tableId];
        const pName = getPlayerNameById(playerId, table);
        if (!table || !pName || table.state !== "Playing Phase" || pName !== table.trickTurnPlayerName) return;

        const hand = table.hands[pName];
        if (!hand || !hand.includes(card)) return;

        // Simplified validation logic (can be expanded)
        table.hands[pName] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ playerId, playerName: pName, card });

        if (table.currentTrickCards.length === table.playerOrderActive.length) {
            // Trick is complete, determine winner
            const winnerId = determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            const winnerName = getPlayerNameById(winnerId, table);
            if (winnerName && table.capturedTricks[winnerName]) {
                table.capturedTricks[winnerName].push([...table.currentTrickCards.map(p => p.card)]);
            } else if (winnerName) {
                table.capturedTricks[winnerName] = [[...table.currentTrickCards.map(p => p.card)]];
            }
            
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerName;

            if (table.tricksPlayedCount === 11) {
                // End of round scoring
                // calculateRoundScores(table);
                table.state = "Awaiting Next Round Trigger"; // Placeholder
            } else {
                // Start next trick
                table.currentTrickCards = [];
                table.trickTurnPlayerName = winnerName;
            }
        } else {
            // Next player's turn in the trick
            const currentTurnIndex = table.playerOrderActive.indexOf(pName);
            table.trickTurnPlayerName = table.playerOrderActive[(currentTurnIndex + 1) % table.playerOrderActive.length];
        }
        io.to(tableId).emit("gameState", table);
    });

    // ... Other handlers like 'chooseTrump', 'submitFrogDiscards', etc. would follow the same pattern ...
    
    // BOOT & SEAT MANAGEMENT
    socket.on("bootPlayer", ({tableId, playerIdToBoot}) => {
        const table = tables[tableId];
        if(!table || !table.players[playerIdToBoot] || !table.players[playerIdToBoot].disconnected) return;

        const bootedPlayerName = table.players[playerIdToBoot].name;
        delete table.players[playerIdToBoot];
        table.playerIds = table.playerIds.filter(id => id !== playerIdToBoot);
        delete table.scores[bootedPlayerName];
        if(players[playerIdToBoot]) table.spectators[playerIdToBoot] = bootedPlayerName;

        if(table.gameStarted) resetTableData(tableId);
        
        io.to(tableId).emit("gameState", tables[tableId]);
        io.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("takeSeat", ({tableId, playerId}) => {
        const table = tables[tableId];
        const player = players[playerId];
        if(!table || !player || !table.spectators[playerId] || table.gameStarted) return;
        if(Object.keys(table.players).length >= 4) return;

        delete table.spectators[playerId];
        table.players[playerId] = {name: player.name, disconnected: false};
        table.playerIds.push(playerId);
        table.scores[player.name] = 120;
        
        const numPlayers = Object.keys(table.players).length;
        if (numPlayers >= 3) table.state = "Ready to Start 3P or Wait";
        if (numPlayers === 4) table.state = "Ready to Start 4P";

        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    // DISCONNECT
    socket.on("disconnect", (reason) => {
        let disconnectedPlayerId = null;
        for (const pId in players) {
            if (players[pId].socketId === socket.id) {
                disconnectedPlayerId = pId;
                break;
            }
        }

        if (disconnectedPlayerId) {
            const player = players[disconnectedPlayerId];
            console.log(`[${SERVER_VERSION} DISCONNECT] Player ${player.name || 'N/A'} (ID: ${disconnectedPlayerId}) disconnected. Reason: ${reason}`);
            const tableId = player.currentTableId;
            if (tableId && tables[tableId] && tables[tableId].players[disconnectedPlayerId]) {
                tables[tableId].players[disconnectedPlayerId].disconnected = true;
                io.to(tableId).emit("gameState", tables[tableId]);
                io.emit("lobbyInfo", getLobbyInfo());
            }
        }
    });

    socket.on("requestBootAll", ({tableId}) => {
        if(!tables[tableId]) return;
        resetTableData(tableId); 
        io.to(tableId).emit("gameState", tables[tableId]);
        io.emit("lobbyInfo", getLobbyInfo());
    });
});


// --- Server Listening ---
initializeTables();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });
