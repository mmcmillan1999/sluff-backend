// --- Backend/server.js (Refactored for Multi-Table Lobby) ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "4.0.14 - Full Game Logic Restoration";
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
}
initializeServer();

// --- Utility Functions ---
function getLobbyState() {
    return Object.fromEntries(Object.entries(tables).map(([tableId, table]) => {
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        return [tableId, {
            tableId: table.tableId,
            state: table.state,
            players: activePlayers.map(p => ({playerName: p.playerName, disconnected: p.disconnected})),
            playerCount: activePlayers.length,
            spectatorCount: Object.values(table.players).length - activePlayers.length
        }];
    }));
}

function emitLobbyUpdate() { io.emit("lobbyState", getLobbyState()); }
function emitTableUpdate(tableId) { if (tables[tableId]) io.to(tableId).emit("gameState", tables[tableId]); }
function getPlayerNameByPlayerId(playerId, table) { return table?.players[playerId]?.playerName || playerId; }
function getPlayerIdByName(playerName, table) { if(!table || !playerName) return null; for(const pid in table.players){ if(table.players[pid].playerName === playerName) return pid; } return null; }
function getSuit(cardStr) { return cardStr ? cardStr.slice(-1) : null; }
function getRank(cardStr) { return cardStr ? cardStr.slice(0, -1) : null; }
function shuffle(array) { let currentIndex = array.length, randomIndex; while (currentIndex !== 0) { randomIndex = Math.floor(Math.random() * currentIndex); currentIndex--; [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]; } return array; }

// --- Game Logic Functions (Adapted for multi-table) ---

function resetTable(tableId, keepPlayersAsSpectators = true) {
    if (!tables[tableId]) return;
    const originalPlayers = { ...tables[tableId].players };
    const originalScores = { ...tables[tableId].scores };
    tables[tableId] = getInitialGameData(tableId);

    if (keepPlayersAsSpectators) {
        for (const playerId in originalPlayers) {
            const playerInfo = players[playerId];
            if (playerInfo) {
                tables[tableId].players[playerId] = { playerName: playerInfo.playerName, socketId: playerInfo.socketId, isSpectator: true, disconnected: playerInfo.disconnected };
                if(originalScores[playerInfo.playerName] !== undefined) tables[tableId].scores[playerInfo.playerName] = originalScores[playerInfo.playerName];
                playerInfo.tableId = tableId;
            }
        }
    }
    emitTableUpdate(tableId);
    emitLobbyUpdate();
}

function initializeNewRoundState(table) {
    Object.assign(table, {
        hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [], bidsThisRound: [],
        currentHighestBidDetails: null, trumpSuit: null, bidWinnerInfo: null, biddingTurnPlayerName: null,
        bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
        trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [],
        lastCompletedTrick: null, playersWhoPassedThisRound: [], insurance: getInitialInsuranceState()
    });
    const activePlayerNames = Object.values(table.players).filter(p => !p.isSpectator).map(p => p.playerName);
    activePlayerNames.forEach(pName => { if (pName && table.scores[pName] !== undefined) table.capturedTricks[pName] = []; });
}

function transitionToPlayingPhase(table) {
    table.state = "Playing Phase";
    table.tricksPlayedCount = 0;
    table.trumpBroken = false;
    table.currentTrickCards = [];
    table.leadSuitCurrentTrick = null;
    table.lastCompletedTrick = null;
    table.trickLeaderName = table.bidWinnerInfo.playerName;
    table.trickTurnPlayerName = table.bidWinnerInfo.playerName;
    
    if (table.playerMode === 3 && table.bidWinnerInfo.bid !== "Frog") {
        table.insurance.isActive = true;
        table.insurance.bidMultiplier = BID_MULTIPLIERS[table.bidWinnerInfo.bid];
        table.insurance.bidderPlayerName = table.bidWinnerInfo.playerName;
        table.playerOrderActive.forEach(pName => { if(pName !== table.bidWinnerInfo.playerName) table.insurance.defenderOffers[pName] = 0; });
    }
    emitTableUpdate(table.tableId);
}

function resolveBiddingFinal(table) {
    if (!table.currentHighestBidDetails) {
        table.state = "Round Skipped";
        // setTimeout(() => prepareNextRound(table.tableId), 5000); // Need to implement prepareNextRound
    } else {
        table.bidWinnerInfo = { ...table.currentHighestBidDetails };
        const bid = table.bidWinnerInfo.bid;
        
        if (bid === "Frog") { table.trumpSuit = "H"; table.state = "FrogBidderConfirmWidow"; } 
        else if (bid === "Heart Solo") { table.trumpSuit = "H"; transitionToPlayingPhase(table); } 
        else if (bid === "Solo") { table.state = "Trump Selection"; }
    }
    table.originalFrogBidderId = null;
    table.soloBidMadeAfterFrog = false;
    emitTableUpdate(table.tableId);
}

