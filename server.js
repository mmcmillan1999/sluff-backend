// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "4.5.0 - Full Game Logic & Bug Fixes";
console.log(`LOBBY SERVER (${SERVER_VERSION}): Initializing...`);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['polling', 'websocket']
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
const deck = Object.keys(SUITS).flatMap(suit => RANKS_ORDER.map(rank => rank + suit));

// --- Global State ---
let tables = {};
let players = {};

// --- Helper & State Management Functions ---
const getInitialInsuranceState = () => ({ isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0, defenderOffers: {}, dealExecuted: false, executedDetails: null });

const getInitialGameData = (tableId) => ({
    tableId, state: "Waiting for Players to Join", players: {}, playerIds: [], playerOrderActive: [],
    dealer: null, hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [],
    scores: {}, bidsThisRound: [], currentHighestBidDetails: null, biddingTurnPlayerName: null,
    bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false, trumpSuit: null,
    bidWinnerInfo: null, gameStarted: false, currentTrickCards: [], trickTurnPlayerName: null,
    tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false, trickLeaderName: null,
    capturedTricks: {}, roundSummary: null, lastCompletedTrick: null, playersWhoPassedThisRound: [],
    playerMode: null, serverVersion: SERVER_VERSION, insurance: getInitialInsuranceState(), spectators: {}
});

const initializeTables = () => {
    for (let i = 1; i <= 3; i++) tables[`table-${i}`] = getInitialGameData(`table-${i}`);
    console.log(`LOBBY SERVER (${SERVER_VERSION}): ${Object.keys(tables).length} tables initialized.`);
};

const getLobbyInfo = () => Object.fromEntries(
    Object.entries(tables).map(([id, table]) => [id, {
        tableId: id, playerCount: Object.values(table.players).filter(p => !p.disconnected).length,
        spectatorCount: Object.keys(table.spectators).length, state: table.state,
        playerNames: Object.values(table.players).map(p => p.name)
    }])
);

const getPlayerNameById = (playerId, table) => table?.players[playerId]?.name || players[playerId]?.name || playerId;
const shuffle = (array) => { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; };
const getSuit = (cardStr) => cardStr ? cardStr.slice(-1) : null;
const getRank = (cardStr) => cardStr ? cardStr.slice(0, -1) : null;
const calculateCardPoints = (cards) => (cards || []).reduce((sum, card) => sum + (CARD_POINT_VALUES[getRank(card)] || 0), 0);

const initializeNewRoundState = (table) => {
    Object.assign(table, {
        hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [],
        bidsThisRound: [], currentHighestBidDetails: null, trumpSuit: null, bidWinnerInfo: null,
        biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null,
        soloBidMadeAfterFrog: false, currentTrickCards: [], trickTurnPlayerName: null,
        tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
        trickLeaderName: null, capturedTricks: {}, roundSummary: null,
        lastCompletedTrick: null, playersWhoPassedThisRound: [], insurance: getInitialInsuranceState()
    });
    table.playerOrderActive.forEach(pName => { if(pName) table.capturedTricks[pName] = []; });
};

const resetTableData = (tableId) => {
    if (!tables[tableId]) return;
    const oldTable = { ...tables[tableId] };
    tables[tableId] = getInitialGameData(tableId);
    Object.keys(oldTable.players).forEach(pId => { if (players[pId]) tables[tableId].spectators[pId] = players[pId].name; });
    Object.keys(oldTable.spectators).forEach(pId => { if (players[pId]) tables[tableId].spectators[pId] = players[pId].name; });
};

const determineTrickWinner = (trickCards, leadSuit, trumpSuit) => {
    if (!trickCards || trickCards.length === 0) return null;
    let winningPlay = trickCards[0];
    for (let i = 1; i < trickCards.length; i++) {
        const play = trickCards[i];
        const winningSuit = getSuit(winningPlay.card);
        const playSuit = getSuit(play.card);
        if (playSuit === winningSuit) {
            if (RANKS_ORDER.indexOf(getRank(play.card)) > RANKS_ORDER.indexOf(getRank(winningPlay.card))) winningPlay = play;
        } else if (playSuit === trumpSuit && winningSuit !== trumpSuit) {
            winningPlay = play;
        }
    }
    return winningPlay.playerId;
};

const transitionToPlayingPhase = (table) => {
    table.state = "Playing Phase";
    const bidWinnerName = getPlayerNameById(table.bidWinnerInfo.playerId, table);
    table.trickLeaderName = bidWinnerName;
    table.trickTurnPlayerName = bidWinnerName;
    io.to(table.tableId).emit("gameState", table);
};

const calculateRoundScores = (table) => {
    if (!table.bidWinnerInfo || table.tricksPlayedCount !== 11) return;
    const bidWinnerName = table.bidWinnerInfo.playerName;
    const bidType = table.bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    let bidderTotalCardPoints = 0; let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };

    Object.entries(table.capturedTricks).forEach(([name, tricks]) => {
        const points = tricks.reduce((sum, trick) => sum + calculateCardPoints(trick), 0);
        if (name === bidWinnerName) bidderTotalCardPoints += points;
        else defendersTotalCardPoints += points;
    });

    if (bidType === "Frog") {
        const widowPoints = calculateCardPoints(table.widowDiscardsForFrogBidder);
        awardedWidowInfo = { cards: [...table.widowDiscardsForFrogBidder], points: widowPoints, awardedTo: bidWinnerName };
        bidderTotalCardPoints += widowPoints;
    } else if (bidType === "Solo") {
        const widowPoints = calculateCardPoints(table.originalDealtWidow);
        awardedWidowInfo = { cards: [...table.originalDealtWidow], points: widowPoints, awardedTo: bidWinnerName };
        bidderTotalCardPoints += widowPoints;
    } else if (bidType === "Heart Solo") {
        const widowPoints = calculateCardPoints(table.originalDealtWidow);
        awardedWidowInfo = { cards: [...table.originalDealtWidow], points: widowPoints, awardedTo: table.trickLeaderName };
        if (table.trickLeaderName === bidWinnerName) bidderTotalCardPoints += widowPoints;
        else defendersTotalCardPoints += widowPoints;
    }
    
    let roundMessage = "";
    const bidMadeSuccessfully = bidderTotalCardPoints > 60;
    const pointsDelta = Math.abs(bidderTotalCardPoints - 60);
    const exchangeValue = pointsDelta * currentBidMultiplier;
    
    if (pointsDelta === 0) {
        roundMessage = `${bidWinnerName} scored exactly 60. No points exchanged.`;
    } else if (bidMadeSuccessfully) {
        roundMessage = `${bidWinnerName} succeeded! Each defender pays ${exchangeValue}.`;
        table.playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) table.scores[pName] -= exchangeValue;
        });
        table.scores[bidWinnerName] += exchangeValue * (table.playerOrderActive.length - 1);
    } else { // Bid failed
        roundMessage = `${bidWinnerName} failed! Pays ${exchangeValue} to each opponent.`;
        const opponents = table.playerOrderActive.filter(p => p !== bidWinnerName);
        if (table.playerMode === 4) {
            const dealerName = getPlayerNameById(table.dealer, table);
            if (!table.playerOrderActive.includes(dealerName)) opponents.push(dealerName);
        } else { // 3 player mode
             opponents.push(PLACEHOLDER_ID);
        }
        
        opponents.forEach(oppName => {
            if(table.scores[oppName] !== undefined) table.scores[oppName] += exchangeValue;
        });
        table.scores[bidWinnerName] -= exchangeValue * opponents.length;
    }

    let isGameOver = Object.values(table.scores).some(score => score <= 0 && score !== table.scores[PLACEHOLDER_ID]);
    if(isGameOver) {
        table.state = "Game Over";
    } else {
        table.state = "Awaiting Next Round Trigger";
    }

    table.roundSummary = { bidWinnerName, bidType, bidderCardPoints, message: roundMessage, isGameOver, finalScores: {...table.scores}, dealerOfRoundSocketId: table.dealer };
    io.to(table.tableId).emit("gameState", table);
};

const prepareNextRound = (table) => {
    if (!table) return;
    const numPlayers = table.playerIds.length;
    if (numPlayers < 3) return resetTableData(table.tableId);
    
    let lastDealerId = table.roundSummary?.dealerOfRoundSocketId || table.dealer;
    let lastDealerIndex = table.playerIds.indexOf(lastDealerId);
    if (lastDealerIndex === -1) lastDealerIndex = 0;
    
    const nextDealerId = table.playerIds[(lastDealerIndex + 1) % numPlayers];
    table.dealer = nextDealerId;
    
    const nextDealerIndexInIds = table.playerIds.indexOf(table.dealer);
    table.playerOrderActive = [];
    if(table.playerMode === 4) {
        for (let i = 1; i <= 3; i++) table.playerOrderActive.push(getPlayerNameById(table.playerIds[(nextDealerIndexInIds + i) % numPlayers], table));
    } else { // 3-player
        for (let i = 0; i < 3; i++) table.playerOrderActive.push(getPlayerNameById(table.playerIds[(nextDealerIndexInIds + i + 1) % numPlayers], table));
    }

    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    io.to(table.tableId).emit("gameState", table);
};


// --- Socket Handlers ---
io.on("connection", (socket) => {
    socket.on("requestPlayerId", (existingPlayerId) => {
        let pId = existingPlayerId;
        if (pId && players[pId]) {
            players[pId].socketId = socket.id;
            const { currentTableId } = players[pId];
            if (currentTableId && tables[currentTableId]) {
                const table = tables[currentTableId];
                if (table.players[pId]) table.players[pId].disconnected = false;
                socket.join(currentTableId);
                io.to(currentTableId).emit("gameState", table);
                io.emit("lobbyInfo", getLobbyInfo());
            }
        } else {
            pId = uuidv4();
            players[pId] = { name: null, socketId: socket.id, currentTableId: null };
        }
        socket.emit("playerInfo", { playerId: pId, name: players[pId].name });
        socket.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("submitName", ({ name, playerId }) => {
        if (!players[playerId]) return;
        if (Object.values(players).some(p => p.name === name && p.socketId !== socket.id)) return socket.emit("error", "Name is already in use.");
        players[playerId].name = name;
        socket.emit("playerInfo", { playerId, name });
        io.emit("lobbyInfo", getLobbyInfo());
    });

    socket.on("joinTable", ({ tableId, playerId }) => {
        const table = tables[tableId];
        const player = players[playerId];
        if (!table || !player || !player.name) return;
        if (player.currentTableId && player.currentTableId !== tableId) return socket.emit("error", "You must leave your current table first.");
        
        player.currentTableId = tableId;
        socket.join(tableId);
        
        const canJoinAsPlayer = Object.keys(table.players).length < 4 && !table.gameStarted;
        if (canJoinAsPlayer) {
            if (!table.players[playerId]) {
                table.players[playerId] = { name: player.name, disconnected: false };
                table.playerIds.push(playerId);
                table.scores[player.name] = 120;
                delete table.spectators[playerId];
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

        if (table.players[playerId]){
            if(table.gameStarted){
                table.players[playerId].disconnected = true;
            } else {
                delete table.players[playerId];
                table.playerIds = table.playerIds.filter(id => id !== playerId);
                delete table.scores[player.name];
            }
        }
        if (table.spectators[playerId]) delete table.spectators[playerId];

        const numPlayers = Object.values(table.players).filter(p => !p.disconnected).length;
        if (!table.gameStarted) table.state = numPlayers < 3 ? "Waiting for Players to Join" : "Ready to Start 3P or Wait";
        
        socket.emit("gameState", null);
        io.to(tableId).emit("gameState", table);
        io.emit("lobbyInfo", getLobbyInfo());
    });
    
    const startGame = (tableId, mode) => {
        const table = tables[tableId];
        if (!table || table.gameStarted || Object.keys(table.players).length !== mode) return;
        table.playerMode = mode; table.gameStarted = true;
        prepareNextRound(table);
    };
    socket.on("startThreePlayerGame", ({ tableId }) => startGame(tableId, 3));
    socket.on("startGame", ({ tableId }) => startGame(tableId, 4));

    socket.on("dealCards", ({ tableId, playerId }) => {
        const table = tables[tableId];
        if (!table || table.state !== "Dealing Pending" || playerId !== table.dealer) return;
        
        const shuffledDeck = shuffle([...deck]);
        table.playerOrderActive.forEach((pName, i) => { table.hands[pName] = shuffledDeck.slice(i * 11, (i + 1) * 11); });
        const dealtCount = 11 * table.playerOrderActive.length;
        table.widow = shuffledDeck.slice(dealtCount, dealtCount + 3);
        table.originalDealtWidow = [...table.widow];
        table.state = "Bidding Phase";
        table.biddingTurnPlayerName = table.playerOrderActive[0];
        io.to(tableId).emit("gameState", table);
    });

    const resolveBiddingFinal = (table) => {
        table.bidWinnerInfo = table.currentHighestBidDetails;
        if (!table.bidWinnerInfo) {
            table.state = "Round Skipped";
            setTimeout(() => { if (table.state === "Round Skipped") prepareNextRound(table); }, 3000);
        } else if (table.bidWinnerInfo.bid === "Frog") {
            table.trumpSuit = "H"; table.state = "FrogBidderConfirmWidow";
        } else if (table.bidWinnerInfo.bid === "Heart Solo") {
            table.trumpSuit = "H"; transitionToPlayingPhase(table);
        } else { // Solo
            table.state = "Trump Selection";
        }
        io.to(table.tableId).emit("gameState", table);
    };

    socket.on("placeBid", ({ tableId, playerId, bid }) => {
        const table = tables[tableId];
        const pName = getPlayerNameById(playerId, table);
        if (!table || !pName || table.state !== "Bidding Phase" || pName !== table.biddingTurnPlayerName || table.playersWhoPassedThisRound.includes(pName)) return;

        const currentHighestBidIndex = table.currentHighestBidDetails ? BID_HIERARCHY.indexOf(table.currentHighestBidDetails.bid) : -1;
        if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;
        
        table.bidsThisRound.push({ playerId, playerName: pName, bid });
        if (bid !== "Pass") table.currentHighestBidDetails = { playerId, playerName: pName, bid };
        else table.playersWhoPassedThisRound.push(pName);

        // This is the fixed condition
        const endBidding = (table.playersWhoPassedThisRound.length === table.playerOrderActive.length) || (table.currentHighestBidDetails && table.playersWhoPassedThisRound.length === table.playerOrderActive.length - 1);
        
        if (endBidding) {
            resolveBiddingFinal(table);
        } else {
            let currentIdx = table.playerOrderActive.indexOf(pName);
            do { currentIdx = (currentIdx + 1) % table.playerOrderActive.length; } 
            while (table.playersWhoPassedThisRound.includes(table.playerOrderActive[currentIdx]));
            table.biddingTurnPlayerName = table.playerOrderActive[currentIdx];
            io.to(tableId).emit("gameState", table);
        }
    });
    
    socket.on("frogBidderConfirmsWidowTake", ({ tableId, playerId }) => {
        const table = tables[tableId];
        if (!table || table.state !== "FrogBidderConfirmWidow" || table.bidWinnerInfo.playerId !== playerId) return;
        table.state = "Frog Widow Exchange";
        // The server doesn't emit 'promptFrogWidowExchange' to a specific player ID with socket.io v3+, use the socket object itself.
        const playerSocket = io.sockets.sockets.get(players[playerId].socketId);
        if(playerSocket) playerSocket.emit("promptFrogWidowExchange", { widow: [...table.originalDealtWidow] });
        io.to(tableId).emit("gameState", table);
    });

    socket.on("submitFrogDiscards", ({ tableId, playerId, discards }) => {
        const table = tables[tableId];
        const pName = getPlayerNameById(playerId, table);
        if (!table || table.state !== "Frog Widow Exchange" || table.bidWinnerInfo.playerId !== playerId || discards.length !== 3) return;
        const combinedHand = [...table.hands[pName], ...table.originalDealtWidow];
        if (discards.some(d => !combinedHand.includes(d))) return;
        
        table.hands[pName] = combinedHand.filter(c => !discards.includes(c));
        table.widowDiscardsForFrogBidder = [...discards];
        transitionToPlayingPhase(table);
    });

    socket.on("chooseTrump", ({ tableId, playerId, suit }) => {
        const table = tables[tableId];
        if (!table || table.state !== "Trump Selection" || table.bidWinnerInfo.playerId !== playerId || !["D", "S", "C"].includes(suit)) return;
        table.trumpSuit = suit;
        transitionToPlayingPhase(table);
    });

    socket.on("playCard", ({ tableId, playerId, card }) => {
        const table = tables[tableId];
        const pName = getPlayerNameById(playerId, table);
        if (!table || !pName || table.state !== "Playing Phase" || pName !== table.trickTurnPlayerName) return;

        const hand = table.hands[pName];
        if (!hand.includes(card)) return;

        const playedSuit = getSuit(card);
        if (table.currentTrickCards.length > 0) {
            if (playedSuit !== table.leadSuitCurrentTrick && hand.some(c => getSuit(c) === table.leadSuitCurrentTrick)) return socket.emit("error", `Must follow suit.`);
        } else {
            table.leadSuitCurrentTrick = playedSuit;
        }

        if(playedSuit === table.trumpSuit) table.trumpBroken = true;
        table.hands[pName] = hand.filter(c => c !== card);
        table.currentTrickCards.push({ playerId, playerName: pName, card });

        if (table.currentTrickCards.length === table.playerOrderActive.length) {
            const winnerId = determineTrickWinner(table.currentTrickCards, table.leadSuitCurrentTrick, table.trumpSuit);
            const winnerName = getPlayerNameById(winnerId, table);
            if(winnerName) table.capturedTricks[winnerName].push(table.currentTrickCards.map(p=>p.card));

            table.lastCompletedTrick = { cards: [...table.currentTrickCards], winnerName, leadSuit: table.leadSuitCurrentTrick, trickNumber: table.tricksPlayedCount + 1 };
            table.tricksPlayedCount++;
            table.trickLeaderName = winnerName;

            if (table.tricksPlayedCount === 11) {
                calculateRoundScores(table);
            } else {
                table.state = "TrickCompleteLinger";
                io.to(tableId).emit("gameState", table);
                setTimeout(() => {
                    if (table.state === "TrickCompleteLinger") {
                        table.currentTrickCards = [];
                        table.leadSuitCurrentTrick = null;
                        table.trickTurnPlayerName = winnerName;
                        table.state = "Playing Phase";
                        io.to(tableId).emit("gameState", table);
                    }
                }, 2000);
            }
        } else {
            const currentTurnIndex = table.playerOrderActive.indexOf(pName);
            table.trickTurnPlayerName = table.playerOrderActive[(currentTurnIndex + 1) % table.playerOrderActive.length];
            io.to(tableId).emit("gameState", table);
        }
    });
    
    socket.on("requestNextRound", ({tableId, playerId}) => {
        const table = tables[tableId];
        if(!table || table.state !== "Awaiting Next Round Trigger" || table.roundSummary.dealerOfRoundSocketId !== playerId) return;
        prepareNextRound(table);
    });
    
    socket.on("takeSeat", ({ tableId, playerId }) => {
        const table = tables[tableId];
        const player = players[playerId];
        if (!table || !player || !table.spectators[playerId] || table.gameStarted) return;
        if (Object.keys(table.players).length >= 4) return;
        
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

    socket.on("disconnect", (reason) => {
        const pId = Object.keys(players).find(id => players[id].socketId === socket.id);
        if (!pId) return;
        const player = players[pId];
        if(player.currentTableId && tables[player.currentTableId]?.players[pId]) {
            tables[player.currentTableId].players[pId].disconnected = true;
            io.to(player.currentTableId).emit("gameState", tables[player.currentTableId]);
            io.emit("lobbyInfo", getLobbyInfo());
        }
    });

    socket.on("requestBootAll", ({tableId}) => { resetTableData(tableId); io.to(tableId).emit("gameState", tables[tableId]); io.emit("lobbyInfo", getLobbyInfo()); });
});

initializeTables();
server.listen(process.env.PORT || 3000, () => console.log(`Server ${SERVER_VERSION} running.`));
