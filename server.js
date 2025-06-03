// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors =require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "3.0.1 - Trick Linger Logic"; // UPDATED SERVER VERSION
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
const PLACEHOLDER_ID = "ScoreAbsorber"; 

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
  revealedWidowForFrog: [],
  lastCompletedTrick: null,
  playersWhoPassedThisRound: [],
  playerMode: null,
  serverVersion: SERVER_VERSION // Added for client display
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
    gameData.leadSuitCurrentTrick = null;
    gameData.trumpBroken = false;
    gameData.trickLeaderName = null; gameData.capturedTricks = {};
    gameData.roundSummary = null;
    gameData.revealedWidowForFrog = [];
    gameData.lastCompletedTrick = null;
    gameData.playersWhoPassedThisRound = [];
    
    if (gameData.playerOrderActive && gameData.playerOrderActive.length > 0) {
        gameData.playerOrderActive.forEach(pName => {
            if (pName && gameData.scores && gameData.scores[pName] !== undefined) {
                gameData.capturedTricks[pName] = [];
            }
        });
    } else { 
        gameData.playerSocketIds.forEach(socketId => {
            const pName = gameData.players[socketId];
            if (pName && gameData.scores && gameData.scores[pName] !== undefined) {
                gameData.capturedTricks[pName] = [];
            }
        });
    }
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
        revealedWidowForFrog: [],
        lastCompletedTrick: null,
        playersWhoPassedThisRound: [],
        playerMode: null,
        serverVersion: SERVER_VERSION // Ensure server version is part of reset
    };
    console.log(`[${SERVER_VERSION}] Game data fully reset.`);
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
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) return socket.emit("error", "Room full (max 4 players).");
    if (gameData.gameStarted && !gameData.players[socket.id]) {
        return socket.emit("error", "Game in progress. Cannot join now.");
    }

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) gameData.playerSocketIds.push(socket.id);
    if(gameData.scores[name] === undefined) gameData.scores[name] = 120;
    socket.emit("playerJoined", { playerId: socket.id, name });
    
    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted) {
        if (numPlayers === 4) {
            gameData.state = "Ready to Start 4P";
        } else if (numPlayers === 3) {
            gameData.state = "Ready to Start 3P or Wait";
        } else {
            gameData.state = "Waiting for Players to Join";
        }
    }
    io.emit("gameState", gameData);
  });

  socket.on("startGame", () => { 
    if (Object.keys(gameData.players).length !== 4) return socket.emit("error", "Need exactly 4 players to start a 4-player game.");
    if (gameData.gameStarted) return socket.emit("error", "Game already in progress.");

    console.log(`[${SERVER_VERSION}] Attempting to start 4-PLAYER game.`);
    gameData.playerMode = 4;
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]);
    gameData.dealer = gameData.playerSocketIds[0];

    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    for (let i = 1; i <= 3; i++) { 
        const activePlayerSocketId = gameData.playerSocketIds[(dealerIndex + i) % 4];
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }
    
    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] 4-PLAYER game started. Dealer: ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  });

  socket.on("startThreePlayerGame", () => {
    if (Object.keys(gameData.players).length !== 3) return socket.emit("error", "Need exactly 3 players to start a 3-player game.");
    if (gameData.gameStarted) return socket.emit("error", "Game already in progress.");

    console.log(`[${SERVER_VERSION}] Attempting to start 3-PLAYER game.`);
    gameData.playerMode = 3;
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]);
    gameData.dealer = gameData.playerSocketIds[0];

    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    for (let i = 1; i <= 3; i++) { 
        const activePlayerSocketId = gameData.playerSocketIds[(dealerIndex + i) % 3];
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }

    gameData.scores[PLACEHOLDER_ID] = 120;
    
    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] 3-PLAYER game started. Dealer: ${getPlayerNameById(gameData.dealer)}. All players active: ${gameData.playerOrderActive.join(', ')}. ${PLACEHOLDER_ID} initialized.`);
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    if (gameData.state !== "Dealing Pending" || !gameData.dealer || socket.id !== gameData.dealer) return socket.emit("error", "Not dealer or not dealing phase.");
    if (!gameData.playerOrderActive || gameData.playerOrderActive.length !== 3) {
        return socket.emit("error", "Active player setup error for dealing. Expected 3 active players.");
    }

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
    gameData.lastCompletedTrick = null;
    gameData.playersWhoPassedThisRound = [];
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
        gameData.lastCompletedTrick = null;
        console.log(`[${SERVER_VERSION}] All players passed. Round skipped. Preparing next round in 5s.`);
        setTimeout(() => { 
            if (gameData.state === "Round Skipped" && gameData.gameStarted) { 
                 console.log(`[${SERVER_VERSION}] Round Skipped timeout executing. Preparing next round.`);
                 prepareNextRound(); 
            } else {
                 console.log(`[${SERVER_VERSION}] Round Skipped timeout, but state changed to ${gameData.state} or game ended. Not preparing next round automatically.`);
            }
        }, 5000);
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
            console.error(`[${SERVER_VERSION} ERROR] Invalid bid outcome in resolveBiddingFinal: ${gameData.bidWinnerInfo.bid}`);
            gameData.state = "Error - Invalid Bid Outcome"; 
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
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) {
            return socket.emit("error", "Invalid frog upgrade bid/pass.");
        }
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") {
            gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        }
        gameData.biddingTurnPlayerName = null; 
        resolveBiddingFinal(); 
        return;
    }

    if (gameData.state !== "Bidding Phase") return socket.emit("error", "Not in Bidding Phase.");
    if (pName !== gameData.biddingTurnPlayerName) return socket.emit("error", "Not your turn to bid.");
    if (!BID_HIERARCHY.includes(bid)) return socket.emit("error", "Invalid bid type.");

    if (gameData.playersWhoPassedThisRound.includes(pName)) {
        return socket.emit("error", "You have already passed and cannot bid again this round.");
    }

    const currentHighestBidIndex = gameData.currentHighestBidDetails ? BID_HIERARCHY.indexOf(gameData.currentHighestBidDetails.bid) : -1;
    if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) {
        return socket.emit("error", "Bid is not higher than current highest bid.");
    }

    gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "RegularBid", bidValue: bid });

    if (bid !== "Pass") {
      gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid };
      if (bid === "Frog" && (!gameData.originalFrogBidderId || !gameData.bidsThisRound.some(b => b.playerId === gameData.originalFrogBidderId && b.bidValue !== "Pass"))) {
          if(!gameData.originalFrogBidderId) gameData.originalFrogBidderId = socket.id;
      } else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) {
          gameData.soloBidMadeAfterFrog = true;
      }
    } else { 
        if (!gameData.playersWhoPassedThisRound.includes(pName)) {
            gameData.playersWhoPassedThisRound.push(pName);
        }
    }

    const activeBiddersRemaining = gameData.playerOrderActive.filter(playerName => !gameData.playersWhoPassedThisRound.includes(playerName));
    
    let endBidding = false;
    if (activeBiddersRemaining.length === 0) { 
        endBidding = true;
    } else if (activeBiddersRemaining.length === 1 && gameData.currentHighestBidDetails && activeBiddersRemaining[0] === gameData.currentHighestBidDetails.playerName) {
        endBidding = true;
    } else if (gameData.playersWhoPassedThisRound.length === gameData.playerOrderActive.length) {
        endBidding = true;
    }
    if (!endBidding && gameData.currentHighestBidDetails) {
        const highestBidderName = gameData.currentHighestBidDetails.playerName;
        const otherActivePlayers = gameData.playerOrderActive.filter(player => player !== highestBidderName);
        const allOthersPassed = otherActivePlayers.every(player => gameData.playersWhoPassedThisRound.includes(player));
        if (allOthersPassed) {
            endBidding = true;
        }
    }

    if (endBidding) {
        gameData.biddingTurnPlayerName = null;
        checkForFrogUpgrade(); 
    } else {
        let currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
        let nextBidderName = null;
        for (let i = 1; i < gameData.playerOrderActive.length; i++) { 
            let nextIndex = (currentBidderIndexInActiveOrder + i) % gameData.playerOrderActive.length;
            let potentialNextBidder = gameData.playerOrderActive[nextIndex];
            if (!gameData.playersWhoPassedThisRound.includes(potentialNextBidder)) {
                nextBidderName = potentialNextBidder;
                break;
            }
        }
        if (nextBidderName) {
            gameData.biddingTurnPlayerName = nextBidderName;
        } else {
            console.log(`[${SERVER_VERSION} PLACEBID WARN] Fallback: No eligible next bidder. Checking frog upgrade.`);
            gameData.biddingTurnPlayerName = null;
            checkForFrogUpgrade(); 
            return; 
        }
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
        if (indexInCombined > -1) { 
            tempCombinedCheck.splice(indexInCombined, 1); 
            return true; 
        } 
        return false; 
    });

    if (!allDiscardsValid) return socket.emit("error", "Invalid discards. Cards not found in combined hand and widow.");
    
    let finalHandAfterExchange = combinedForValidation.filter(card => !discards.includes(card));
    gameData.hands[pName] = finalHandAfterExchange.sort(); 
    gameData.widowDiscardsForFrogBidder = [...discards].sort(); 
    gameData.widow = [...discards].sort(); 
    gameData.revealedWidowForFrog = []; 
    
    console.log(`[${SERVER_VERSION}] Player ${pName} (Frog Bidder) discarded: ${discards.join(', ')}. New hand size: ${gameData.hands[pName].length}`);
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
        if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken && !isHandAllTrump) {
            return socket.emit("error", "Cannot lead trump if not broken (unless hand is all trump).");
        }
    } else {
        const leadCardSuit = gameData.leadSuitCurrentTrick;
        const hasLeadSuit = hand.some(c => getSuit(c) === leadCardSuit);
        const hasTrumpSuit = hand.some(c => getSuit(c) === gameData.trumpSuit);

        if (playedSuit !== leadCardSuit && hasLeadSuit) return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        if (playedSuit !== leadCardSuit && !hasLeadSuit && playedSuit !== gameData.trumpSuit && hasTrumpSuit) {
             return socket.emit("error", `Void in lead suit (${SUITS[leadCardSuit]}), must play trump.`);
        }
    }
    gameData.hands[pName] = hand.filter(c => c !== card);
    gameData.currentTrickCards.push({ playerId: socket.id, playerName: pName, card });
    if (isLeading) gameData.leadSuitCurrentTrick = playedSuit;
    if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken) gameData.trumpBroken = true;

    const expectedCardsInTrick = 3; 

    if (gameData.currentTrickCards.length === expectedCardsInTrick) {
      const winnerNameOfTrick = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      const currentTrickNumber = gameData.tricksPlayedCount + 1;

      if (winnerNameOfTrick && gameData.capturedTricks[winnerNameOfTrick]) {
          gameData.capturedTricks[winnerNameOfTrick].push([...gameData.currentTrickCards.map(p => p.card)]);
      } else if (winnerNameOfTrick) {
          console.warn(`[${SERVER_VERSION} WARN] capturedTricks not initialized for trick winner: ${winnerNameOfTrick}. Initializing now.`);
          gameData.capturedTricks[winnerNameOfTrick] = [[...gameData.currentTrickCards.map(p => p.card)]];
      } else {
          console.error(`[${SERVER_VERSION} ERROR] No winner determined for a full trick. Trick cards:`, gameData.currentTrickCards.map(c => c.card).join(', '));
      }

      gameData.lastCompletedTrick = {
          cards: [...gameData.currentTrickCards], // Keep a copy of the cards for this trick
          winnerName: winnerNameOfTrick,
          leadSuit: gameData.leadSuitCurrentTrick,
          trickNumber: currentTrickNumber
      };
      gameData.tricksPlayedCount++;
      gameData.trickLeaderName = winnerNameOfTrick; // Winner of this trick for records, next leader set after linger

      if (gameData.tricksPlayedCount === 11) { // Last trick of the round
        // No linger, proceed to scoring
        calculateRoundScores();
        // currentTrickCards will be cleared by calculateRoundScores or initializeNewRoundState
      } else {
        // MODIFIED: Implement Trick Linger
        gameData.state = "TrickCompleteLinger";
        console.log(`[${SERVER_VERSION}] Trick ${currentTrickNumber} complete. Winner: ${winnerNameOfTrick}. Lingering for 2s.`);
        io.emit("gameState", gameData); // Emit state with currentTrickCards still populated

        setTimeout(() => {
            // Safety check: ensure game is still in this state and for the same trick
            if (gameData.gameStarted && gameData.state === "TrickCompleteLinger" && 
                gameData.lastCompletedTrick && gameData.lastCompletedTrick.trickNumber === currentTrickNumber) {
                
                console.log(`[${SERVER_VERSION}] Linger timeout for trick ${currentTrickNumber}. Clearing trick and setting next turn.`);
                gameData.currentTrickCards = []; 
                gameData.leadSuitCurrentTrick = null;
                gameData.trickTurnPlayerName = winnerNameOfTrick; // Winner of the trick leads next
                gameData.state = "Playing Phase";
                io.emit("gameState", gameData);
            } else {
                 console.log(`[${SERVER_VERSION} LINGER TIMEOUT] Game state changed or reset during linger for trick ${currentTrickNumber}. Aborting clear. Current state: ${gameData.state}`);
            }
        }, 2000); // 2-second linger
      }
    } else { // Trick not yet full
      const currentTurnPlayerIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      if (currentTurnPlayerIndexInActiveOrder === -1) {
          console.error(`[${SERVER_VERSION} ERROR PLAYCARD] Current turn player ${pName} not found in active order: ${gameData.playerOrderActive.join(', ')}. Resetting.`);
          resetFullGameData(); 
          io.emit("gameState", gameData);
          return;
      }
      gameData.trickTurnPlayerName = gameData.playerOrderActive[(currentTurnPlayerIndexInActiveOrder + 1) % expectedCardsInTrick];
      io.emit("gameState", gameData);
    }
  });

  function calculateRoundScores() {
    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        console.error(`[${SERVER_VERSION} SCORING ERROR] PreRequisites not met. BidWinner: ${!!gameData.bidWinnerInfo}, TricksPlayed: ${gameData.tricksPlayedCount}`);
        gameData.state = "Error - Scoring PreRequisite"; io.emit("gameState", gameData); return;
    }
    const bidWinnerName = gameData.bidWinnerInfo.playerName;
    const bidType = gameData.bidWinnerInfo.bid;
    const bidMultiplier = {"Frog": 1, "Solo": 2, "Heart Solo": 3}[bidType];
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };

    if (bidType === "Frog") {
        awardedWidowInfo.cards = [...gameData.widowDiscardsForFrogBidder];
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

    gameData.playerOrderActive.forEach(activePlayerName => {
        const playerTrickPoints = (gameData.capturedTricks[activePlayerName] || []).reduce((sum, trick) => sum + calculateCardPoints(trick), 0);
        if (activePlayerName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });

    console.log(`[${SERVER_VERSION} SCORING] Bidder: ${bidWinnerName}, Bid: ${bidType}`);
    console.log(`[${SERVER_VERSION} SCORING] Initial Card Pts -> Bidder: ${bidderTotalCardPoints}, Defenders: ${defendersTotalCardPoints}`);
    if (bidderTotalCardPoints + defendersTotalCardPoints !== 120) {
        console.warn(`[${SERVER_VERSION} SCORING WARNING] Total card points in play (${bidderTotalCardPoints + defendersTotalCardPoints}) != 120! Widow awarded to: ${awardedWidowInfo.awardedTo}, Widow points: ${awardedWidowInfo.points}`);
    }

    const targetPoints = 60;
    const scoreDifferenceFrom60 = bidderTotalCardPoints - targetPoints;
    const pointsDelta = Math.abs(scoreDifferenceFrom60);
    const exchangeValuePerPlayer = pointsDelta * bidMultiplier;

    let roundMessage = "";
    let bidMadeSuccessfully = bidderTotalCardPoints > targetPoints;
    let humanPlayerScoresBeforeExchange = {};
    gameData.playerSocketIds.forEach(id => {
        const playerName = gameData.players[id];
        if(playerName) humanPlayerScoresBeforeExchange[playerName] = gameData.scores[playerName];
    });
    if(gameData.playerMode === 3 && gameData.scores[PLACEHOLDER_ID] !== undefined) { 
        humanPlayerScoresBeforeExchange[PLACEHOLDER_ID] = gameData.scores[PLACEHOLDER_ID];
    }

    if (scoreDifferenceFrom60 === 0) {
        bidMadeSuccessfully = false;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) scored exactly 60. No game points exchanged.`;
    } else if (bidderTotalCardPoints > targetPoints) {
        bidMadeSuccessfully = true;
        let totalPointsGainedByBidder = 0;
        const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
        
        activeOpponents.forEach(oppName => {
            gameData.scores[oppName] = (gameData.scores[oppName] || 0) - exchangeValuePerPlayer;
            totalPointsGainedByBidder += exchangeValuePerPlayer;
        });
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) + totalPointsGainedByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) succeeded! Gains ${totalPointsGainedByBidder} pts (receives ${exchangeValuePerPlayer} from each active opponent).`;
    } else { 
        bidMadeSuccessfully = false;
        let totalPointsLostByBidder = 0;
        const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
        activeOpponents.forEach(oppName => {
            gameData.scores[oppName] = (gameData.scores[oppName] || 0) + exchangeValuePerPlayer;
            totalPointsLostByBidder += exchangeValuePerPlayer;
        });

        if (gameData.playerMode === 3) {
            gameData.scores[PLACEHOLDER_ID] = (gameData.scores[PLACEHOLDER_ID] || 0) + exchangeValuePerPlayer;
            totalPointsLostByBidder += exchangeValuePerPlayer;
            console.log(`[${SERVER_VERSION} SCORING] 3P Mode Failed Bid: ${PLACEHOLDER_ID} gains ${exchangeValuePerPlayer}.`);
        } else if (gameData.playerMode === 4) {
            const dealerNameActual = getPlayerNameById(gameData.dealer);
            if (dealerNameActual && dealerNameActual !== bidWinnerName && !gameData.playerOrderActive.includes(dealerNameActual)) {
                gameData.scores[dealerNameActual] = (gameData.scores[dealerNameActual] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
                console.log(`[${SERVER_VERSION} SCORING] 4P Mode Failed Bid: Inactive Dealer ${dealerNameActual} gains ${exchangeValuePerPlayer}.`);
            } else {
                 console.warn(`[${SERVER_VERSION} SCORING WARNING] 4P Mode Failed Bid: Could not identify distinct inactive dealer ${dealerNameActual} to pay.`);
            }
        }
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) - totalPointsLostByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) failed. Loses ${totalPointsLostByBidder} pts (pays ${exchangeValuePerPlayer} to each recipient).`;
    }

    let isGameOver = false;
    let humanPlayersWithScores = [];
    gameData.playerSocketIds.forEach(socketId => {
        const playerName = gameData.players[socketId];
        if (playerName && gameData.scores[playerName] !== undefined) {
            humanPlayersWithScores.push({ name: playerName, score: gameData.scores[playerName] });
            if (gameData.scores[playerName] <= 0) {
                isGameOver = true;
            }
        }
    });
    
    let gameWinner = null;
    if (isGameOver) {
        let contenders = []; 
        let highestScore = -Infinity;
        humanPlayersWithScores.forEach(player => {
            if (player.score > highestScore) {
                highestScore = player.score;
                contenders = [player.name];
            } else if (player.score === highestScore) {
                contenders.push(player.name);
            }
        });
        if (contenders.length === 0 && humanPlayersWithScores.length > 0) { 
            highestScore = -Infinity; 
            humanPlayersWithScores.forEach(player => {
                if (player.score > highestScore) { 
                    highestScore = player.score;
                    contenders = [player.name];
                } else if (player.score === highestScore) {
                    contenders.push(player.name);
                }
            });
        }
        gameWinner = contenders.join(" & ");
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner} with ${highestScore} points.`;
        gameData.state = "Game Over";
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints, defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo, bidMadeSuccessfully, 
        scoresBeforeExchange: humanPlayerScoresBeforeExchange,
        finalScores: { ...gameData.scores }, 
        isGameOver, gameWinner, message: roundMessage,
        dealerOfRoundSocketId: gameData.dealer 
    };

    console.log(`[${SERVER_VERSION} SCORING] Scores After Exchange:`, JSON.stringify(gameData.scores));
    const humanScoreSum = humanPlayersWithScores.reduce((sum, p) => sum + p.score, 0);
    const totalExpectedScore = gameData.playerMode === 3 ? 120 * (humanPlayersWithScores.length +1) : 120 * humanPlayersWithScores.length; 
    const actualTotalScore = Object.values(gameData.scores).reduce((sum, s) => sum + s, 0);

    if (actualTotalScore !== totalExpectedScore) {
        console.warn(`[${SERVER_VERSION} SCORING WARNING ${gameData.playerMode}P] Total game points (${actualTotalScore}) != ${totalExpectedScore}! Human sum: ${humanScoreSum}`);
    }

    if (!isGameOver) gameData.state = "Awaiting Next Round Trigger";
    io.emit("gameState", gameData);
  }

  function prepareNextRound() {
    const numHumanPlayers = gameData.playerSocketIds.length;
    if ((gameData.playerMode === 3 && numHumanPlayers !== 3) || (gameData.playerMode === 4 && numHumanPlayers !== 4)) {
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Mismatch playerMode (${gameData.playerMode}) and humans (${numHumanPlayers}). Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }
    if (numHumanPlayers < 3) { 
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Insufficient players (${numHumanPlayers}). Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }

    let lastRoundDealerSocketId = gameData.roundSummary ? gameData.roundSummary.dealerOfRoundSocketId : gameData.dealer;
    if (!lastRoundDealerSocketId || !gameData.playerSocketIds.includes(lastRoundDealerSocketId)) {
        console.warn(`[${SERVER_VERSION} NEXT ROUND WARN] Last dealer ID invalid. Choosing new from existing.`);
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
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(currentDealerIndex + i) % numHumanPlayers]; 
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else {
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Invalid playerMode: ${gameData.playerMode}. Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }
    
    if (gameData.playerOrderActive.length !== 3) {
        console.error(`[${SERVER_VERSION} NEXT ROUND CRITICAL ERROR] playerOrderActive not 3. Actual: ${gameData.playerOrderActive.length}. Mode: ${gameData.playerMode}. Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }

    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] Next round prepared. Mode: ${gameData.playerMode}P. New Dealer: ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  }

  socket.on("requestNextRound", () => {
    if (gameData.state === "Awaiting Next Round Trigger" && gameData.roundSummary && socket.id === gameData.roundSummary.dealerOfRoundSocketId) {
        prepareNextRound();
    } else {
        let reason = "Not correct state or not authorized.";
        if (gameData.state !== "Awaiting Next Round Trigger") reason = "Not 'Awaiting Next Round Trigger' state.";
        else if (!gameData.roundSummary) reason = "Round summary not available.";
        else if (gameData.roundSummary.dealerOfRoundSocketId && socket.id !== gameData.roundSummary.dealerOfRoundSocketId) reason = `Only dealer of last round (${getPlayerNameById(gameData.roundSummary.dealerOfRoundSocketId) || 'Unknown'}) can start. You: ${getPlayerNameById(socket.id)}.`;
        else if (!gameData.roundSummary.dealerOfRoundSocketId) reason = "Dealer of last round info missing in summary.";
        socket.emit("error", `Cannot start next round: ${reason}`);
    }
  });

  socket.on("resetGame", () => { 
    console.log(`[${SERVER_VERSION}] 'resetGame' event received from ${getPlayerNameById(socket.id) || socket.id}.`);
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });

  socket.on("requestBootAll", () => {
    const playerName = getPlayerNameById(socket.id) || "A player";
    console.log(`[${SERVER_VERSION} REQUESTBOOTALL] Received from ${playerName} (${socket.id}). Resetting game for all.`);
    resetFullGameData();
    io.emit("gameState", gameData);
  });

  socket.on("disconnect", (reason) => {
    const pName = getPlayerNameById(socket.id);
    const disconnectingSocketId = socket.id;
    console.log(`[${SERVER_VERSION} DISCONNECT] Player ${pName || 'Unknown'} (ID: ${disconnectingSocketId}) disconnected. Reason: ${reason}`);
    
    if (pName) { 
        const wasDealer = gameData.dealer === disconnectingSocketId || (gameData.roundSummary && gameData.roundSummary.dealerOfRoundSocketId === disconnectingSocketId);
        
        delete gameData.players[disconnectingSocketId];
        if (gameData.scores[pName] !== undefined) delete gameData.scores[pName];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== disconnectingSocketId);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);

        const numHumanPlayers = gameData.playerSocketIds.length;

        if (gameData.gameStarted) {
            if (numHumanPlayers < 3) {
                console.log(`[${SERVER_VERSION} DISCONNECT] Player count (${numHumanPlayers}) fell below 3 during active game. Resetting game.`);
                resetFullGameData();
            } else if (gameData.playerMode === 4 && numHumanPlayers === 3) {
                console.log(`[${SERVER_VERSION} DISCONNECT] 4-Player game lost a player, now 3 human players. Resetting (dynamic mode change not supported).`);
                resetFullGameData();
            } else if (wasDealer && gameData.state === "Awaiting Next Round Trigger") {
                 console.log(`[${SERVER_VERSION} DISCONNECT] Dealer ${pName} disconnected in 'Awaiting Next Round Trigger'. Game may stall or await manual reset.`);
            } else if (gameData.biddingTurnPlayerName === pName || gameData.trickTurnPlayerName === pName) {
                console.log(`[${SERVER_VERSION} DISCONNECT] Active turn player ${pName} disconnected. Resetting game.`);
                resetFullGameData();
            }
        } else { 
            if (numHumanPlayers === 3) gameData.state = "Ready to Start 3P or Wait";
            else if (numHumanPlayers === 4) gameData.state = "Ready to Start 4P"; 
            else gameData.state = "Waiting for Players to Join";
        }
        io.emit("gameState", gameData);
    } else {
        console.log(`[${SERVER_VERSION} DISCONNECT] Unidentified socket (ID: ${disconnectingSocketId}) disconnected.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });
