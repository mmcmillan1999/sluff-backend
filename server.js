// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors =require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "3.0.4 - Insurance Scoring Logic"; // UPDATED SERVER VERSION
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
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Constants and Deck initialized.`);

// --- Helper Function for Initial Insurance State ---
function getInitialInsuranceState() {
    return {
        isActive: false,
        bidMultiplier: null,
        bidderPlayerName: null,
        bidderRequirement: 0,
        defenderOffers: {},
        dealExecuted: false,
        executedDetails: null // Stores { agreement: { bidderPlayerName, bidderRequirement, defenderOffersSnapshot }, pointsExchanged: {playerName: changeAmount,...} }
    };
}

// --- Initial Game Data Structure ---
let gameData = {
  state: "Waiting for Players to Join",
  players: {}, playerSocketIds: [], playerOrderActive: [], dealer: null,
  hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [],
  scores: {}, bidsThisRound: [], currentHighestBidDetails: null, biddingTurnPlayerName: null,
  bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
  trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
  trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
  trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
  revealedWidowForFrog: [], lastCompletedTrick: null, playersWhoPassedThisRound: [],
  playerMode: null, serverVersion: SERVER_VERSION,
  insurance: getInitialInsuranceState()
};
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initial gameData structure defined.`);

// --- Utility Functions ---
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

// --- State Management Functions ---
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
    gameData.roundSummary = null; gameData.revealedWidowForFrog = [];
    gameData.lastCompletedTrick = null; gameData.playersWhoPassedThisRound = [];
    gameData.insurance = getInitialInsuranceState();

    const playersToInitTricksFor = gameData.playerOrderActive.length > 0 ? gameData.playerOrderActive : Object.values(gameData.players);
    playersToInitTricksFor.forEach(pName => {
        if (pName && gameData.scores && gameData.scores[pName] !== undefined) {
            gameData.capturedTricks[pName] = [];
        }
    });
    console.log(`[${SERVER_VERSION}] New round state initialized, insurance reset.`);
}

function resetFullGameData() {
    console.log(`[${SERVER_VERSION}] Performing full game data reset.`);
    const previousPlayers = {...gameData.players};
    gameData = {
        state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
        playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
        widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null,
        biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
        trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
        revealedWidowForFrog: [], lastCompletedTrick: null, playersWhoPassedThisRound: [],
        playerMode: null, serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState()
    };
    console.log(`[${SERVER_VERSION}] Game data fully reset, insurance reset. Previous players: ${Object.values(previousPlayers).join(', ') || 'None'}`);
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
    return winningPlay ? winningPlay.playerName : null;
}

function transitionToPlayingPhase() {
    gameData.state = "Playing Phase";
    gameData.tricksPlayedCount = 0;
    gameData.trumpBroken = false;
    gameData.currentTrickCards = [];
    gameData.leadSuitCurrentTrick = null;
    gameData.lastCompletedTrick = null;

    if (gameData.bidWinnerInfo && gameData.bidWinnerInfo.playerName && gameData.bidWinnerInfo.bid) {
        gameData.trickLeaderName = gameData.bidWinnerInfo.playerName;
        gameData.trickTurnPlayerName = gameData.bidWinnerInfo.playerName;
        const bidWinnerName = gameData.bidWinnerInfo.playerName;
        const bidType = gameData.bidWinnerInfo.bid;
        const currentBidMultiplier = BID_MULTIPLIERS[bidType];
        if (currentBidMultiplier && gameData.playerOrderActive.length === 3) {
            gameData.insurance.isActive = true;
            gameData.insurance.bidMultiplier = currentBidMultiplier;
            gameData.insurance.bidderPlayerName = bidWinnerName;
            gameData.insurance.bidderRequirement = 120 * currentBidMultiplier;
            gameData.insurance.defenderOffers = {};
            gameData.insurance.dealExecuted = false;
            gameData.insurance.executedDetails = null;
            const defenders = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
            if (defenders.length === 2) {
                defenders.forEach(defName => {
                    gameData.insurance.defenderOffers[defName] = -60 * currentBidMultiplier;
                });
                console.log(`[${SERVER_VERSION} INSURANCE] Activated. Bidder: ${bidWinnerName}, Req: ${gameData.insurance.bidderRequirement}, Defenders: ${JSON.stringify(gameData.insurance.defenderOffers)}`);
            } else {
                 console.warn(`[${SERVER_VERSION} INSURANCE WARN] Expected 2 defenders, found ${defenders.length}. Not fully initialized.`);
                 gameData.insurance.isActive = false;
            }
        } else {
            console.log(`[${SERVER_VERSION} INSURANCE] Not activated. Multiplier: ${currentBidMultiplier}, Active Players: ${gameData.playerOrderActive.length}`);
            gameData.insurance = getInitialInsuranceState();
        }
    } else {
        console.error(`[${SERVER_VERSION} ERROR] Cannot transition to playing phase: bidWinnerInfo missing.`);
        gameData.state = "Error - Bid Winner Not Set for Play";
        gameData.insurance = getInitialInsuranceState();
        io.emit("gameState", gameData); return;
    }
    console.log(`[${SERVER_VERSION}] Transitioning to Playing Phase. Bid Winner: ${gameData.bidWinnerInfo.playerName}, Trump: ${SUITS[gameData.trumpSuit] || 'N/A'}`);
    io.emit("gameState", gameData);
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Helper and state functions defined.`);

io.on("connection", (socket) => {
  console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData);

  socket.on("submitName", (name) => {
    if (gameData.players[socket.id] === name) {
        socket.emit("playerJoined", { playerId: socket.id, name }); io.emit("gameState", gameData); return;
    }
    if (Object.values(gameData.players).includes(name)) return socket.emit("error", "Name already taken.");
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) return socket.emit("error", "Room full (max 4 players).");
    if (gameData.gameStarted && !gameData.players[socket.id]) return socket.emit("error", "Game in progress. Cannot join now.");
    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) gameData.playerSocketIds.push(socket.id);
    if(gameData.scores[name] === undefined) gameData.scores[name] = 120;
    socket.emit("playerJoined", { playerId: socket.id, name });
    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted) {
        if (numPlayers === 4) gameData.state = "Ready to Start 4P";
        else if (numPlayers === 3) gameData.state = "Ready to Start 3P or Wait";
        else gameData.state = "Waiting for Players to Join";
    }
    io.emit("gameState", gameData);
  });

  socket.on("startGame", () => {
    if (Object.keys(gameData.players).length !== 4) return socket.emit("error", "Need 4 players.");
    if (gameData.gameStarted) return socket.emit("error", "Game already in progress.");
    gameData.playerMode = 4; gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]);
    gameData.dealer = gameData.playerSocketIds[0];
    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    for (let i = 1; i <= 3; i++) gameData.playerOrderActive.push(gameData.players[gameData.playerSocketIds[(dealerIndex + i) % 4]]);
    initializeNewRoundState(); gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] 4P game started. Dealer: ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  });

  socket.on("startThreePlayerGame", () => {
    if (Object.keys(gameData.players).length !== 3) return socket.emit("error", "Need 3 players.");
    if (gameData.gameStarted) return socket.emit("error", "Game already in progress.");
    gameData.playerMode = 3; gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]);
    gameData.dealer = gameData.playerSocketIds[0];
    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    for (let i = 0; i < 3; i++) gameData.playerOrderActive.push(gameData.players[gameData.playerSocketIds[(dealerIndex + i + 1) % 3]]);
    if (gameData.scores[PLACEHOLDER_ID] === undefined) gameData.scores[PLACEHOLDER_ID] = 120;
    initializeNewRoundState(); gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] 3P game started. Dealer (deals): ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}.`);
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    if (gameData.state !== "Dealing Pending" || !gameData.dealer || socket.id !== gameData.dealer) return socket.emit("error", "Not dealer or not dealing phase.");
    if (!gameData.playerOrderActive || gameData.playerOrderActive.length !== 3) return socket.emit("error", "Active player setup error.");
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
    gameData.roundSummary = null; gameData.lastCompletedTrick = null; gameData.playersWhoPassedThisRound = [];
    gameData.insurance = getInitialInsuranceState();
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
        gameData.lastCompletedTrick = null; gameData.insurance = getInitialInsuranceState();
        console.log(`[${SERVER_VERSION}] All players passed. Round skipped. Preparing next round in 5s.`);
        setTimeout(() => { if (gameData.state === "Round Skipped" && gameData.gameStarted) prepareNextRound(); }, 5000);
    } else {
      gameData.bidWinnerInfo = { ...gameData.currentHighestBidDetails };
      if (gameData.bidWinnerInfo.bid === "Frog") {
        gameData.trumpSuit = "H"; gameData.state = "FrogBidderConfirmWidow";
        io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogBidderConfirmWidow");
      } else {
        gameData.revealedWidowForFrog = [];
        if (gameData.bidWinnerInfo.bid === "Heart Solo") { gameData.trumpSuit = "H"; transitionToPlayingPhase(); }
        else if (gameData.bidWinnerInfo.bid === "Solo") { gameData.state = "Trump Selection"; io.to(gameData.bidWinnerInfo.playerId).emit("promptChooseTrump"); }
        else {
            console.error(`[${SERVER_VERSION} ERROR] Invalid bid outcome: ${gameData.bidWinnerInfo.bid}`);
            gameData.state = "Error - Invalid Bid Outcome"; gameData.insurance = getInitialInsuranceState();
        }
      }
    }
    gameData.originalFrogBidderId = null; gameData.soloBidMadeAfterFrog = false;
    io.emit("gameState", gameData);
  }

  socket.on("placeBid", ({ bid }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found.");
    if (gameData.state === "Awaiting Frog Upgrade Decision") {
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return socket.emit("error", "Invalid frog upgrade bid/pass.");
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        gameData.biddingTurnPlayerName = null; resolveBiddingFinal(); return;
    }
    if (gameData.state !== "Bidding Phase") return socket.emit("error", "Not in Bidding Phase.");
    if (pName !== gameData.biddingTurnPlayerName) return socket.emit("error", "Not your turn to bid.");
    if (!BID_HIERARCHY.includes(bid)) return socket.emit("error", "Invalid bid type.");
    if (gameData.playersWhoPassedThisRound.includes(pName)) return socket.emit("error", "You have already passed.");
    const currentHighestBidIndex = gameData.currentHighestBidDetails ? BID_HIERARCHY.indexOf(gameData.currentHighestBidDetails.bid) : -1;
    if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return socket.emit("error", "Bid is not higher than current highest bid.");
    gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "RegularBid", bidValue: bid });
    if (bid !== "Pass") {
      gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid };
      if (bid === "Frog" && (!gameData.originalFrogBidderId || !gameData.bidsThisRound.some(b => b.playerId === gameData.originalFrogBidderId && b.bidValue !== "Pass"))) {
          if(!gameData.originalFrogBidderId) gameData.originalFrogBidderId = socket.id;
      } else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) gameData.soloBidMadeAfterFrog = true;
    } else {
        if (!gameData.playersWhoPassedThisRound.includes(pName)) gameData.playersWhoPassedThisRound.push(pName);
    }
    const activeBiddersRemaining = gameData.playerOrderActive.filter(playerName => !gameData.playersWhoPassedThisRound.includes(playerName));
    let endBidding = false;
    if (activeBiddersRemaining.length === 0) endBidding = true;
    else if (activeBiddersRemaining.length === 1 && gameData.currentHighestBidDetails && activeBiddersRemaining[0] === gameData.currentHighestBidDetails.playerName) endBidding = true;
    else if (gameData.playersWhoPassedThisRound.length === gameData.playerOrderActive.length) endBidding = true;
    if (!endBidding && gameData.currentHighestBidDetails) {
        const highestBidderName = gameData.currentHighestBidDetails.playerName;
        const otherActivePlayers = gameData.playerOrderActive.filter(player => player !== highestBidderName);
        if (otherActivePlayers.every(player => gameData.playersWhoPassedThisRound.includes(player))) endBidding = true;
    }
    if (endBidding) { gameData.biddingTurnPlayerName = null; checkForFrogUpgrade(); }
    else {
        let currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
        let nextBidderName = null;
        for (let i = 1; i < gameData.playerOrderActive.length; i++) {
            let potentialNextBidder = gameData.playerOrderActive[(currentBidderIndexInActiveOrder + i) % gameData.playerOrderActive.length];
            if (!gameData.playersWhoPassedThisRound.includes(potentialNextBidder)) { nextBidderName = potentialNextBidder; break; }
        }
        if (nextBidderName) gameData.biddingTurnPlayerName = nextBidderName;
        else { gameData.biddingTurnPlayerName = null; checkForFrogUpgrade(); return; }
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
    const allDiscardsValid = discards.every(dCard => {
        const indexInCombined = tempCombinedCheck.indexOf(dCard);
        if (indexInCombined > -1) { tempCombinedCheck.splice(indexInCombined, 1); return true; } return false;
    });
    if (!allDiscardsValid) return socket.emit("error", "Invalid discards.");
    let finalHandAfterExchange = combinedForValidation.filter(card => !discards.includes(card));
    gameData.hands[pName] = finalHandAfterExchange.sort();
    gameData.widowDiscardsForFrogBidder = [...discards].sort(); gameData.widow = [...discards].sort();
    gameData.revealedWidowForFrog = [];
    console.log(`[${SERVER_VERSION}] Player ${pName} (Frog Bidder) discarded: ${discards.join(', ')}.`);
    transitionToPlayingPhase();
  });

  socket.on("chooseTrump", (suitKey) => {
    if (gameData.state !== "Trump Selection" || !gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId) return socket.emit("error", "Not authorized or wrong phase.");
    if (!["D", "S", "C"].includes(suitKey)) return socket.emit("error", "Invalid trump for Solo (must be D, S, or C).");
    gameData.trumpSuit = suitKey;
    console.log(`[${SERVER_VERSION}] Trump chosen for Solo: ${SUITS[suitKey]} by ${getPlayerNameById(gameData.bidWinnerInfo.playerId)}`);
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
        const isHandAllTrump = hand.every(c => getSuit(c) === gameData.trumpSuit);
        if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken && !isHandAllTrump) return socket.emit("error", "Cannot lead trump if not broken (unless hand is all trump).");
    } else {
        const leadCardSuit = gameData.leadSuitCurrentTrick;
        const hasLeadSuit = hand.some(c => getSuit(c) === leadCardSuit);
        const hasTrumpSuit = hand.some(c => getSuit(c) === gameData.trumpSuit);
        if (playedSuit !== leadCardSuit && hasLeadSuit) return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        if (playedSuit !== leadCardSuit && !hasLeadSuit && playedSuit !== gameData.trumpSuit && hasTrumpSuit) return socket.emit("error", `Void in lead suit (${SUITS[leadCardSuit]}), must play trump.`);
    }
    gameData.hands[pName] = hand.filter(c => c !== card);
    gameData.currentTrickCards.push({ playerId: socket.id, playerName: pName, card });
    if (isLeading) gameData.leadSuitCurrentTrick = playedSuit;
    if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken) gameData.trumpBroken = true;
    const expectedCardsInTrick = gameData.playerOrderActive.length;
    if (gameData.currentTrickCards.length === expectedCardsInTrick) {
      const winnerNameOfTrick = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      const currentTrickNumber = gameData.tricksPlayedCount + 1;
      if (winnerNameOfTrick && gameData.capturedTricks[winnerNameOfTrick]) gameData.capturedTricks[winnerNameOfTrick].push([...gameData.currentTrickCards.map(p => p.card)]);
      else if (winnerNameOfTrick) gameData.capturedTricks[winnerNameOfTrick] = [[...gameData.currentTrickCards.map(p => p.card)]];
      else console.error(`[${SERVER_VERSION} ERROR] No winner for trick. Cards: ${gameData.currentTrickCards.map(c=>c.card).join(',')}`);
      gameData.lastCompletedTrick = { cards: [...gameData.currentTrickCards], winnerName: winnerNameOfTrick, leadSuit: gameData.leadSuitCurrentTrick, trickNumber: currentTrickNumber };
      gameData.tricksPlayedCount++; gameData.trickLeaderName = winnerNameOfTrick;
      if (gameData.tricksPlayedCount === 11) {
        if(gameData.insurance.isActive && !gameData.insurance.dealExecuted) console.log(`[${SERVER_VERSION} INSURANCE] No deal made by end of round ${currentTrickNumber}.`);
        calculateRoundScores();
      } else {
        gameData.state = "TrickCompleteLinger";
        io.emit("gameState", gameData);
        setTimeout(() => {
            if (gameData.gameStarted && gameData.state === "TrickCompleteLinger" && gameData.lastCompletedTrick && gameData.lastCompletedTrick.trickNumber === currentTrickNumber) {
                gameData.currentTrickCards = []; gameData.leadSuitCurrentTrick = null;
                gameData.trickTurnPlayerName = winnerNameOfTrick; gameData.state = "Playing Phase";
                io.emit("gameState", gameData);
            }
        }, 2000);
      }
    } else {
      const currentTurnPlayerIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      if (currentTurnPlayerIndexInActiveOrder === -1) { resetFullGameData(); io.emit("gameState", gameData); return; }
      gameData.trickTurnPlayerName = gameData.playerOrderActive[(currentTurnPlayerIndexInActiveOrder + 1) % expectedCardsInTrick];
      io.emit("gameState", gameData);
    }
  });

  socket.on("updateInsuranceSetting", ({ settingType, value }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found for insurance update.");
    if (!gameData.insurance.isActive) return socket.emit("error", "Insurance is not currently active.");
    if (gameData.insurance.dealExecuted) return socket.emit("error", "Insurance deal already made, settings are locked.");

    const currentBidMultiplier = gameData.insurance.bidMultiplier;
    if (!currentBidMultiplier) {
        console.error(`[${SERVER_VERSION} INSURANCE ERROR] Bid multiplier missing for player ${pName}.`);
        return socket.emit("error", "Internal server error: Insurance configuration missing.");
    }
    let updated = false;
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) return socket.emit("error", "Invalid value. Must be a whole number.");

    if (settingType === 'bidderRequirement') {
        if (pName !== gameData.insurance.bidderPlayerName) return socket.emit("error", "Only bid winner can update requirement.");
        const minReq = -120 * currentBidMultiplier; const maxReq = 120 * currentBidMultiplier;
        if (parsedValue < minReq || parsedValue > maxReq) return socket.emit("error", `Requirement ${parsedValue} out of range [${minReq}, ${maxReq}].`);
        gameData.insurance.bidderRequirement = parsedValue; updated = true;
        console.log(`[${SERVER_VERSION} INSURANCE] Bidder ${pName} updated requirement to: ${parsedValue}`);
    } else if (settingType === 'defenderOffer') {
        if (!gameData.insurance.defenderOffers.hasOwnProperty(pName)) return socket.emit("error", "You are not a listed defender.");
        const minOffer = -60 * currentBidMultiplier; const maxOffer = 60 * currentBidMultiplier;
        if (parsedValue < minOffer || parsedValue > maxOffer) return socket.emit("error", `Offer ${parsedValue} out of range [${minOffer}, ${maxOffer}].`);
        gameData.insurance.defenderOffers[pName] = parsedValue; updated = true;
        console.log(`[${SERVER_VERSION} INSURANCE] Defender ${pName} updated offer to: ${parsedValue}`);
    } else { return socket.emit("error", "Invalid insurance setting type."); }

    if (updated) {
        const { bidderRequirement, defenderOffers } = gameData.insurance;
        const sumOfDefenderOffers = Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0);
        const gapToDeal = bidderRequirement - sumOfDefenderOffers;
        if (gapToDeal <= 0 && !gameData.insurance.dealExecuted) {
            gameData.insurance.dealExecuted = true;
            gameData.insurance.executedDetails = {
                agreement: {
                    bidderPlayerName: gameData.insurance.bidderPlayerName,
                    bidderRequirement: bidderRequirement,
                    defenderOffers: { ...defenderOffers }
                },
                pointsExchanged: {} // Will be populated in calculateRoundScores if deal is executed
            };
            console.log(`[${SERVER_VERSION} INSURANCE] DEAL EXECUTED! Gap: ${gapToDeal}. Details: ${JSON.stringify(gameData.insurance.executedDetails.agreement)}`);
        }
        io.emit("gameState", gameData);
    }
  });

  function calculateRoundScores() {
    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        console.error(`[${SERVER_VERSION} SCORING ERROR] PreRequisites not met.`);
        gameData.state = "Error - Scoring PreRequisite"; io.emit("gameState", gameData); return;
    }
    const bidWinnerName = gameData.bidWinnerInfo.playerName;
    const bidType = gameData.bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };
    let roundMessage = "";
    let bidMadeSuccessfully = false; // Based on card points, even if insurance overrides game point exchange
    let humanPlayerScoresBeforeExchange = {};
    gameData.playerSocketIds.forEach(id => {
        const playerName = gameData.players[id];
        if(playerName && gameData.scores[playerName] !== undefined) humanPlayerScoresBeforeExchange[playerName] = gameData.scores[playerName];
    });
    if(gameData.playerMode === 3 && gameData.scores[PLACEHOLDER_ID] !== undefined) humanPlayerScoresBeforeExchange[PLACEHOLDER_ID] = gameData.scores[PLACEHOLDER_ID];

    // Calculate card points from widow and tricks (always done, as hand is played out)
    if (bidType === "Frog") {
        awardedWidowInfo.cards = [...gameData.widowDiscardsForFrogBidder];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Solo") {
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Heart Solo") {
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        if (gameData.trickLeaderName === bidWinnerName) { bidderTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = bidWinnerName; }
        else { defendersTotalCardPoints += awardedWidowInfo.points; awardedWidowInfo.awardedTo = gameData.trickLeaderName; }
    }
    gameData.playerOrderActive.forEach(activePlayerName => {
        const playerTrickPoints = (gameData.capturedTricks[activePlayerName] || []).reduce((sum, trick) => sum + calculateCardPoints(trick), 0);
        if (activePlayerName === bidWinnerName) bidderTotalCardPoints += playerTrickPoints;
        else defendersTotalCardPoints += playerTrickPoints;
    });
    console.log(`[${SERVER_VERSION} SCORING] Card Points - Bidder: ${bidWinnerName} (${bidderTotalCardPoints}), Defenders: (${defendersTotalCardPoints})`);
    if (bidderTotalCardPoints + defendersTotalCardPoints !== 120) console.warn(`[${SERVER_VERSION} SCORING WARNING] Total card points != 120!`);
    bidMadeSuccessfully = bidderTotalCardPoints > 60; // Determine success based on card points

    // --- Game Point Exchange ---
    if (gameData.insurance.dealExecuted && gameData.insurance.executedDetails && gameData.insurance.executedDetails.agreement) {
        console.log(`[${SERVER_VERSION} SCORING] Insurance deal was executed. Applying agreed points.`);
        const agreement = gameData.insurance.executedDetails.agreement;
        const pointsExchangedThisDeal = {};

        // Bidder's score change
        const bidderGain = agreement.bidderRequirement;
        gameData.scores[agreement.bidderPlayerName] = (gameData.scores[agreement.bidderPlayerName] || 0) + bidderGain;
        pointsExchangedThisDeal[agreement.bidderPlayerName] = bidderGain;
        roundMessage = `Insurance deal executed: Bidder ${agreement.bidderPlayerName} receives ${bidderGain} points. `;

        // Defenders' score changes
        let defenderMessages = [];
        for (const defenderName in agreement.defenderOffers) {
            if (agreement.defenderOffers.hasOwnProperty(defenderName) && gameData.scores.hasOwnProperty(defenderName)) {
                const offerValue = agreement.defenderOffers[defenderName];
                gameData.scores[defenderName] = (gameData.scores[defenderName] || 0) - offerValue; // Positive offer means defender pays (score decreases)
                pointsExchangedThisDeal[defenderName] = -offerValue;
                defenderMessages.push(`${defenderName} ${offerValue >= 0 ? 'pays' : 'receives'} ${Math.abs(offerValue)}`);
            }
        }
        roundMessage += `Defenders: ${defenderMessages.join(', ')}. `;
        gameData.insurance.executedDetails.pointsExchanged = pointsExchangedThisDeal; // Store actual changes
        console.log(`[${SERVER_VERSION} INSURANCE SCORING] Points exchanged: ${JSON.stringify(pointsExchangedThisDeal)}`);
    } else {
        // Standard game point exchange based on card points
        const targetPoints = 60;
        const scoreDifferenceFrom60 = bidderTotalCardPoints - targetPoints;
        const pointsDelta = Math.abs(scoreDifferenceFrom60);
        const exchangeValuePerPlayer = pointsDelta * currentBidMultiplier;

        if (scoreDifferenceFrom60 === 0) {
            roundMessage = `${bidWinnerName} (Bid: ${bidType}) scored 60 card points. No game points exchanged from play.`;
        } else if (bidderTotalCardPoints > targetPoints) { // Bidder succeeded with card points
            let totalPointsGainedByBidder = 0;
            const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
            activeOpponents.forEach(oppName => {
                gameData.scores[oppName] = (gameData.scores[oppName] || 0) - exchangeValuePerPlayer;
                totalPointsGainedByBidder += exchangeValuePerPlayer;
            });
            gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) + totalPointsGainedByBidder;
            roundMessage = `${bidWinnerName} (Bid: ${bidType}) succeeded with card points! Gains ${totalPointsGainedByBidder} game pts.`;
        } else { // Bidder failed with card points
            let totalPointsLostByBidder = 0;
            const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
            activeOpponents.forEach(oppName => {
                gameData.scores[oppName] = (gameData.scores[oppName] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
            });
            if (gameData.playerMode === 3) {
                gameData.scores[PLACEHOLDER_ID] = (gameData.scores[PLACEHOLDER_ID] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
            } else if (gameData.playerMode === 4) {
                const dealerNameActual = getPlayerNameById(gameData.dealer);
                if (dealerNameActual && dealerNameActual !== bidWinnerName && !gameData.playerOrderActive.includes(dealerNameActual)) {
                    gameData.scores[dealerNameActual] = (gameData.scores[dealerNameActual] || 0) + exchangeValuePerPlayer;
                    totalPointsLostByBidder += exchangeValuePerPlayer;
                }
            }
            gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) - totalPointsLostByBidder;
            roundMessage = `${bidWinnerName} (Bid: ${bidType}) failed with card points. Loses ${totalPointsLostByBidder} game pts.`;
        }
    }

    // Check for game over
    let isGameOver = false;
    let humanPlayersWithScores = [];
    gameData.playerSocketIds.forEach(socketId => {
        const playerName = gameData.players[socketId];
        if (playerName && gameData.scores[playerName] !== undefined) {
            humanPlayersWithScores.push({ name: playerName, score: gameData.scores[playerName] });
            if (gameData.scores[playerName] <= 0) isGameOver = true;
        }
    });
    let gameWinner = null;
    if (isGameOver) {
        let contenders = []; let highestScore = -Infinity;
        humanPlayersWithScores.forEach(player => {
            if (player.score > highestScore) { highestScore = player.score; contenders = [player.name]; }
            else if (player.score === highestScore) contenders.push(player.name);
        });
        gameWinner = contenders.join(" & ");
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner || 'N/A'} with ${highestScore} points.`;
        gameData.state = "Game Over";
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints, defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo, bidMadeSuccessfully, // bidMadeSuccessfully is based on card points
        scoresBeforeExchange: humanPlayerScoresBeforeExchange,
        finalScores: { ...gameData.scores },
        isGameOver, gameWinner, message: roundMessage,
        dealerOfRoundSocketId: gameData.dealer,
        insuranceDealWasMade: gameData.insurance.dealExecuted,
        insuranceDetails: gameData.insurance.dealExecuted ? gameData.insurance.executedDetails : null
    };
    console.log(`[${SERVER_VERSION} SCORING] Final Scores: ${JSON.stringify(gameData.scores)}`);
    const totalExpectedScore = gameData.playerMode === 3 ? 120 * (gameData.playerSocketIds.length + 1) : 120 * gameData.playerSocketIds.length;
    const actualTotalScore = Object.values(gameData.scores).reduce((sum, s) => sum + s, 0);
    if (actualTotalScore !== totalExpectedScore) console.warn(`[${SERVER_VERSION} SCORING WARNING ${gameData.playerMode}P] Total points (${actualTotalScore}) != ${totalExpectedScore}!`);

    if (!isGameOver) gameData.state = "Awaiting Next Round Trigger";
    io.emit("gameState", gameData);
  }

  function prepareNextRound() {
    const numHumanPlayers = gameData.playerSocketIds.length;
    if (!gameData.playerMode || (gameData.playerMode === 3 && numHumanPlayers !== 3) || (gameData.playerMode === 4 && numHumanPlayers !== 4)) {
        resetFullGameData(); io.emit("gameState", gameData); return;
    }
    if (numHumanPlayers < 3) { resetFullGameData(); io.emit("gameState", gameData); return; }
    let lastRoundDealerSocketId = gameData.roundSummary ? gameData.roundSummary.dealerOfRoundSocketId : gameData.dealer;
    if (!lastRoundDealerSocketId || !gameData.playerSocketIds.includes(lastRoundDealerSocketId)) {
        if (gameData.playerSocketIds.length > 0) lastRoundDealerSocketId = gameData.playerSocketIds[0];
        else { gameData.state = "Error - Cannot Rotate Dealer"; io.emit("gameState", gameData); return; }
    }
    let lastRoundDealerIndexInSockets = gameData.playerSocketIds.indexOf(lastRoundDealerSocketId);
    const nextDealerIndexInSockets = (lastRoundDealerIndexInSockets + 1) % numHumanPlayers;
    gameData.dealer = gameData.playerSocketIds[nextDealerIndexInSockets];
    gameData.playerOrderActive = [];
    const currentDealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    if (gameData.playerMode === 4) {
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(currentDealerIndex + i) % numHumanPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else if (gameData.playerMode === 3) {
        for (let i = 0; i < 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(currentDealerIndex + i + 1) % numHumanPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else { resetFullGameData(); io.emit("gameState", gameData); return; }
    if (gameData.playerOrderActive.length !== 3) { resetFullGameData(); io.emit("gameState", gameData); return; }
    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] Next round. Dealer: ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  }

  socket.on("requestNextRound", () => {
    if (gameData.state === "Awaiting Next Round Trigger" && gameData.roundSummary && socket.id === gameData.roundSummary.dealerOfRoundSocketId) {
        prepareNextRound();
    } else {
        let reason = "Not correct state or not authorized.";
        if (gameData.state !== "Awaiting Next Round Trigger") reason = `Not 'Awaiting Next Round Trigger' state (current: ${gameData.state}).`;
        else if (!gameData.roundSummary) reason = "Round summary not available.";
        else if (gameData.roundSummary.dealerOfRoundSocketId && socket.id !== gameData.roundSummary.dealerOfRoundSocketId) reason = `Only dealer of last round can start.`;
        else if (!gameData.roundSummary.dealerOfRoundSocketId) reason = "Dealer info missing.";
        socket.emit("error", `Cannot start next round: ${reason}`);
    }
  });

  socket.on("resetGame", () => {
    console.log(`[${SERVER_VERSION}] 'resetGame' received from ${getPlayerNameById(socket.id) || socket.id}.`);
    resetFullGameData(); io.emit("gameState", gameData);
  });

  socket.on("requestBootAll", () => {
    console.log(`[${SERVER_VERSION} REQUESTBOOTALL] Received from ${getPlayerNameById(socket.id) || "A player"}.`);
    resetFullGameData(); io.emit("gameState", gameData);
  });

  socket.on("disconnect", (reason) => {
    const pName = getPlayerNameById(socket.id);
    const disconnectingSocketId = socket.id;
    console.log(`[${SERVER_VERSION} DISCONNECT] Player ${pName || 'Unknown'} (ID: ${disconnectingSocketId}) disconnected. Reason: ${reason}`);
    if (pName) {
        const wasDealer = gameData.dealer === disconnectingSocketId || (gameData.roundSummary && gameData.roundSummary.dealerOfRoundSocketId === disconnectingSocketId);
        let gameResetDueToDisconnect = false;
        if (gameData.insurance.isActive && !gameData.insurance.dealExecuted) {
            if (gameData.insurance.bidderPlayerName === pName) {
                console.log(`[${SERVER_VERSION} INSURANCE DISCONNECT] Bidder ${pName} disconnected. Deactivating insurance.`);
                gameData.insurance.isActive = false;
            } else if (gameData.insurance.defenderOffers.hasOwnProperty(pName)) {
                console.log(`[${SERVER_VERSION} INSURANCE DISCONNECT] Defender ${pName} disconnected. Removing offer: ${gameData.insurance.defenderOffers[pName]}.`);
                delete gameData.insurance.defenderOffers[pName];
                const { bidderRequirement, defenderOffers } = gameData.insurance; // Re-check with remaining offers
                const sumOfDefenderOffers = Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0);
                const gapToDeal = bidderRequirement - sumOfDefenderOffers;
                if (gapToDeal <= 0 && !gameData.insurance.dealExecuted) {
                    gameData.insurance.dealExecuted = true;
                    gameData.insurance.executedDetails = {
                        agreement: { bidderPlayerName: gameData.insurance.bidderPlayerName, bidderRequirement, defenderOffers: { ...defenderOffers } },
                        pointsExchanged: {} // Will be populated in calculateRoundScores
                    };
                    console.log(`[${SERVER_VERSION} INSURANCE] DEAL EXECUTED due to defender disconnect. Details: ${JSON.stringify(gameData.insurance.executedDetails.agreement)}`);
                }
            }
        }
        delete gameData.players[disconnectingSocketId];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== disconnectingSocketId);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        const numHumanPlayers = gameData.playerSocketIds.length;
        if (gameData.gameStarted) {
            if (numHumanPlayers < 3) { resetFullGameData(); gameResetDueToDisconnect = true; }
            else if (gameData.playerMode === 4 && numHumanPlayers === 3) { resetFullGameData(); gameResetDueToDisconnect = true; }
            else if (wasDealer && gameData.state === "Awaiting Next Round Trigger" && !gameResetDueToDisconnect) { console.log(`[${SERVER_VERSION} DISCONNECT] Dealer ${pName} disconnected.`); }
            else if ((gameData.biddingTurnPlayerName === pName || gameData.trickTurnPlayerName === pName) && !gameResetDueToDisconnect) { resetFullGameData(); gameResetDueToDisconnect = true; }
            else if (gameData.insurance.bidderPlayerName === pName && gameData.insurance.isActive && !gameResetDueToDisconnect) { console.log(`[${SERVER_VERSION} DISCONNECT] Insurance Bidder ${pName} disconnected. Insurance deactivated.`); }
        } else {
            if (numHumanPlayers === 3) gameData.state = "Ready to Start 3P or Wait";
            else if (numHumanPlayers >= 4) gameData.state = "Ready to Start 4P"; // Should be numPlayers === 4
            else gameData.state = "Waiting for Players to Join";
        }
        io.emit("gameState", gameData);
    } else { console.log(`[${SERVER_VERSION} DISCONNECT] Unidentified socket (ID: ${disconnectingSocketId}) disconnected.`); }
  });
});

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });

