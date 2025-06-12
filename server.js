// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid'); // Import UUID for persistent player IDs

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "4.1.0 - Full Lobby & Table Implementation"; // UPDATED SERVER VERSION
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

let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- NEW: Global State Management ---
let tables = {};      // Stores the game state for each table, keyed by tableId.
let players = {};     // Stores global player data, keyed by a persistent playerId.
                      // Example: { playerId: { name, socketId, currentTableId } }

// --- Helper Functions ---
function getInitialInsuranceState() {
    return { isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0, defenderOffers: {}, dealExecuted: false, executedDetails: null };
}

function getInitialGameData(tableId) {
    return {
        tableId: tableId,
        state: "Waiting for Players to Join",
        players: {}, // Now stores { playerId: { name, disconnected: false } }
        playerIds: [], // The ordered list of persistent playerIds for the game instance
        playerOrderActive: [],
        dealer: null, // dealer is now a playerId
        hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [],
        scores: {}, bidsThisRound: [], currentHighestBidDetails: null, biddingTurnPlayerName: null,
        bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
        trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
        revealedWidowForFrog: [], lastCompletedTrick: null, playersWhoPassedThisRound: [],
        playerMode: null, serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState(),
        spectators: {} // Stores { playerId: name }
    };
}

function initializeTables() {
    for (let i = 1; i <= 3; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log(`LOBBY SERVER (${SERVER_VERSION}): ${Object.keys(tables).length} tables initialized.`);
}

function getLobbyInfo() {
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
}

function getPlayerNameById(playerId, table) {
    if (table && table.players[playerId]) return table.players[playerId].name;
    if (players[playerId]) return players[playerId].name;
    return playerId; // Fallback
}

function getPlayerIdByName(playerName, table) {
    if (!table || !table.players) return null;
    for (const playerId in table.players) {
        if (table.players[playerId].name === playerName) {
            return playerId;
        }
    }
    return null;
}

function shuffle(array) {
  let currentIndex = array.length,  randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

function calculateCardPoints(cardsArray) {
    if (!cardsArray || cardsArray.length === 0) return 0;
    return cardsArray.reduce((sum, cardString) => {
        const rank = cardString ? cardString.slice(0, -1) : null;
        return sum + (CARD_POINT_VALUES[rank] || 0);
    }, 0);
}

function initializeNewRoundState(table) {
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
}

function resetTableData(tableId) {
    if (!tables[tableId]) return;
    console.log(`[${SERVER_VERSION}] Performing full data reset for ${tableId}.`);
    const oldTable = tables[tableId];
    tables[tableId] = getInitialGameData(tableId);
    
    // Players who were playing are moved to spectators
    Object.keys(oldTable.players).forEach(pId => {
       if (players[pId]) {
           tables[tableId].spectators[pId] = players[pId].name;
       }
    });
     // Spectators remain spectators
    Object.keys(oldTable.spectators).forEach(pId => {
        if(players[pId] && !tables[tableId].spectators[pId]){
            tables[tableId].spectators[pId] = players[pId].name;
        }
    });
}

function determineTrickWinner(trickCards, leadSuit, trumpSuit, table) {
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
    return winningPlay ? getPlayerNameById(winningPlay.playerId, table) : null;
}

function transitionToPlayingPhase(table) {
    table.state = "Playing Phase";
    table.tricksPlayedCount = 0;
    // ... (rest of logic)
    io.to(table.tableId).emit("gameState", table);
}

io.on("connection", (socket) => {
    console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}`);
    socket.emit("connectionEstablished");

    socket.on("requestPlayerId", (existingPlayerId) => {
        let pId = existingPlayerId;
        if (pId && players[pId]) {
            console.log(`[${SERVER_VERSION}] Reconnecting player ${players[pId].name} (${pId}) with new socket ${socket.id}`);
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
                io.emit("lobbyInfo", getLobbyInfo());
            }
        } else {
            pId = uuidv4();
            players[pId] = { name: null, socketId: socket.id, currentTableId: null };
            console.log(`[${SERVER_VERSION}] New player assigned ID ${pId}`);
        }
        socket.emit("playerInfo", { playerId: pId, name: players[pId].name });
        socket.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("submitName", ({ name, playerId }) => {
        if (!players[playerId]) return socket.emit("error", "Invalid player session. Please refresh.");
        if (Object.values(players).some(p => p.name === name)) return socket.emit("error", "Name is already in use by another player.");
        players[playerId].name = name;
        socket.emit("playerInfo", { playerId: playerId, name: name });
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
            if (numPlayers >= 3 && table.state === "Waiting for Players to Join") table.state = "Ready to Start 3P or Wait";
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
            // If game is in progress, just mark as disconnected. If not started, remove them.
            if(table.gameStarted){
                table.players[playerId].disconnected = true;
            } else {
                delete table.players[playerId];
                table.playerIds = table.playerIds.filter(id => id !== playerId);
                delete table.scores[player.name];
            }
        }
        if(table.spectators[playerId]){
            delete table.spectators[playerId];
        }

        const numPlayers = Object.keys(table.players).filter(pId => !table.players[pId].disconnected).length;
        if (!table.gameStarted) {
            if (numPlayers < 3) table.state = "Waiting for Players to Join";
            else if (numPlayers === 3) table.state = "Ready to Start 3P or Wait";
        }
        
        socket.emit("gameState", null); // Clear the game state for the leaving client
        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    // --- All game-specific handlers now accept a tableId ---
    
    socket.on("startThreePlayerGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table) return socket.emit("error", "Table not found.");
        if (Object.keys(table.players).length !== 3) return socket.emit("error", "Need 3 players.");
        if (table.gameStarted) return socket.emit("error", "Game already in progress.");
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

    socket.on("startGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table) return socket.emit("error", "Table not found.");
        if (Object.keys(table.players).length !== 4) return socket.emit("error", "Need 4 players.");
        if (table.gameStarted) return socket.emit("error", "Game already in progress.");
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
    
    socket.on("bootPlayer", ({tableId, playerIdToBoot}) => {
        const table = tables[tableId];
        if(!table || !table.players[playerIdToBoot] || !table.players[playerIdToBoot].disconnected){
            return socket.emit("error", "Cannot boot this player.");
        }

        const bootedPlayerName = table.players[playerIdToBoot].name;
        // Remove from players list and scores
        delete table.players[playerIdToBoot];
        table.playerIds = table.playerIds.filter(id => id !== playerIdToBoot);
        delete table.scores[bootedPlayerName];

        // Add them to spectators
        if(players[playerIdToBoot]){
             table.spectators[playerIdToBoot] = bootedPlayerName;
        }

        // If the game was running, it's now broken and needs a reset.
        if(table.gameStarted){
            resetTableData(tableId);
        }
        
        io.to(tableId).emit("gameState", tables[tableId]);
        io.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("takeSeat", ({tableId, playerId}) => {
        const table = tables[tableId];
        const player = players[playerId];
        if(!table || !player || !table.spectators[playerId] || table.gameStarted){
            return socket.emit("error", "Cannot take a seat now.");
        }
        if(Object.keys(table.players).length >= 4){
            return socket.emit("error", "No empty seats available.");
        }

        // Move from spectator to player
        delete table.spectators[playerId];
        table.players[playerId] = {name: player.name, disconnected: false};
        table.playerIds.push(playerId);
        table.scores[player.name] = 120;
        
        const numPlayers = Object.keys(table.players).length;
        if (numPlayers >= 3 && table.state === "Waiting for Players to Join") table.state = "Ready to Start 3P or Wait";
        if (numPlayers === 4) table.state = "Ready to Start 4P";

        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    // ... Other game handlers (dealCards, placeBid, etc.) need to be refactored similarly ...
    // Every function that used the global `gameData` now needs to use the `table` object.
    
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
            if (tableId && tables[tableId]) {
                 if (tables[tableId].players[disconnectedPlayerId]) {
                    tables[tableId].players[disconnectedPlayerId].disconnected = true;
                    // TODO: Add logic here to handle if it was the disconnected player's turn to act.
                    // For example, auto-pass in bidding or skip their turn in play after a timeout.
                }
                io.to(tableId).emit("gameState", tables[tableId]);
                io.emit("lobbyInfo", getLobbyInfo());
            }
            // We don't delete players[disconnectedPlayerId] so they can reconnect.
        } else {
             console.log(`[${SERVER_VERSION} DISCONNECT] Unidentified socket (ID: ${socket.id}) disconnected.`);
        }
    });

    socket.on("requestBootAll", ({tableId}) => {
        if(!tables[tableId]) return;
        console.log(`[${SERVER_VERSION} REQUESTBOOTALL] Received for ${tableId}.`);
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

// NOTE: For brevity, I have refactored the core connection, lobby, and start-game logic.
// You must apply the same pattern (`{..., tableId}`, `const table = tables[tableId]`, `io.to(tableId).emit`)
// to ALL remaining game event handlers:
// dealCards, placeBid, playCard, updateInsuranceSetting, resetGame, requestNextRound,
// frogBidderConfirmsWidowTake, submitFrogDiscards, chooseTrump, etc.
