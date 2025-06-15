// --- Backend/server.js (v4.3.1) ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// --- VERSION UPDATED ---
const SERVER_VERSION = "4.3.1 - Added Detailed Reset/Login Logging";
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
function getInitialGameData(tableId) {
    return {
        tableId: tableId,
        state: "Waiting for Players",
        players: {},
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
        lastCompletedTrick: null,
        playersWhoPassedThisRound: [],
        playerMode: null,
        serverVersion: SERVER_VERSION,
    };
}

function initializeServer() {
    console.log("[DEBUG] Initializing server state with empty tables.");
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
function calculateCardPoints(cardsArray) { if (!cardsArray || cardsArray.length === 0) return 0; return cardsArray.reduce((sum, cardString) => { const rank = getRank(cardString); return sum + (CARD_POINT_VALUES[rank] || 0); }, 0); }

// --- Game Logic Functions (Adapted for multi-table) ---

function resetTable(tableId, keepPlayersAsSpectators = true) {
    if (!tables[tableId]) return;
    const originalPlayers = { ...tables[tableId].players };
    const originalScores = { ...tables[tableId].scores };

    tables[tableId] = getInitialGameData(tableId);

    if (keepPlayersAsSpectators) {
        for (const playerId in originalPlayers) {
            const playerInfo = players[playerId];
            if (playerInfo && playerInfo.tableId === tableId) {
                tables[tableId].players[playerId] = { playerName: playerInfo.playerName, socketId: playerInfo.socketId, isSpectator: true, disconnected: playerInfo.disconnected };
                tables[tableId].scores[playerInfo.playerName] = originalScores[playerInfo.playerName] ?? 120;
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
        trickLeaderName: null, capturedTricks: {}, roundSummary: null,
        lastCompletedTrick: null, playersWhoPassedThisRound: [],
    });
    table.playerOrderActive.forEach(pName => { if (pName && table.scores[pName] !== undefined) table.capturedTricks[pName] = []; });
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
    
    emitTableUpdate(table.tableId);
}

function resolveBiddingFinal(table) {
    if (!table.currentHighestBidDetails) {
        table.state = "Round Skipped";
        setTimeout(() => {
            if (tables[table.tableId]?.state === "Round Skipped") {
                 console.log(`[${table.tableId}] All players passed. Preparing next round.`);
                 prepareNextRound(table.tableId);
            }
        }, 5000);
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
    console.log(`[CONNECTION] New client connected: ${socket.id}`);
    
    // --- User & Lobby Management ---
    socket.on("login", ({ playerName }) => {
        console.log(`[DEBUG] Received 'login' for playerName: ${playerName}`);
        const newPlayerId = uuidv4();
        players[newPlayerId] = { socketId: socket.id, playerName, tableId: null, disconnected: false };
        sockets[socket.id] = newPlayerId;
        console.log(`[DEBUG] New player created. ID: ${newPlayerId}, Name: ${playerName}. Total players: ${Object.keys(players).length}`);
        socket.emit("assignedPlayerId", { playerId: newPlayerId, playerName });
        emitLobbyUpdate();
    });

    socket.on("reconnectPlayer", ({ playerId, playerName }) => {
        console.log(`[DEBUG] Received 'reconnectPlayer' for playerId: ${playerId}, Name: ${playerName}`);
        sockets[socket.id] = playerId;
        if (players[playerId]) {
            const player = players[playerId];
            player.socketId = socket.id;
            player.disconnected = false;
            console.log(`[DEBUG] Player ${playerName} reconnected successfully.`);
            
            if (player.tableId && tables[player.tableId]?.players[playerId]) {
                const table = tables[player.tableId];
                table.players[playerId].disconnected = false;
                table.players[playerId].socketId = socket.id;
                socket.join(player.tableId);
                emitTableUpdate(player.tableId);
            } else {
                player.tableId = null;
                socket.emit("lobbyState", getLobbyState());
            }
            socket.emit("assignedPlayerId", { playerId, playerName: player.playerName });
        } else {
            console.log(`[DEBUG] Reconnecting player not found in 'players' object. Creating new entry.`);
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
        
        const tableId = players[playerId].tableId;
        if(tableId && tables[tableId]?.players[playerId]){
            const table = tables[tableId];
            if(table.gameStarted) {
                resetTable(tableId, true);
            } else {
                table.players[playerId].playerName = newName;
                if (table.scores[oldName] !== undefined) {
                    table.scores[newName] = table.scores[oldName];
                    delete table.scores[oldName];
                }
            }
            emitTableUpdate(tableId);
        }
        socket.emit("nameChanged", { newName });
        emitLobbyUpdate();
    });

    // --- Table Management ---
    socket.on("joinTable", ({ tableId }) => {
        const playerId = sockets[socket.id];
        if (!playerId || !players[playerId]) return;
        const player = players[playerId];
        const table = tables[tableId];
        if (!table) return;

        if (player.tableId && player.tableId !== tableId) {
            const oldTable = tables[player.tableId];
            if(oldTable && oldTable.players[playerId]){
                delete oldTable.players[playerId];
                socket.leave(player.tableId);
                emitTableUpdate(player.tableId);
            }
        }
        
        const activePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected);
        const canTakeSeat = activePlayers.length < MAX_PLAYERS_PER_TABLE && !table.gameStarted;
        const joinAsSpectator = !canTakeSeat;

        player.tableId = tableId;
        table.players[playerId] = { playerName: player.playerName, socketId: socket.id, isSpectator: joinAsSpectator, disconnected: false };
        socket.join(tableId);
        
        if (!joinAsSpectator) {
             if (table.scores[player.playerName] === undefined) table.scores[player.playerName] = 120;
             const numActivePlayers = Object.values(table.players).filter(p => !p.isSpectator && !p.disconnected).length;
             if(numActivePlayers >= 3 && !table.gameStarted) {
                table.state = "Ready to Start";
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
        delete table.players[playerId];
        player.tableId = null;
        socket.leave(tableId);
        
        if(wasActivePlayer && table.gameStarted){
            resetTable(tableId, true);
        } else {
            const activePlayerCount = Object.values(table.players).filter(p=>!p.isSpectator && !p.disconnected).length;
            if(activePlayerCount < 3) {
                table.state = "Waiting for Players";
            }
            emitTableUpdate(tableId);
        }
        emitLobbyUpdate();
        socket.emit("lobbyState", getLobbyState());
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
        table.playerOrderActive = [];

        if (table.playerMode === 4) {
             const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
             for (let i = 1; i <= 3; i++) {
                 table.playerOrderActive.push(getPlayerNameByPlayerId(shuffledPlayerIds[(dealerIndex + i) % 4], table));
             }
        } else { // 3-Player game
             const dealerIndex = shuffledPlayerIds.indexOf(table.dealer);
             for (let i = 1; i <= 3; i++) {
                const playerToPushId = shuffledPlayerIds[(dealerIndex + i) % 3];
                table.playerOrderActive.push(getPlayerNameByPlayerId(playerToPushId, table));
             }
             if (table.scores[PLACEHOLDER_ID] === undefined) table.scores[PLACEHOLDER_ID] = 120;
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
        const numActivePlayers = table.playerOrderActive.length;
        table.playerOrderActive.forEach((activePName, i) => {
            table.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
        });
        table.widow = shuffledDeck.slice(11 * numActivePlayers, 11 * numActivePlayers + 3);
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
        let endBidding = false;
        if(activeBiddersRemaining.length <= 1 || table.playersWhoPassedThisRound.length === table.playerOrderActive.length) {
            endBidding = true;
        }
        
        if (endBidding) {
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
            if(nextBidderName) {
                table.biddingTurnPlayerName = nextBidderName;
            } else {
                checkForFrogUpgrade(table);
            }
        }
        
        emitTableUpdate(tableId);
    });

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

    socket.on("playCard", ({ tableId, card }) => {
        const table = tables[tableId];
        if (!table) return;
        const playerId = sockets[socket.id];
        const pName = getPlayerNameByPlayerId(playerId, table);

        if (!pName || table.state !== "Playing Phase" || pName !== table.trickTurnPlayerName) return;
        
        const hand = table.hands[pName];
        if (!hand || !hand.includes(card)) return;
        
        const isLeading = table.currentTrickCards.length === 0;
        const playedSuit = getSuit(card);

        if (isLeading) {
            if (playedSuit === table.trumpSuit && !table.trumpBroken) {
                const isHandAllTrump = hand.every(c => getSuit(c) === table.trumpSuit);
                if (!isHandAllTrump) return socket.emit("error", "Cannot lead trump if not broken (unless hand is all trump).");
            }
        } else {
            const leadCardSuit = table.leadSuitCurrentTrick;
            const hasLeadSuit = hand.some(c => getSuit(c) === leadCardSuit);
            if (playedSuit !== leadCardSuit && hasLeadSuit) return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        }
        
        table.hands[pName] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ playerId, playerName: pName, card });
        
        if (isLeading) table.leadSuitCurrentTrick = playedSuit;
        if (playedSuit === table.trumpSuit) table.trumpBroken = true;
        
        const expectedCardsInTrick = table.playerOrderActive.length;
        if (table.currentTrickCards.length === expectedCardsInTrick) {
            const winnerNameOfTrick = determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            const currentTrickNumber = table.tricksPlayedCount + 1;
            
            if (winnerNameOfTrick) {
                if (!table.capturedTricks[winnerNameOfTrick]) table.capturedTricks[winnerNameOfTrick] = [];
                table.capturedTricks[winnerNameOfTrick].push(table.currentTrickCards.map(p => p.card));
            }
            
            table.lastCompletedTrick = { cards: [...table.currentTrickCards], winnerName: winnerNameOfTrick, leadSuit: table.leadSuitCurrentTrick, trickNumber: currentTrickNumber };
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerNameOfTrick;
            
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
                        currentTable.trickTurnPlayerName = winnerNameOfTrick;
                        currentTable.state = "Playing Phase";
                        emitTableUpdate(tableId);
                    }
                }, 2000);
            }
        } else {
            const currentTurnPlayerIndex = table.playerOrderActive.indexOf(pName);
            table.trickTurnPlayerName = table.playerOrderActive[(currentTurnPlayerIndex + 1) % expectedCardsInTrick];
            emitTableUpdate(tableId);
        }
    });

    socket.on("requestNextRound", ({ tableId }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if (table && table.state === "Awaiting Next Round Trigger" && playerId === table.dealer) {
            prepareNextRound(tableId);
        } else {
            socket.emit("error", "Cannot start next round: Not the correct state or you are not the dealer.");
        }
    });
    
    socket.on("resetGame", ({ tableId }) => {
        resetTable(tableId, true);
    });

    socket.on("hardResetServer", () => {
        console.log(`[ADMIN] Received 'hardResetServer' from ${players[sockets[socket.id]]?.playerName || 'a user'}.`);
        console.log("[ADMIN] Wiping all player and table data...");

        players = {};
        sockets = {};
        tables = {};
        console.log("[ADMIN] In-memory state cleared.");

        initializeServer();
        console.log("[ADMIN] Server state has been re-initialized.");

        console.log("[ADMIN] Emitting 'forceDisconnectAndReset' to all clients.");
        io.emit("forceDisconnectAndReset", "The server has been reset by an administrator.");
    });

    socket.on("disconnect", (reason) => {
        console.log(`[CONNECTION] Client disconnected: ${socket.id}. Reason: ${reason}`);
        const playerId = sockets[socket.id];
        if (playerId && players[playerId]) {
            const player = players[playerId];
            player.disconnected = true;
            if (player.tableId && tables[player.tableId]?.players[playerId]) {
                const table = tables[player.tableId];
                table.players[playerId].disconnected = true;

                if(table.gameStarted && table.state !== "Waiting for Players" && table.state !== "Ready to Start" && table.state !== "Game Over"){
                    console.log(`[${player.tableId}] Player ${player.playerName} disconnected mid-game. Resetting table.`);
                    resetTable(player.tableId, true);
                } else {
                   emitTableUpdate(player.tableId);
                }
            }
            emitLobbyUpdate();
            delete sockets[socket.id];
        }
    });
});

// --- Core Game Logic Functions ---

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
    
    winningPlay = highestTrumpPlay || highestLeadSuitPlay;
    return winningPlay ? winningPlay.playerName : null;
}

function calculateRoundScores(tableId) {
    const table = tables[tableId];
    if (!table || !table.bidWinnerInfo) return;

    const { bidWinnerInfo, playerOrderActive, playerMode, scores, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow, trickLeaderName } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const bidType = bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];

    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };

    if (bidType === "Frog") {
        awardedWidowInfo.cards = [...widowDiscardsForFrogBidder];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Solo") {
        awardedWidowInfo.cards = [...originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Heart Solo") {
        awardedWidowInfo.cards = [...originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        if (trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = bidWinnerName;
        } else {
            defendersTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = trickLeaderName;
        }
    }

    playerOrderActive.forEach(pName => {
        const capturedCards = (capturedTricks[pName] || []).flat();
        const playerTrickPoints = calculateCardPoints(capturedCards);
        if (pName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });
    
    const bidMadeSuccessfully = bidderTotalCardPoints > 60;
    const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
    const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
    
    const scoresBeforeExchange = JSON.parse(JSON.stringify(scores));
    let roundMessage = "";

    if (scoreDifferenceFrom60 === 0) {
        roundMessage = `${bidWinnerName} scored exactly 60. No points exchanged.`;
    } else if (bidMadeSuccessfully) {
        let totalPointsGained = 0;
        playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                scores[pName] -= exchangeValue;
                totalPointsGained += exchangeValue;
            }
        });
        scores[bidWinnerName] += totalPointsGained;
        roundMessage = `${bidWinnerName} succeeded! Gains ${totalPointsGained} points.`;
    } else { // Bid failed
        let totalPointsLost = 0;
        const activeOpponents = playerOrderActive.filter(pName => pName !== bidWinnerName);
        activeOpponents.forEach(oppName => {
            scores[oppName] += exchangeValue;
            totalPointsLost += exchangeValue;
        });

        if (playerMode === 3) {
            scores[PLACEHOLDER_ID] += exchangeValue;
            totalPointsLost += exchangeValue;
        } else if (playerMode === 4) {
            const dealerName = getPlayerNameByPlayerId(table.dealer, table);
            if (dealerName && !playerOrderActive.includes(dealerName)) {
                scores[dealerName] += exchangeValue;
                totalPointsLost += exchangeValue;
            }
        }
        scores[bidWinnerName] -= totalPointsLost;
        roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLost} points.`;
    }

    let isGameOver = false;
    let gameWinner = null;
    const finalPlayerScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID);

    if(finalPlayerScores.some(([,score]) => score <= 0)) {
        isGameOver = true;
        gameWinner = finalPlayerScores.sort((a,b) => b[1] - a[1])[0][0];
        roundMessage += ` GAME OVER! Winner: ${gameWinner}.`;
        table.state = "Game Over";
    } else {
        table.state = "Awaiting Next Round Trigger";
    }

    table.roundSummary = {
        bidWinnerName, bidType, trumpSuit: table.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints, defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo, bidMadeSuccessfully,
        scoresBeforeExchange, finalScores: scores,
        isGameOver, gameWinner, message: roundMessage,
    };
    
    emitTableUpdate(tableId);
}

function prepareNextRound(tableId) {
    const table = tables[tableId];
    if (!table || !table.gameStarted) return;
    
    const activePlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator && !table.players[pId].disconnected);
    if (activePlayerIds.length !== table.playerMode) {
        resetTable(tableId, true);
        return;
    }
    
    const rotationPlayerIds = table.playerMode === 4 
        ? Object.keys(table.players).filter(pId => !table.players[pId].isSpectator) 
        : activePlayerIds;

    const lastDealerIndex = rotationPlayerIds.indexOf(table.dealer);
    const nextDealerId = rotationPlayerIds[(lastDealerIndex + 1) % rotationPlayerIds.length];
    
    table.dealer = nextDealerId;
    table.playerOrderActive = [];

    if (table.playerMode === 4) {
        const dealerIndex = rotationPlayerIds.indexOf(table.dealer);
        for (let i = 1; i <= 3; i++) {
            const activePlayerId = rotationPlayerIds[(dealerIndex + i) % 4];
            table.playerOrderActive.push(getPlayerNameByPlayerId(activePlayerId, table));
        }
    } else { // 3 Player Game
        const dealerIndex = rotationPlayerIds.indexOf(table.dealer);
        for (let i = 1; i <= 3; i++) {
            const activePlayerId = rotationPlayerIds[(dealerIndex + i) % 3];
            table.playerOrderActive.push(getPlayerNameByPlayerId(activePlayerId, table));
        }
    }
    
    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    emitTableUpdate(tableId);
}

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`); });