function checkForFrogUpgrade(table) {
    if (table.soloBidMadeAfterFrog) {
        table.state = "Awaiting Frog Upgrade Decision";
        table.biddingTurnPlayerName = getPlayerNameByPlayerId(table.originalFrogBidderId, table);
    } else {
        resolveBiddingFinal(table);
    }
    emitTableUpdate(table.tableId);
}

// --- Socket.IO Connection Handling ---
io.on("connection", (socket) => {
    
    // --- User & Lobby Management ---
    socket.on("login", ({ playerName }) => {
        const newPlayerId = uuidv4();
        players[newPlayerId] = { socketId: socket.id, playerName, tableId: null, disconnected: false };
        sockets[socket.id] = newPlayerId;
        socket.emit("assignedPlayerId", { playerId: newPlayerId, playerName });
    });

    socket.on("reconnectPlayer", ({ playerId, playerName }) => {
        sockets[socket.id] = playerId;
        if (players[playerId]) {
            const player = players[playerId];
            player.socketId = socket.id;
            player.disconnected = false;
            
            if (player.tableId && tables[player.tableId]?.players[playerId]) {
                const table = tables[player.tableId];
                table.players[playerId].disconnected = false;
                table.players[playerId].socketId = socket.id;
                socket.join(player.tableId);
                socket.emit("joinedTable", {tableId: player.tableId, gameState: table});
            } else {
                player.tableId = null;
                socket.emit("lobbyState", getLobbyState());
            }
            socket.emit("assignedPlayerId", { playerId, playerName: player.playerName });
        } else {
            players[playerId] = { socketId: socket.id, playerName, tableId: null, disconnected: false };
            socket.emit("assignedPlayerId", { playerId, playerName });
        }
        emitLobbyUpdate();
    });

    socket.on('changeName', ({ newName }) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId]) return;
        const oldName = players[playerId].playerName;
        players[playerId].playerName = newName;
        socket.emit("nameChanged", { newName });
        const tableId = players[playerId].tableId;
        if(tableId && tables[tableId]?.players[playerId]){
            // This part needs to be more robust, handling name changes in all game state properties
            const table = tables[tableId];
            table.players[playerId].playerName = newName;
            if (table.scores[oldName] !== undefined) {
                table.scores[newName] = table.scores[oldName];
                delete table.scores[oldName];
            }
            emitTableUpdate(tableId);
        }
        emitLobbyUpdate();
    });

    // --- Table Management ---
    socket.on("joinTable", ({ tableId }) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId]) return;
        const player = players[playerId];
        const table = tables[tableId];
        if (!table) return;
        if (player.tableId && player.tableId !== tableId) return;
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator);
        const canTakeSeat = activePlayers.length < MAX_PLAYERS_PER_TABLE && !table.gameStarted;
        const joinAsSpectator = !canTakeSeat;

        player.tableId = tableId;
        table.players[playerId] = { playerName: player.playerName, socketId: socket.id, isSpectator: joinAsSpectator, disconnected: false };
        socket.join(tableId);
        
        if (!joinAsSpectator) {
             if (table.scores[player.playerName] === undefined) table.scores[player.playerName] = 120;
             const numActivePlayers = activePlayers.length + 1;
             if(numActivePlayers >= 3 && !table.gameStarted) {
                table.state = "Ready to Start";
                table.playerOrderActive = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator);
             }
        }
        socket.emit("joinedTable", {tableId, gameState: table});
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("leaveTable", ({tableId}) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId]) return;
        const player = players[playerId];
        const table = tables[tableId];
        if(!table || !table.players[playerId]) return;
        
        const wasActivePlayer = !table.players[playerId].isSpectator;
        const oldName = player.playerName;
        delete table.players[playerId];
        delete table.scores[oldName];
        player.tableId = null;
        socket.leave(tableId);
        
        if(wasActivePlayer && table.gameStarted){
            resetTable(tableId);
        } else {
            if(Object.values(table.players).filter(p=>!p.isSpectator).length < 3) {
                table.state = "Waiting for Players";
                table.playerOrderActive = [];
            }
            emitTableUpdate(tableId);
        }
        emitLobbyUpdate();
    });
    
    // --- Game Flow Handlers ---
    socket.on("startGame", ({ tableId }) => {
        const table = tables[tableId];
        if (!table || table.gameStarted) return;
        const activePlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator && !table.players[pId].disconnected);
        if (activePlayerIds.length < 3) return;

        table.playerMode = activePlayerIds.length;
        table.gameStarted = true;
        const shuffledPlayerIds = shuffle([...activePlayerIds]);
        table.dealer = shuffledPlayerIds[0];

        if(table.playerMode === 4){
             table.playerOrderActive = [];
             const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
             for (let i = 1; i <= 3; i++) {
                 table.playerOrderActive.push(getPlayerNameByPlayerId(shuffledPlayerIds[(dealerIndex + i) % 4], table));
             }
        } else {
             table.playerOrderActive = shuffle(shuffledPlayerIds.map(id => getPlayerNameByPlayerId(id, table)));
             if(table.scores[PLACEHOLDER_ID] === undefined) table.scores[PLACEHOLDER_ID] = 120;
        }

        initializeNewRoundState(table);
        table.state = "Dealing Pending";
        emitTableUpdate(tableId);
        emitLobbyUpdate();
    });

    socket.on("dealCards", ({ tableId }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if (!table || table.state !== "Dealing Pending" || playerId !== table.dealer) return;
        
        const shuffledDeck = shuffle([...deck]);
        table.playerOrderActive.forEach((activePName, i) => {
            table.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        table.widow = shuffledDeck.slice(11 * 3, 11 * 3 + 3);
        table.originalDealtWidow = [...table.widow];
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        
        emitTableUpdate(tableId);
    });

    socket.on("placeBid", ({ tableId, bid }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if (!table || !playerId) return;
        const pName = getPlayerNameByPlayerId(playerId, table);
        
        if (table.state !== "Bidding Phase" && table.state !== "Awaiting Frog Upgrade Decision") return;
        if (table.state === "Bidding Phase" && pName !== table.biddingTurnPlayerName) return;

        if (table.state === "Awaiting Frog Upgrade Decision") {
            if (playerId !== table.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
            if (bid === "Heart Solo") table.currentHighestBidDetails = { playerId, playerName: pName, bid: "Heart Solo" };
            table.biddingTurnPlayerName = null;
            resolveBiddingFinal(table);
            return;
        }

        if (!BID_HIERARCHY.includes(bid)) return;
        if (table.playersWhoPassedThisRound.includes(pName)) return;

        const currentHighestBidIndex = table.currentHighestBidDetails ? BID_HIERARCHY.indexOf(table.currentHighestBidDetails.bid) : -1;
        if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;

        if (bid !== "Pass") {
            table.currentHighestBidDetails = { playerId, playerName: pName, bid };
            if (bid === "Frog" && !table.originalFrogBidderId) table.originalFrogBidderId = playerId;
            if (bid === "Solo" && table.originalFrogBidderId && playerId !== table.originalFrogBidderId) table.soloBidMadeAfterFrog = true;
        } else {
            table.playersWhoPassedThisRound.push(pName);
        }

        const activeBiddersRemaining = table.playerOrderActive.filter(name => !table.playersWhoPassedThisRound.includes(name));
        if (activeBiddersRemaining.length <= 1) {
            table.biddingTurnPlayerName = null;
            checkForFrogUpgrade(table);
        } else {
            let currentBidderIndex = table.playerOrderActive.indexOf(pName);
            let nextBidderName = null;
            for (let i = 1; i < table.playerOrderActive.length; i++) {
                let potentialNextBidder = table.playerOrderActive[(currentBidderIndex + i) % table.playerOrderActive.length];
                if (!table.playersWhoPassedThisRound.includes(potentialNextBidder)) {
                    nextBidderName = potentialNextBidder;
                    break;
                }
            }
            if(nextBidderName) table.biddingTurnPlayerName = nextBidderName;
            else checkForFrogUpgrade(table);
        }
        
        emitTableUpdate(tableId);
    });

    socket.on("disconnect", (reason) => {
        const playerId = sockets[socket.id];
        if (playerId && players[playerId]) {
            const player = players[playerId];
            player.disconnected = true;
            if (player.tableId && tables[player.tableId]?.players[playerId]) {
                tables[player.tableId].players[playerId].disconnected = true;
                emitTableUpdate(player.tableId);
                emitLobbyUpdate();
            }
            delete sockets[socket.id];
        }
    });

    // --- The rest of the game logic handlers ---
    socket.on("frogBidderConfirmsWidowTake", ({ tableId }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if(!table || table.state !== "FrogBidderConfirmWidow" || table.bidWinnerInfo.playerId !== playerId) return;

        table.state = "Frog Widow Exchange";
        table.revealedWidowForFrog = [...table.widow];

        const winnerSocket = io.sockets.sockets.get(table.players[playerId].socketId);
        if(winnerSocket) winnerSocket.emit("promptFrogWidowExchange", { widow: table.widow });
        
        emitTableUpdate(tableId);
    });

    socket.on("submitFrogDiscards", ({ tableId, discards }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if(!table || table.state !== "Frog Widow Exchange" || table.bidWinnerInfo.playerId !== playerId) return;
        if(!Array.isArray(discards) || discards.length !== 3) return;

        const pName = getPlayerNameByPlayerId(playerId, table);
        const combinedHand = [...table.hands[pName], ...table.widow];
        if(!discards.every(card => combinedHand.includes(card))) return;

        table.widowDiscardsForFrogBidder = discards;
        table.hands[pName] = combinedHand.filter(card => !discards.includes(card));
        
        transitionToPlayingPhase(table);
    });

    socket.on("chooseTrump", ({ tableId, suit }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if(!table || table.state !== "Trump Selection" || table.bidWinnerInfo.playerId !== playerId) return;
        if(!["S", "C", "D"].includes(suit)) return;
        
        table.trumpSuit = suit;
        transitionToPlayingPhase(table);
    });
});

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`); });
