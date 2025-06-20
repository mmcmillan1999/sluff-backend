// --- Backend/server.js (v4.6.3) ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// --- VERSION UPDATED ---
const SERVER_VERSION = "4.6.3 - Fixed Insurance Scoring Crash";
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
let players = {};
let sockets = {};
let tables = {};
let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

// --- Helper Functions for Initial Game State ---
function getInitialInsuranceState() {
    return {
        isActive: false,
        bidMultiplier: null,
        bidderPlayerName: null,
        bidderRequirement: 0,
        defenderOffers: {},
        dealExecuted: false,
        executedDetails: null
    };
}

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
        revealedWidowForFrog: [],
        lastCompletedTrick: null,
        playersWhoPassedThisRound: [],
        playerMode: null,
        serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState(),
    };
}

function initializeServer() {
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
}
initializeServer();

// --- Utility Functions ---
function getLobbyState() { return Object.fromEntries(Object.entries(tables).map(([tableId, table]) => { const activePlayers = Object.values(table.players).filter(p => !p.isSpectator); return [tableId, { tableId: table.tableId, state: table.state, players: activePlayers.map(p => ({playerName: p.playerName, disconnected: p.disconnected})), playerCount: activePlayers.length, spectatorCount: Object.values(table.players).length - activePlayers.length }]; })); }
function emitLobbyUpdate() { io.emit("lobbyState", getLobbyState()); }
function emitTableUpdate(tableId) { if (tables[tableId]) io.to(tableId).emit("gameState", tables[tableId]); }
function getPlayerNameByPlayerId(playerId, table) { return table?.players[playerId]?.playerName || playerId; }
function getPlayerIdByName(playerName, table) { if(!table || !playerName) return null; for(const pid in table.players){ if(table.players[pid].playerName === playerName) return pid; } return null; }
function getSuit(cardStr) { return cardStr ? cardStr.slice(-1) : null; }
function getRank(cardStr) { return cardStr ? cardStr.slice(0, -1) : null; }
function shuffle(array) { let currentIndex = array.length, randomIndex; while (currentIndex !== 0) { randomIndex = Math.floor(Math.random() * currentIndex); currentIndex--; [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]; } return array; }
function calculateCardPoints(cardsArray) { if (!cardsArray || cardsArray.length === 0) return 0; return cardsArray.reduce((sum, cardString) => { const rank = getRank(cardString); return sum + (CARD_POINT_VALUES[rank] || 0); }, 0); }

// --- Game Logic Functions ---
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
        trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [],
        lastCompletedTrick: null, playersWhoPassedThisRound: [], insurance: getInitialInsuranceState(),
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
    if (table.playerMode === 3) {
        table.insurance.isActive = true;
        const multiplier = BID_MULTIPLIERS[table.bidWinnerInfo.bid];
        table.insurance.bidMultiplier = multiplier;
        table.insurance.bidderPlayerName = table.bidWinnerInfo.playerName;
        table.insurance.bidderRequirement = 120 * multiplier;
        const defenders = table.playerOrderActive.filter(pName => pName !== table.bidWinnerInfo.playerName);
        defenders.forEach(defName => {
            table.insurance.defenderOffers[defName] = -60 * multiplier;
        });
        console.log(`[${table.tableId}] INSURANCE ACTIVATED for ${table.bidWinnerInfo.playerName}.`);
    }
    emitTableUpdate(table.tableId);
}

function resolveBiddingFinal(table) {
    if (!table.currentHighestBidDetails) {
        table.state = "Round Skipped";
        setTimeout(() => { if (tables[table.tableId]?.state === "Round Skipped") { prepareNextRound(table.tableId); } }, 5000);
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

io.on("connection", (socket) => {
    socket.on("login", ({ playerName }) => {
        const newPlayerId = uuidv4();
        players[newPlayerId] = { socketId: socket.id, playerName, tableId: null, disconnected: false };
        sockets[socket.id] = newPlayerId;
        socket.emit("assignedPlayerId", { playerId: newPlayerId, playerName });
        emitLobbyUpdate();
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
                emitTableUpdate(player.tableId);
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
        const tableId = players[playerId].tableId;
        if(tableId && tables[tableId]?.players[playerId]){
            const table = tables[tableId];
            if(table.gameStarted) { resetTable(tableId, true);
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
        if(wasActivePlayer && table.gameStarted){ resetTable(tableId, true);
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
        } else {
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
        if (!BID_HIERARCHY.includes(bid) || table.playersWhoPassedThisRound.includes(pName)) return;
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
        if (table.playersWhoPassedThisRound.length === table.playerOrderActive.length) { endBidding = true; } 
        else if (table.currentHighestBidDetails && activeBiddersRemaining.length === 1 && activeBiddersRemaining[0] === table.currentHighestBidDetails.playerName) { endBidding = true; } 
        else if (table.currentHighestBidDetails && activeBiddersRemaining.length === 0) { endBidding = true; }
        if (endBidding) {
            table.biddingTurnPlayerName = null;
            checkForFrogUpgrade(table);
        } else {
            let currentBidderIndex = table.playerOrderActive.indexOf(pName);
            let nextBidderName = null;
            for (let i = 1; i < table.playerOrderActive.length; i++) {
                let potentialNextBidder = table.playerOrderActive[(currentBidderIndex + i) % table.playerOrderActive.length];
                if (!table.playersWhoPassedThisRound.includes(potentialNextBidder)) { nextBidderName = potentialNextBidder; break; }
            }
            if (nextBidderName) { table.biddingTurnPlayerName = nextBidderName; } else { checkForFrogUpgrade(table); }
        }
        emitTableUpdate(tableId);
    });

    socket.on("frogBidderConfirmsWidowTake", ({ tableId }) => {
        const table = tables[tableId];
        const playerId = sockets[socket.id];
        if(!table || table.state !== "FrogBidderConfirmWidow" || table.bidWinnerInfo.playerId !== playerId) return;
        table.state = "Frog Widow Exchange";
        table.revealedWidowForFrog = [...table.widow];
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
            if (!hasLeadSuit) {
                const hasTrump = hand.some(c => getSuit(c) === table.trumpSuit);
                if (hasTrump && playedSuit !== table.trumpSuit) return socket.emit("error", "You are out of the lead suit and must play trump.");
            }
        }
        table.hands[pName] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ playerId, playerName: pName, card });
        if (isLeading) table.leadSuitCurrentTrick = playedSuit;
        if (playedSuit === table.trumpSuit) table.trumpBroken = true;
        const expectedCardsInTrick = table.playerOrderActive.length;
        if (table.currentTrickCards.length === expectedCardsInTrick) {
            const winnerNameOfTrick = determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            table.lastCompletedTrick = { cards: [...table.currentTrickCards], winnerName: winnerNameOfTrick };
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerNameOfTrick;
            if (winnerNameOfTrick) {
                if (!table.capturedTricks[winnerNameOfTrick]) table.capturedTricks[winnerNameOfTrick] = [];
                table.capturedTricks[winnerNameOfTrick].push(table.currentTrickCards.map(p => p.card));
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
        if (table && table.state === "Awaiting Next Round Trigger" && playerId === table.roundSummary?.dealerOfRoundId) {
            prepareNextRound(tableId);
        } else {
            socket.emit("error", "Cannot start next round: Not the correct state or you are not the dealer.");
        }
    });
    
    socket.on("resetGame", ({ tableId }) => { resetTable(tableId, true); });

    socket.on("hardResetServer", () => {
        console.log(`[ADMIN] Received 'hardResetServer' from ${players[sockets[socket.id]]?.playerName || 'a user'}.`);
        players = {}; sockets = {}; tables = {};
        initializeServer();
        console.log("[ADMIN] Server state has been reset.");
        io.emit("forceDisconnectAndReset", "The server has been reset by an administrator.");
    });
    
    socket.on("updateInsuranceSetting", ({ tableId, settingType, value }) => {
        const table = tables[tableId];
        const pName = getPlayerNameByPlayerId(sockets[socket.id], table);
        if (!pName || !table) return socket.emit("error", "Player or table not found.");
        if (!table.insurance.isActive) return socket.emit("error", "Insurance is not currently active.");
        if (table.insurance.dealExecuted) return socket.emit("error", "Insurance deal already made, settings are locked.");
        const multiplier = table.insurance.bidMultiplier;
        const parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) return socket.emit("error", "Invalid value. Must be a whole number.");
        if (settingType === 'bidderRequirement') {
            if (pName !== table.insurance.bidderPlayerName) return socket.emit("error", "Only the bid winner can update the requirement.");
            const minReq = -120 * multiplier; const maxReq = 120 * multiplier;
            if (parsedValue < minReq || parsedValue > maxReq) return socket.emit("error", `Requirement out of range [${minReq}, ${maxReq}].`);
            table.insurance.bidderRequirement = parsedValue;
        } else if (settingType === 'defenderOffer') {
            if (!table.insurance.defenderOffers.hasOwnProperty(pName)) return socket.emit("error", "You are not a listed defender.");
            const minOffer = -60 * multiplier; const maxOffer = 60 * multiplier;
            if (parsedValue < minOffer || parsedValue > maxOffer) return socket.emit("error", `Offer out of range [${minOffer}, ${maxOffer}].`);
            table.insurance.defenderOffers[pName] = parsedValue;
        } else {
            return socket.emit("error", "Invalid insurance setting type.");
        }
        const { bidderRequirement, defenderOffers } = table.insurance;
        const sumOfDefenderOffers = Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0);
        if (bidderRequirement <= sumOfDefenderOffers) {
            table.insurance.dealExecuted = true;
            table.insurance.executedDetails = {
                agreement: { bidderPlayerName: table.insurance.bidderPlayerName, bidderRequirement: bidderRequirement, defenderOffers: { ...defenderOffers } },
                pointsExchanged: {}
            };
            console.log(`[${tableId}] INSURANCE DEAL EXECUTED!`);
        }
        emitTableUpdate(tableId);
    });

    socket.on("disconnect", (reason) => {
        const playerId = sockets[socket.id];
        if (playerId && players[playerId]) {
            const player = players[playerId];
            player.disconnected = true;
            if (player.tableId && tables[player.tableId]?.players[playerId]) {
                const table = tables[player.tableId];
                table.players[playerId].disconnected = true;
                if (table.insurance.isActive && !table.insurance.dealExecuted) {
                    const pName = player.playerName;
                    if (table.insurance.bidderPlayerName === pName) { table.insurance.isActive = false; } 
                    else if (table.insurance.defenderOffers.hasOwnProperty(pName)) { delete table.insurance.defenderOffers[pName]; }
                }
                if(table.gameStarted && table.state !== "Waiting for Players" && table.state !== "Ready to Start" && table.state !== "Game Over"){
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

// --- MODIFIED FUNCTION ---
function calculateRoundScores(tableId) {
    const table = tables[tableId];
    if (!table || !table.bidWinnerInfo) return;

    const { bidWinnerInfo, playerOrderActive, playerMode, scores, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow, trickLeaderName, insurance } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const bidType = bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };
    let roundMessage = "";
    
    if (bidType === "Frog") { awardedWidowInfo.cards = [...widowDiscardsForFrogBidder]; awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards); bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName; } 
    else if (bidType === "Solo") { awardedWidowInfo.cards = [...originalDealtWidow]; awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards); bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName; } 
    else if (bidType === "Heart Solo") { awardedWidowInfo.cards = [...originalDealtWidow]; awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards); if (trickLeaderName === bidWinnerName) { bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName; } else { defendersTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = trickLeaderName; } }
    playerOrderActive.forEach(pName => { const capturedCards = (capturedTricks[pName] || []).flat(); const playerTrickPoints = calculateCardPoints(capturedCards); if (pName === bidWinnerName) { bidderTotalCardPoints += playerTrickPoints; } else { defendersTotalCardPoints += playerTrickPoints; } });
    
    const bidMadeSuccessfully = bidderTotalCardPoints > 60;
    const scoresBeforeExchange = JSON.parse(JSON.stringify(scores));
    
    if (insurance.dealExecuted) {
        const agreement = insurance.executedDetails.agreement;
        scores[agreement.bidderPlayerName] += agreement.bidderRequirement;
        for (const defenderName in agreement.defenderOffers) {
            scores[defenderName] -= agreement.defenderOffers[defenderName];
        }
        roundMessage = `Insurance deal executed. Points exchanged based on agreement.`;
    } else {
        const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
        const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
        if (scoreDifferenceFrom60 === 0) { roundMessage = `${bidWinnerName} scored exactly 60. No points exchanged.`; } 
        else if (bidMadeSuccessfully) { let totalPointsGained = 0; playerOrderActive.forEach(pName => { if (pName !== bidWinnerName) { scores[pName] -= exchangeValue; totalPointsGained += exchangeValue; } }); scores[bidWinnerName] += totalPointsGained; roundMessage = `${bidWinnerName} succeeded! Gains ${totalPointsGained} points.`; } 
        else { let totalPointsLost = 0; const activeOpponents = playerOrderActive.filter(pName => pName !== bidWinnerName); activeOpponents.forEach(oppName => { scores[oppName] += exchangeValue; totalPointsLost += exchangeValue; }); if (playerMode === 3) { scores[PLACEHOLDER_ID] += exchangeValue; totalPointsLost += exchangeValue; } else if (playerMode === 4) { const dealerName = getPlayerNameByPlayerId(table.dealer, table); if (dealerName && !playerOrderActive.includes(dealerName)) { scores[dealerName] += exchangeValue; totalPointsLost += exchangeValue; } } scores[bidWinnerName] -= totalPointsLost; roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLost} points.`; }
    }

    let isGameOver = false;
    let gameWinner = null;
    const finalPlayerScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID);

    if(finalPlayerScores.some(([,score]) => score <= 0)) {
        isGameOver = true;
        const sortedScores = finalPlayerScores.sort((a,b) => b[1] - a[1]);
        
        // --- FIX: Add a check to prevent crashing on an empty scores array ---
        if (sortedScores.length > 0) {
            gameWinner = sortedScores[0][0];
            roundMessage += ` GAME OVER! Winner: ${gameWinner}.`;
        } else {
            gameWinner = "N/A";
            roundMessage += ` GAME OVER! No winner could be determined.`;
        }
        table.state = "Game Over";
    } else {
        table.state = "Awaiting Next Round Trigger";
    }

    table.roundSummary = { bidWinnerName, bidType, trumpSuit: table.trumpSuit, bidderCardPoints, defenderCardPoints, awardedWidowInfo, bidMadeSuccessfully, scoresBeforeExchange, finalScores: scores, isGameOver, gameWinner, message: roundMessage, dealerOfRoundId: table.dealer };
    emitTableUpdate(tableId);
}

function prepareNextRound(tableId) {
    const table = tables[tableId];
    if (!table || !table.gameStarted) return;
    const lastDealerId = table.roundSummary?.dealerOfRoundId || table.dealer;
    const allPlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator);
    if (allPlayerIds.length < 3) { return resetTable(tableId, true); }
    const lastDealerIndex = allPlayerIds.indexOf(lastDealerId);
    const nextDealerIndex = (lastDealerIndex !== -1 ? lastDealerIndex + 1 : 1) % allPlayerIds.length;
    table.dealer = allPlayerIds[nextDealerIndex];
    table.playerOrderActive = [];
    const currentDealerIndex = allPlayerIds.indexOf(table.dealer);
    if (table.playerMode === 4) {
        for (let i = 1; i <= 3; i++) {
            const activePlayerId = allPlayerIds[(currentDealerIndex + i) % 4];
            table.playerOrderActive.push(getPlayerNameByPlayerId(activePlayerId, table));
        }
    } else {
        for (let i = 1; i <= 3; i++) {
            const activePlayerId = allPlayerIds[(currentDealerIndex + i) % 3];
            table.playerOrderActive.push(getPlayerNameByPlayerId(activePlayerId, table));
        }
    }
    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    emitTableUpdate(tableId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on port ${PORT}`); });