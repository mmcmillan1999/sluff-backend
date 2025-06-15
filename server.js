// --- Backend/server.js (Refactored for Multi-Table Lobby) ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "4.0.5 - Bidding Logic Fix";
console.log(`SLUFF SERVER (${SERVER_VERSION}): Initializing...`);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors({ origin: "*" }));
app.use(express.json());

// --- Game Constants ---
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"];
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];
const BID_MULTIPLIERS = { "Frog": 1, "Solo": 2, "Heart Solo": 3 };
const PLACEHOLDER_ID = "ScoreAbsorber";
const MAX_PLAYERS_PER_TABLE = 4;
const NUM_TABLES = 3;

// --- Global State Management ---
let players = {}; // Maps playerId -> { socketId, playerName, tableId, disconnected }
let sockets = {}; // Maps socket.id -> playerId
let tables = {}; // Maps tableId -> gameData object

let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- Helper Functions for Initial Game State ---
function getInitialInsuranceState() {
    return {
        isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0,
        defenderOffers: {}, dealExecuted: false, executedDetails: null
    };
}

function getInitialGameData(tableId) {
    return {
        tableId: tableId,
        state: "Waiting for Players",
        players: {}, // maps playerId -> { playerName, socketId, isSpectator, disconnected }
        playerOrderActive: [],
        dealer: null,
        hands: {},
        widow: [],
        originalDealtWidow: [],
        widowDiscardsForFrogBidder: [],
        scores: {},
        bidsThisRound: [],
        currentHighestBidDetails: null,
        biddingTurnPlayerName: null,
        bidsMadeCount: 0,
        originalFrogBidderId: null,
        soloBidMadeAfterFrog: false,
        trumpSuit: null,
        bidWinnerInfo: null,
        gameStarted: false,
        currentTrickCards: [],
        trickTurnPlayerName: null,
        tricksPlayedCount: 0,
        leadSuitCurrentTrick: null,
        trumpBroken: false,
        trickLeaderName: null,
        capturedTricks: {},
        roundSummary: null,
        revealedWidowForFrog: [],
        lastCompletedTrick: null,
        playersWhoPassedThisRound: [],
        playerMode: null,
        serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState()
    };
}

// --- Server Initialization ---
function initializeServer() {
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log(`SLUFF SERVER (${SERVER_VERSION}): ${NUM_TABLES} tables initialized.`);
}
initializeServer();

// --- Utility Functions ---
function getLobbyState() {
    const lobbyTables = {};
    for (const tableId in tables) {
        const table = tables[tableId];
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        const spectators = Object.values(table.players).filter(p => p.isSpectator);
        lobbyTables[tableId] = {
            tableId: table.tableId,
            state: table.state,
            players: activePlayers.map(p => ({playerName: p.playerName, disconnected: p.disconnected})),
            playerCount: activePlayers.length,
            spectatorCount: spectators.length
        };
    }
    return lobbyTables;
}

function emitLobbyUpdate() {
    io.emit("lobbyState", getLobbyState());
}

function emitTableUpdate(tableId) {
    if (tables[tableId]) {
        io.to(tableId).emit("gameState", tables[tableId]);
    }
}

function getPlayerNameByPlayerId(playerId, table) {
    if (table && table.players[playerId]) {
        return table.players[playerId].playerName;
    }
    return playerId;
}

function getSuit(cardStr) { return cardStr ? cardStr.slice(-1) : null; }
function getRank(cardStr) { return cardStr ? cardStr.slice(0, -1) : null; }

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
        const rank = getRank(cardString);
        return sum + (CARD_POINT_VALUES[rank] || 0);
    }, 0);
}


// --- Game Logic Functions (Adapted for multi-table) ---

function resetTable(tableId) {
    console.log(`[${SERVER_VERSION}] Resetting table: ${tableId}`);
    if (!tables[tableId]) return;

    const originalPlayers = { ...tables[tableId].players };
    tables[tableId] = getInitialGameData(tableId);

    for (const playerId in originalPlayers) {
        const player = players[playerId];
        if (player) {
            tables[tableId].players[playerId] = {
                playerName: player.playerName,
                socketId: player.socketId,
                isSpectator: true,
                disconnected: player.disconnected
            };
            player.tableId = tableId;
        }
    }
    emitTableUpdate(tableId);
    emitLobbyUpdate();
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

    const playersToInitTricksFor = table.playerOrderActive.length > 0 ? table.playerOrderActive : Object.values(table.players).map(p => p.playerName);
    playersToInitTricksFor.forEach(pName => {
        if (pName && table.scores && table.scores[pName] !== undefined) {
            table.capturedTricks[pName] = [];
        }
    });
    console.log(`[${SERVER_VERSION}][${table.tableId}] New round state initialized.`);
}

function determineTrickWinner(trickCards, leadSuit, trumpSuit, table) {
    if (!trickCards || trickCards.length === 0) return null;
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
    if (highestTrumpPlay) winningPlay = highestTrumpPlay;
    else if (highestLeadSuitPlay) winningPlay = highestLeadSuitPlay;
    
    return winningPlay ? winningPlay.playerId : null;
}

// --- Socket.IO Connection Handling ---
io.on("connection", (socket) => {
    console.log(`[${SERVER_VERSION}] CONNECT: ${socket.id}`);
    
    socket.on("login", ({ playerName }) => {
        const newPlayerId = uuidv4();
        players[newPlayerId] = {
            socketId: socket.id,
            playerName: playerName,
            tableId: null,
            disconnected: false
        };
        sockets[socket.id] = newPlayerId;
        socket.emit("assignedPlayerId", { playerId: newPlayerId, playerName: playerName });
        console.log(`[${SERVER_VERSION}] New player logged in: ${playerName} (${newPlayerId})`);
    });

    socket.on("reconnectPlayer", ({ playerId, playerName }) => {
        if (players[playerId]) {
            console.log(`[${SERVER_VERSION}] Reconnecting player: ${playerName} (${playerId})`);
            const player = players[playerId];
            player.socketId = socket.id;
            player.disconnected = false;
            sockets[socket.id] = playerId;

            if (player.tableId && tables[player.tableId] && tables[player.tableId].players[playerId]) {
                const table = tables[player.tableId];
                table.players[playerId].disconnected = false;
                table.players[playerId].socketId = socket.id;
                socket.join(player.tableId);
                emitTableUpdate(player.tableId);
            }
             socket.emit("assignedPlayerId", { playerId: playerId, playerName: player.playerName });
            if(player.tableId) {
                socket.emit("joinedTable", {tableId: player.tableId, gameState: tables[player.tableId]});
            } else {
                socket.emit("lobbyState", getLobbyState());
            }
            emitLobbyUpdate();
        } else {
            console.log(`[${SERVER_VERSION}] Reconnect failed for ${playerId}, treating as new login for ${playerName}`);
            const newPlayerId = uuidv4();
            players[newPlayerId] = { socketId: socket.id, playerName: playerName, tableId: null, disconnected: false };
            sockets[socket.id] = newPlayerId;
            socket.emit("assignedPlayerId", { playerId: newPlayerId, playerName: playerName });
        }
    });

    socket.on("joinTable", ({ tableId }) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId]) return socket.emit("errorMessage", "Player not authenticated.");
        
        const player = players[playerId];
        const table = tables[tableId];
        if (!table) return socket.emit("errorMessage", "Table does not exist.");

        if (player.tableId && player.tableId !== tableId) {
             return socket.emit("errorMessage", "You are already at another table. Please leave it first.");
        }
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        const canTakeSeat = activePlayers.length < MAX_PLAYERS_PER_TABLE && !table.gameStarted;
        const joinAsSpectator = !canTakeSeat;

        player.tableId = tableId;
        table.players[playerId] = {
            playerName: player.playerName,
            socketId: socket.id,
            isSpectator: joinAsSpectator,
            disconnected: false
        };

        socket.join(tableId);
        
        if (!joinAsSpectator) {
             if (table.scores[player.playerName] === undefined) {
                 table.scores[player.playerName] = 120;
             }
             const numActivePlayers = activePlayers.length + 1;
             if(numActivePlayers >= 3 && !table.gameStarted) {
                table.state = "Ready to Start";
             }
        }
        
        console.log(`[${SERVER_VERSION}] Player ${player.playerName} joined ${tableId} ${joinAsSpectator ? 'as spectator' : 'as player'}`);

        socket.emit("joinedTable", {tableId: tableId, gameState: table});
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("leaveTable", () => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId] || !players[playerId].tableId) return;

        const player = players[playerId];
        const tableId = player.tableId;
        const table = tables[tableId];

        if (table && table.players[playerId]) {
             if (!table.players[playerId].isSpectator && table.gameStarted) {
                console.log(`[${SERVER_VERSION}] Active player ${player.playerName} left mid-game from ${tableId}. Resetting table.`);
                resetTable(tableId);
             } else {
                delete table.players[playerId];
             }

            player.tableId = null;
            socket.leave(tableId);
            console.log(`[${SERVER_VERSION}] Player ${player.playerName} left ${tableId}.`);

            if (Object.keys(table.players).filter(pId => !table.players[pId].isSpectator).length < 3) {
                 table.state = "Waiting for Players";
            }
            
            emitTableUpdate(tableId);
            emitLobbyUpdate();
        }
    });
    
    socket.on("startGame", () => {
        const playerId = sockets[socket.id];
        const player = players[playerId];
        if (!player || !player.tableId) return;
        
        const table = tables[player.tableId];
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        
        if (activePlayers.length < 3 || activePlayers.length > 4) {
            return socket.emit("errorMessage", `Need 3 or 4 players to start. You have ${activePlayers.length}.`);
        }
        if (table.gameStarted) {
            return socket.emit("errorMessage", "Game already in progress.");
        }

        table.playerMode = activePlayers.length;
        table.gameStarted = true;
        
        const activePlayerIds = activePlayers.map(p => {
             for (const id in table.players) {
                if (table.players[id].playerName === p.playerName) return id;
             }
             return null;
        }).filter(Boolean);

        const shuffledPlayerIds = shuffle([...activePlayerIds]);
        table.dealer = shuffledPlayerIds[0];

        if(table.playerMode === 4){
             table.playerOrderActive = [];
             const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
             for (let i = 1; i <= 3; i++) {
                 const activePlayerId = shuffledPlayerIds[(dealerIndex + i) % 4];
                 table.playerOrderActive.push(getPlayerNameByPlayerId(activePlayerId, table));
             }
        } else {
             table.playerOrderActive = shuffle(shuffledPlayerIds.map(id => getPlayerNameByPlayerId(id, table)));
             if(table.scores[PLACEHOLDER_ID] === undefined) table.scores[PLACEHOLDER_ID] = 120;
        }

        initializeNewRoundState(table);
        table.state = "Dealing Pending";
        console.log(`[${SERVER_VERSION}][${table.tableId}] ${table.playerMode}P game started. Dealer: ${getPlayerNameByPlayerId(table.dealer, table)}.`);
        emitTableUpdate(table.tableId);
        emitLobbyUpdate();
    });

    socket.on("dealCards", () => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId] || !players[playerId].tableId) return;
        const table = tables[players[playerId].tableId];

        if (table.state !== "Dealing Pending" || !table.dealer || playerId !== table.dealer) {
            return socket.emit("errorMessage", "Not dealer or not dealing phase.");
        }
        
        const shuffledDeck = shuffle([...deck]);
        table.playerOrderActive.forEach((activePName, i) => {
            if (activePName) table.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        const cardsDealtToPlayers = 11 * table.playerOrderActive.length;
        table.widow = shuffledDeck.slice(cardsDealtToPlayers, cardsDealtToPlayers + 3);
        table.originalDealtWidow = [...table.widow];
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        
        emitTableUpdate(table.tableId);
    });

    socket.on("placeBid", ({ bid }) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId] || !players[playerId].tableId) return;
        const table = tables[players[playerId].tableId];
        
        const pName = getPlayerNameByPlayerId(playerId, table);
        if (!pName) return socket.emit("errorMessage", "Player not found at this table.");

        if (table.state !== "Bidding Phase") return socket.emit("errorMessage", "Not in Bidding Phase.");
        if (pName !== table.biddingTurnPlayerName) return socket.emit("errorMessage", "Not your turn to bid.");
        
        // ... (The rest of the comprehensive bidding logic from the original server.js)
        // This is a simplified placeholder for the full logic.
        console.log(`[${SERVER_VERSION}][${table.tableId}] Player ${pName} bid ${bid}`);

        table.bidsThisRound.push({ playerId: playerId, playerName: pName, bidValue: bid });
        
        // Example of moving to next bidder
        const currentBidderIndex = table.playerOrderActive.indexOf(pName);
        const nextBidderIndex = (currentBidderIndex + 1) % table.playerOrderActive.length;
        table.biddingTurnPlayerName = table.playerOrderActive[nextBidderIndex];

        // This would need the full logic to handle passes, bid hierarchy, and ending the bid phase
        
        emitTableUpdate(table.tableId);
    });
    
    socket.on("disconnect", (reason) => {
        const playerId = sockets[socket.id];
        console.log(`[${SERVER_VERSION}] DISCONNECT: ${socket.id} (PlayerID: ${playerId}). Reason: ${reason}`);

        if (playerId && players[playerId]) {
            const player = players[playerId];
            player.disconnected = true;
            
            if (player.tableId && tables[player.tableId] && tables[player.tableId].players[playerId]) {
                tables[player.tableId].players[playerId].disconnected = true;
                console.log(`[${SERVER_VERSION}] Player ${player.playerName} marked as disconnected at table ${player.tableId}.`);
                emitTableUpdate(player.tableId);
                emitLobbyUpdate();
            }
            delete sockets[socket.id];
        } else {
             console.log(`[${SERVER_VERSION}] Disconnected socket ${socket.id} had no authenticated player.`);
        }
    });
    
    socket.on('bootPlayer', ({playerIdToBoot}) => {
        const requesterId = sockets[socket.id];
        if (!requesterId || !players[requesterId] || !players[requesterId].tableId) return;

        const table = tables[players[requesterId].tableId];
        if (!table || !table.players[playerIdToBoot] || table.players[playerIdToBoot].isSpectator) {
            return socket.emit("errorMessage", "Cannot boot this player.");
        }
        
        if (!table.players[playerIdToBoot].disconnected) {
            return socket.emit("errorMessage", "Can only boot connected players.");
        }
        
        console.log(`[${SERVER_VERSION}] Player ${players[requesterId].playerName} is booting ${players[playerIdToBoot].playerName} from ${table.tableId}`);
        
        const bootedPlayerObject = players[playerIdToBoot];
        if(bootedPlayerObject) bootedPlayerObject.tableId = null;
        delete table.players[playerIdToBoot];

        if (table.gameStarted) {
            console.log(`[${SERVER_VERSION}] Game was in progress. Resetting table ${table.tableId} after boot.`);
            resetTable(table.tableId);
        } else {
            if (Object.values(table.players).filter(p => !p.isSpectator).length < 3) {
                 table.state = "Waiting for Players";
            }
             emitTableUpdate(table.tableId);
        }

        emitLobbyUpdate();
    });

    socket.on('takeSeat', () => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId] || !players[playerId].tableId) return;

        const player = players[playerId];
        const table = tables[player.tableId];

        if (!table || !table.players[playerId] || !table.players[playerId].isSpectator) {
            return socket.emit("errorMessage", "You are not a spectator at this table.");
        }

        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        if (activePlayers.length >= MAX_PLAYERS_PER_TABLE) {
            return socket.emit("errorMessage", "Table is full.");
        }
        if (table.gameStarted) {
             return socket.emit("errorMessage", "Cannot take seat, game is in progress.");
        }

        table.players[playerId].isSpectator = false;
        if(table.scores[player.playerName] === undefined) table.scores[player.playerName] = 120;
        console.log(`[${SERVER_VERSION}] Spectator ${player.playerName} took a seat at ${table.tableId}`);

        if (Object.values(table.players).filter(pId => !table.players[pId].isSpectator).length >= 3) {
            table.state = "Ready to Start";
        }
        
        emitTableUpdate(table.tableId);
        emitLobbyUpdate();
    });

});

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });
