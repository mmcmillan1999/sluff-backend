// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors =require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "2.1.4 - New Scoring Logic"; // UPDATED SERVER VERSION
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initializing...`);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['polling', 'websocket']
});

console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Socket.IO Server initialized.`);

io.engine.on("connection_error", (err) => {
  console.error(`!!!! [${SERVER_VERSION} ENGINE EVENT] Connection Error !!!!`);
  console.error(`!!!!    Error Code: ${err.code}`);
  console.error(`!!!!    Error Message: ${err.message}`);
  if (err.context) console.error(`!!!!    Error Context:`, err.context);
  if (err.req) console.error(`!!!!    Request Details: Method=${err.req.method}, URL=${err.req.url}, Origin=${err.req.headers?.origin}`);
  else console.error(`!!!!    Request object (err.req) was undefined for this engine error.`);
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
});

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"];
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];

let deck = [];
for (const suitKey in SUITS) {
  for (const rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Constants and Deck initialized.`);

let gameData = {
  state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
  playerOrderActive: [], dealer: null,
  hands: {}, widow: [], originalDealtWidow: [],
  widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null,
  biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
  trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
  trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
  trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
  revealedWidowForFrog: []
};
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initial gameData structure defined.`);

function getPlayerNameById(socketId) { return gameData.players[socketId]; }
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

function initializeNewRoundState() {
    gameData.hands = {}; gameData.widow = []; gameData.originalDealtWidow = [];
    gameData.widowDiscardsForFrogBidder = []; gameData.bidsThisRound = [];
    gameData.currentHighestBidDetails = null; gameData.trumpSuit = null;
    gameData.bidWinnerInfo = null; gameData.biddingTurnPlayerName = null;
    gameData.bidsMadeCount = 0; gameData.originalFrogBidderId = null;
    gameData.soloBidMadeAfterFrog = false; gameData.currentTrickCards = [];
    gameData.trickTurnPlayerName = null; gameData.tricksPlayedCount = 0;
    gameData.leadSuitCurrentTrick = null; gameData.trumpBroken = false;
    gameData.trickLeaderName = null; gameData.capturedTricks = {};
    gameData.roundSummary = null;
    gameData.revealedWidowForFrog = [];
    Object.values(gameData.players).forEach(pName => {
        if(pName && gameData.scores[pName] !== undefined) gameData.capturedTricks[pName] = [];
    });
    console.log(`[${SERVER_VERSION}] New round state initialized.`);
}

function resetFullGameData() {
    console.log(`[${SERVER_VERSION}] Performing full game data reset.`);
    gameData = {
        state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
        playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
        widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null,
        biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
        trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
        revealedWidowForFrog: []
    };
}

function determineTrickWinner(trickCards, leadSuit, trumpSuit) {
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
    else if (trickCards.length > 0) winningPlay = trickCards[0];
    return winningPlay ? winningPlay.playerName : null;
}

function transitionToPlayingPhase() {
    gameData.state = "Playing Phase";
    gameData.tricksPlayedCount = 0;
    gameData.trumpBroken = false;
    gameData.currentTrickCards = [];
    gameData.leadSuitCurrentTrick = null;
    if (gameData.bidWinnerInfo && gameData.bidWinnerInfo.playerName) {
        gameData.trickLeaderName = gameData.bidWinnerInfo.playerName;
        gameData.trickTurnPlayerName = gameData.bidWinnerInfo.playerName;
    } else {
        console.error(`[${SERVER_VERSION} ERROR] Cannot transition to playing phase: bidWinnerInfo or playerName not set.`);
        gameData.state = "Error - Bid Winner Not Set for Play";
        io.emit("gameState", gameData); return;
    }
    console.log(`[${SERVER_VERSION}] Transitioning to Playing Phase. Bid Winner: ${gameData.bidWinnerInfo.playerName}, Trump: ${gameData.trumpSuit}`);
    io.emit("gameState", gameData);
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Helper functions defined.`);

io.on("connection", (socket) => {
  console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData);

  socket.on("submitName", (name) => {
    if (gameData.players[socket.id] === name) {
        socket.emit("playerJoined", { playerId: socket.id, name });
        io.emit("gameState", gameData); return;
    }
    if (Object.values(gameData.players).includes(name)) return socket.emit("error", "Name already taken.");
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) return socket.emit("error", "Room full.");
    if (gameData.gameStarted && !gameData.players[socket.id] && Object.keys(gameData.players).length >=4) return socket.emit("error", "Game in progress and full.");

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) gameData.playerSocketIds.push(socket.id);
    if(gameData.scores[name] === undefined) gameData.scores[name] = 120;
    socket.emit("playerJoined", { playerId: socket.id, name });
    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted && numPlayers === 4) gameData.state = "Ready to Start";
    else if (!gameData.gameStarted && numPlayers < 4) gameData.state = "Waiting for Players to Join";
    io.emit("gameState", gameData);
  });

  socket.on("startGame", () => {
    if (gameData.state !== "Ready to Start" || Object.keys(gameData.players).length !== 4) return socket.emit("error", "Not ready.");
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]);
    gameData.dealer = gameData.playerSocketIds[0];
    gameData.playerOrderActive = [];
    for (let i = 1; i <= 3; i++) {
        const activePlayerSocketId = gameData.playerSocketIds[(gameData.playerSocketIds.indexOf(gameData.dealer) + i) % gameData.playerSocketIds.length];
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }
    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    if (gameData.state !== "Dealing Pending" || !gameData.dealer || socket.id !== gameData.dealer) return socket.emit("error", "Not dealer or not dealing phase.");
    if (gameData.playerOrderActive.length !== 3) return socket.emit("error", "Active player setup error.");
    const shuffledDeck = shuffle([...deck]);
    gameData.playerOrderActive.forEach((activePName, i) => {
        if (activePName) gameData.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
    });
    const cardsDealtToPlayers = 11 * gameData.playerOrderActive.length;
    gameData.widow = shuffledDeck.slice(cardsDealtToPlayers, cardsDealtToPlayers + 3);
    gameData.originalDealtWidow = [...gameData.widow];
    gameData.state = "Bidding Phase";
    gameData.bidsMadeCount = 0; gameData.bidsThisRound = []; gameData.currentHighestBidDetails = null;
    gameData.biddingTurnPlayerName = gameData.playerOrderActive[0];
    gameData.roundSummary = null;
    io.emit("gameState", gameData);
  });

  function checkForFrogUpgrade() {
    const isFrogBidderHighestOrSoloByOtherIsHighest =
        gameData.currentHighestBidDetails &&
        ( (gameData.currentHighestBidDetails.bid === "Frog" && gameData.currentHighestBidDetails.playerId === gameData.originalFrogBidderId) ||
          (gameData.currentHighestBidDetails.bid === "Solo" && gameData.currentHighestBidDetails.playerId !== gameData.originalFrogBidderId && gameData.soloBidMadeAfterFrog) );
    if (gameData.originalFrogBidderId && gameData.soloBidMadeAfterFrog && isFrogBidderHighestOrSoloByOtherIsHighest &&
        (!gameData.currentHighestBidDetails || gameData.currentHighestBidDetails.bid !== "Heart Solo") ) {
        const alreadyUpgraded = gameData.bidsThisRound.some(b => b.playerId === gameData.originalFrogBidderId && b.bidValue === "Heart Solo" && b.bidType === "FrogUpgradeDecision");
        if (alreadyUpgraded) { resolveBiddingFinal(); return; }
        gameData.state = "Awaiting Frog Upgrade Decision";
        gameData.biddingTurnPlayerName = getPlayerNameById(gameData.originalFrogBidderId);
        io.to(gameData.originalFrogBidderId).emit("promptFrogUpgrade");
        io.emit("gameState", gameData); return;
    }
    resolveBiddingFinal();
  }

  function resolveBiddingFinal() {
    if (!gameData.currentHighestBidDetails) {
        gameData.state = "Round Skipped"; gameData.revealedWidowForFrog = [];
        setTimeout(() => { if (gameData.state === "Round Skipped") prepareNextRound(); }, 5000);
    } else {
      gameData.bidWinnerInfo = { ...gameData.currentHighestBidDetails };
      if (gameData.bidWinnerInfo.bid === "Frog") {
        gameData.trumpSuit = "H"; gameData.state = "FrogBidderConfirmWidow";
        io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogBidderConfirmWidow");
      } else {
        gameData.revealedWidowForFrog = [];
        if (gameData.bidWinnerInfo.bid === "Heart Solo") { gameData.trumpSuit = "H"; transitionToPlayingPhase(); }
        else if (gameData.bidWinnerInfo.bid === "Solo") { gameData.state = "Trump Selection"; io.to(gameData.bidWinnerInfo.playerId).emit("promptChooseTrump"); }
        else { gameData.state = "Error - Invalid Bid Outcome"; }
      }
    }
    gameData.originalFrogBidderId = null; gameData.soloBidMadeAfterFrog = false;
    io.emit("gameState", gameData);
  }

  socket.on("placeBid", ({ bid }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found.");
    if (gameData.state === "Awaiting Frog Upgrade Decision") {
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return socket.emit("error", "Invalid frog upgrade.");
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        gameData.bidsMadeCount = 0; gameData.biddingTurnPlayerName = null;
        resolveBiddingFinal(); return;
    }
    if (gameData.state !== "Bidding Phase" || pName !== gameData.biddingTurnPlayerName || !BID_HIERARCHY.includes(bid)) return socket.emit("error", "Invalid bid action.");
    const currentHighestBidIndex = gameData.currentHighestBidDetails ? BID_HIERARCHY.indexOf(gameData.currentHighestBidDetails.bid) : -1;
    if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return socket.emit("error", "Bid not high enough.");
    gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "RegularBid", bidValue: bid });
    if (bid !== "Pass") {
      gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid };
      if (pName === gameData.playerOrderActive[0] && bid === "Frog" && !gameData.originalFrogBidderId) gameData.originalFrogBidderId = socket.id;
      else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) gameData.soloBidMadeAfterFrog = true;
    }
    gameData.bidsMadeCount++;
    if (gameData.bidsMadeCount >= gameData.playerOrderActive.length) {
      const nonPassBids = gameData.bidsThisRound.filter(b => b.bidValue !== "Pass" && b.bidType === "RegularBid");
      const lastRealBidIndex = nonPassBids.length > 0 ? gameData.bidsThisRound.lastIndexOf(nonPassBids[nonPassBids.length - 1]) : -1;
      let passesToConsider = (lastRealBidIndex !== -1) ? gameData.bidsThisRound.slice(lastRealBidIndex + 1) : gameData.bidsThisRound;
      const passesSinceLastRealBidOrStart = passesToConsider.filter(b => b.bidValue === "Pass" && b.bidType === "RegularBid").length;
      if ( (gameData.currentHighestBidDetails && passesSinceLastRealBidOrStart >= (gameData.playerOrderActive.length - 1) ) ||
           (!gameData.currentHighestBidDetails && gameData.bidsMadeCount === gameData.playerOrderActive.length) ) {
        gameData.biddingTurnPlayerName = null; gameData.bidsMadeCount = 0; checkForFrogUpgrade();
      } else {
        let currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
        let nextBidderName = null;
        for (let i = 1; i < gameData.playerOrderActive.length; i++) {
            let nextIndex = (currentBidderIndexInActiveOrder + i) % gameData.playerOrderActive.length;
            let potentialNextBidder = gameData.playerOrderActive[nextIndex];
            const hasPassedThisRoundAfterCurrentHighest = gameData.bidsThisRound.find(b => b.playerName === potentialNextBidder && b.bidValue === "Pass" && b.bidType === "RegularBid" && (lastRealBidIndex === -1 || gameData.bidsThisRound.indexOf(b) > lastRealBidIndex) );
            if (!hasPassedThisRoundAfterCurrentHighest) { nextBidderName = potentialNextBidder; break; }
        }
        if (nextBidderName) gameData.biddingTurnPlayerName = nextBidderName;
        else { gameData.biddingTurnPlayerName = null; gameData.bidsMadeCount = 0; checkForFrogUpgrade(); return; }
        io.emit("gameState", gameData);
      }
    } else {
      const currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      gameData.biddingTurnPlayerName = gameData.playerOrderActive[(currentBidderIndexInActiveOrder + 1) % gameData.playerOrderActive.length];
      io.emit("gameState", gameData);
    }
  });

  socket.on("frogBidderConfirmsWidowTake", () => {
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog" || gameData.state !== "FrogBidderConfirmWidow") return socket.emit("error", "Not authorized or wrong phase.");
    gameData.state = "Frog Widow Exchange"; gameData.revealedWidowForFrog = [...gameData.originalDealtWidow];
    io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogWidowExchange", { widow: [...gameData.originalDealtWidow] });
    io.emit("gameState", gameData);
  });

  socket.on("submitFrogDiscards", ({ discards }) => {
    const pName = getPlayerNameById(socket.id);
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog" || gameData.state !== "Frog Widow Exchange") return socket.emit("error", "Not authorized or wrong phase.");
    if (!Array.isArray(discards) || discards.length !== 3) return socket.emit("error", "Must discard 3 cards.");
    let originalPlayerHand = gameData.hands[pName] || [];
    let combinedForValidation = [...originalPlayerHand, ...gameData.originalDealtWidow];
    let tempCombinedCheck = [...combinedForValidation];
    const allDiscardsValid = discards.every(d => { const i = tempCombinedCheck.indexOf(d); if (i > -1) { tempCombinedCheck.splice(i, 1); return true; } return false; });
    if (!allDiscardsValid) return socket.emit("error", "Invalid discards.");
    let finalHandAfterExchange = combinedForValidation.filter(card => !discards.includes(card));
    gameData.hands[pName] = finalHandAfterExchange.sort();
    gameData.widowDiscardsForFrogBidder = [...discards].sort(); gameData.widow = [...discards].sort();
    gameData.revealedWidowForFrog = [];
    transitionToPlayingPhase();
  });

  socket.on("chooseTrump", (suitKey) => {
    if (gameData.state !== "Trump Selection" || !gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId) return socket.emit("error", "Not authorized or wrong phase.");
    if (!["D", "S", "C"].includes(suitKey)) return socket.emit("error", "Invalid trump for Solo.");
    gameData.trumpSuit = suitKey;
    console.log(`[${SERVER_VERSION}] Trump chosen for Solo: ${suitKey} by ${getPlayerNameById(gameData.bidWinnerInfo.playerId)}`);
    transitionToPlayingPhase();
  });

  socket.on("playCard", ({ card }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName || gameData.state !== "Playing Phase" || pName !== gameData.trickTurnPlayerName) return socket.emit("error", "Invalid play action.");
    const hand = gameData.hands[pName];
    if (!hand || !hand.includes(card)) return socket.emit("error", "Card not in hand.");
    const isLeading = gameData.currentTrickCards.length === 0;
    const playedSuit = getSuit(card);
    if (isLeading) {
        if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken && !hand.every(c => getSuit(c) === gameData.trumpSuit)) return socket.emit("error", "Cannot lead trump yet.");
    } else {
        const leadCardSuit = gameData.leadSuitCurrentTrick;
        if (playedSuit !== leadCardSuit && hand.some(c => getSuit(c) === leadCardSuit)) return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        if (playedSuit !== leadCardSuit && !hand.some(c => getSuit(c) === leadCardSuit) && playedSuit !== gameData.trumpSuit && hand.some(c => getSuit(c) === gameData.trumpSuit)) return socket.emit("error", `Void in lead suit, must play trump.`);
    }
    gameData.hands[pName] = hand.filter(c => c !== card);
    gameData.currentTrickCards.push({ playerId: socket.id, playerName: pName, card });
    if (isLeading) gameData.leadSuitCurrentTrick = playedSuit;
    if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken) gameData.trumpBroken = true;
    if (gameData.currentTrickCards.length === gameData.playerOrderActive.length) {
      const winnerName = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      if (winnerName && gameData.capturedTricks[winnerName]) gameData.capturedTricks[winnerName].push([...gameData.currentTrickCards.map(p => p.card)]);
      else if (winnerName) gameData.capturedTricks[winnerName] = [[...gameData.currentTrickCards.map(p => p.card)]];
      gameData.tricksPlayedCount++; gameData.trickLeaderName = winnerName;
      if (gameData.tricksPlayedCount === 11) calculateRoundScores();
      else { gameData.currentTrickCards = []; gameData.leadSuitCurrentTrick = null; gameData.trickTurnPlayerName = winnerName; io.emit("gameState", gameData); }
    } else {
      const currentIdxInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      gameData.trickTurnPlayerName = gameData.playerOrderActive[(currentIdxInActiveOrder + 1) % gameData.playerOrderActive.length];
      io.emit("gameState", gameData);
    }
  });

  function calculateRoundScores() {
    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        gameData.state = "Error - Scoring PreRequisite"; io.emit("gameState", gameData); return;
    }
    const bidWinnerName = gameData.bidWinnerInfo.playerName;
    const bidType = gameData.bidWinnerInfo.bid;
    const bidMultiplier = {"Frog": 1, "Solo": 2, "Heart Solo": 3}[bidType];
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };

    if (bidType === "Frog") {
        awardedWidowInfo.cards = [...gameData.widow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Solo") {
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Heart Solo") {
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        if (gameData.trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = bidWinnerName;
        } else {
            defendersTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = gameData.trickLeaderName;
        }
    }
    Object.keys(gameData.capturedTricks).forEach(playerName => {
        const playerTrickPoints = (gameData.capturedTricks[playerName] || []).reduce((sum, trick) => sum + calculateCardPoints(trick), 0);
        if (playerName === bidWinnerName) bidderTotalCardPoints += playerTrickPoints;
        else if (gameData.playerOrderActive.includes(playerName)) defendersTotalCardPoints += playerTrickPoints;
    });

    console.log(`[${SERVER_VERSION} SCORING] Bidder Card Pts: ${bidderTotalCardPoints}, Defender Card Pts: ${defendersTotalCardPoints}`);
    if (bidderTotalCardPoints + defendersTotalCardPoints !== 120) console.warn(`[${SERVER_VERSION} SCORING WARNING] Total card points (${bidderTotalCardPoints + defendersTotalCardPoints}) != 120!`);

    const targetPoints = 60;
    const scoreDifferenceFrom60 = bidderTotalCardPoints - targetPoints; // Can be negative, zero, or positive
    const pointsDelta = Math.abs(scoreDifferenceFrom60); // Absolute difference from 60
    const exchangeValuePerPlayer = pointsDelta * bidMultiplier;

    let roundMessage = "";
    let bidMadeSuccessfully = bidderTotalCardPoints > targetPoints;

    if (scoreDifferenceFrom60 === 0) { // Exactly 60 points
        bidMadeSuccessfully = false; // Considered a fail in terms of point exchange
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) scored exactly 60. No game points exchanged.`;
        // No scores change for anyone.
    } else if (bidderTotalCardPoints > targetPoints) { // Bidder succeeds (scores > 60)
        bidMadeSuccessfully = true;
        let totalPointsGainedByBidder = 0;
        const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
        
        activeOpponents.forEach(oppName => {
            gameData.scores[oppName] = (gameData.scores[oppName] || 0) - exchangeValuePerPlayer;
            totalPointsGainedByBidder += exchangeValuePerPlayer;
        });
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) + totalPointsGainedByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) succeeded! Gains ${totalPointsGainedByBidder} pts (receives ${exchangeValuePerPlayer} from each active opponent).`;
    } else { // Bidder fails (scores < 60)
        bidMadeSuccessfully = false;
        let totalPointsLostByBidder = 0;
        
        gameData.playerOrderActive.forEach(pName => { // Active opponents gain
            if (pName !== bidWinnerName) {
                gameData.scores[pName] = (gameData.scores[pName] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
            }
        });
        if (gameData.playerSocketIds.length === 4 && gameData.dealer) { // Inactive dealer also gains
            const dealerNameActual = getPlayerNameById(gameData.dealer);
            if (dealerNameActual && dealerNameActual !== bidWinnerName && !gameData.playerOrderActive.includes(dealerNameActual)) {
                gameData.scores[dealerNameActual] = (gameData.scores[dealerNameActual] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
            }
        }
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) - totalPointsLostByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) failed. Loses ${totalPointsLostByBidder} pts (pays ${exchangeValuePerPlayer} to each recipient).`;
    }

    let isGameOver = false;
    Object.values(gameData.scores).forEach(score => { if (score <= 0) isGameOver = true; });
    let gameWinner = null;
    if (isGameOver) {
        let contenders = []; let highestScore = -Infinity;
        Object.entries(gameData.scores).forEach(([name, score]) => {
            if (score > highestScore) { highestScore = score; contenders = [name]; }
            else if (score === highestScore) contenders.push(name);
        });
        gameWinner = contenders.join(" & ");
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner} with ${highestScore} points.`;
        gameData.state = "Game Over";
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints, defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo, bidMadeSuccessfully, finalScores: { ...gameData.scores },
        isGameOver, gameWinner, message: roundMessage,
        dealerOfRound: gameData.dealer
    };
    console.log(`[${SERVER_VERSION} SCORING] Round Summary:`, gameData.roundSummary);
    const totalGameScore = Object.values(gameData.scores).reduce((sum, score) => sum + (score || 0), 0); // Ensure score is not undefined
    console.log(`[${SERVER_VERSION} SCORING] Sum of all player scores: ${totalGameScore}`);

    if (!isGameOver) gameData.state = "Awaiting Next Round Trigger";
    io.emit("gameState", gameData);
  }

  function prepareNextRound() {
    const numTotalPlayers = gameData.playerSocketIds.length;
    if (numTotalPlayers < 3 || numTotalPlayers > 4) {
        gameData.state = "Error - Player Count Issue"; io.emit("gameState", gameData); return;
    }
    let lastRoundDealerSocketId = gameData.dealer;
    if (!lastRoundDealerSocketId || !gameData.playerSocketIds.includes(lastRoundDealerSocketId)) {
        if (gameData.playerSocketIds.length > 0) lastRoundDealerSocketId = gameData.playerSocketIds[gameData.playerSocketIds.length - 1];
        else { gameData.state = "Error - Cannot Rotate Dealer"; io.emit("gameState", gameData); return; }
    }
    let lastRoundDealerIndexInTableOrder = gameData.playerSocketIds.indexOf(lastRoundDealerSocketId);
    const nextDealerIndexInTableOrder = (lastRoundDealerIndexInTableOrder + 1) % numTotalPlayers;
    gameData.dealer = gameData.playerSocketIds[nextDealerIndexInTableOrder];
    gameData.playerOrderActive = [];
    if (numTotalPlayers === 4) {
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else if (numTotalPlayers === 3) {
        for (let i = 1; i <= numTotalPlayers; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    }
    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    io.emit("gameState", gameData);
  }

  socket.on("requestNextRound", () => {
    const playerName = getPlayerNameById(socket.id);
    if (gameData.state === "Awaiting Next Round Trigger" && gameData.roundSummary && socket.id === gameData.roundSummary.dealerOfRound) {
        prepareNextRound();
    } else {
        let reason = "Not correct state or not authorized.";
        if (gameData.state !== "Awaiting Next Round Trigger") reason = "Not in 'Awaiting Next Round Trigger' state.";
        else if (!gameData.roundSummary) reason = "Round summary not available.";
        else if (socket.id !== gameData.roundSummary.dealerOfRound) reason = "Only the dealer of the last round can start the next round.";
        socket.emit("error", `Cannot start next round: ${reason}`);
    }
  });

  socket.on("resetGame", () => { resetFullGameData(); io.emit("gameState", gameData); });

  socket.on("disconnect", (reason) => {
    const pName = getPlayerNameById(socket.id);
    if (pName) {
        const wasDealer = gameData.dealer === socket.id || (gameData.roundSummary && gameData.roundSummary.dealerOfRound === socket.id);
        delete gameData.players[socket.id];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== socket.id);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        const numPlayers = Object.keys(gameData.players).length;
        if (gameData.gameStarted && numPlayers < 3) resetFullGameData();
        else if (gameData.gameStarted && wasDealer && gameData.state === "Awaiting Next Round Trigger") {
             console.log(`[${SERVER_VERSION} DISCONNECT] Dealer ${pName} disconnected while Awaiting Next Round Trigger.`);
        } else if (gameData.gameStarted && (gameData.biddingTurnPlayerName === pName || gameData.trickTurnPlayerName === pName)) {
            resetFullGameData();
        } else if (!gameData.gameStarted && numPlayers < 4) gameData.state = "Waiting for Players to Join";
        if (numPlayers === 0 && gameData.gameStarted) resetFullGameData();
        io.emit("gameState", gameData);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });
