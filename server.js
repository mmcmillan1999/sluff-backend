// --- Backend/server.js (INCREMENTAL BUILD - vS_FullAttempt2 - Frog Widow Fixes, COMPLETE AND CORRECTED) ---
require("dotenv").config(); 
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "vS_FullAttempt2"; // UPDATED SERVER VERSION
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

// --- All Constants from your full game ---
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

// --- gameData structure ---
let gameData = {
  state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
  playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
  widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null, 
  biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
  trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [], 
  trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, 
  trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
  revealedWidowForFrog: [] // MODIFIED: Added for Frog bid reveal
};
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initial gameData structure defined.`);

// --- All Helper Functions from your full game ---
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
    gameData.revealedWidowForFrog = []; // MODIFIED: Explicitly reset here
    Object.values(gameData.players).forEach(pName => {
        if(pName) gameData.capturedTricks[pName] = [];
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
        revealedWidowForFrog: [] // MODIFIED: Ensure it's part of the reset
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
        console.error(`[${SERVER_VERSION} ERROR] Cannot transition to playing phase: bidWinnerInfo not set.`);
        gameData.state = "Error - Bid Winner Not Set";
        io.emit("gameState", gameData); return;
    }
    console.log(`[${SERVER_VERSION}] Transitioning to Playing Phase. Bid Winner: ${gameData.bidWinnerInfo.playerName}, Trump: ${gameData.trumpSuit}`);
    io.emit("gameState", gameData);
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Helper functions defined.`);

// --- Main Socket.IO Connection Handler ---
io.on("connection", (socket) => {
  console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData); 

  socket.on("submitName", (name) => {
    console.log(`[${SERVER_VERSION} SUBMITNAME] ID: ${socket.id} Name: "${name}". Current Players: ${Object.keys(gameData.players).length}, Game Started: ${gameData.gameStarted}`);
    if (gameData.players[socket.id] === name) {
        socket.emit("playerJoined", { playerId: socket.id, name });
        io.emit("gameState", gameData); return;
    }
    if (Object.values(gameData.players).includes(name)) return socket.emit("error", "Name already taken.");
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) return socket.emit("error", "Room full (4 players max).");
    if (gameData.gameStarted && !gameData.players[socket.id] && Object.keys(gameData.players).length >=4) return socket.emit("error", "Game in progress and full.");

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) gameData.playerSocketIds.push(socket.id);
    if(gameData.scores[name] === undefined) gameData.scores[name] = 120; 
    
    console.log(`[${SERVER_VERSION} SUBMITNAME] ${name} (${socket.id}) joined. Total players: ${Object.keys(gameData.players).length}.`);
    socket.emit("playerJoined", { playerId: socket.id, name });
    
    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted && numPlayers === 4) { 
      gameData.state = "Ready to Start";
      console.log(`[${SERVER_VERSION} SUBMITNAME] 4 players joined. Game state changed to 'Ready to Start'.`);
    } else if (!gameData.gameStarted && numPlayers < 4) {
        gameData.state = "Waiting for Players to Join";
    }
    io.emit("gameState", gameData); 
  });

  socket.on("startGame", () => {
    const playerName = getPlayerNameById(socket.id);
    console.log(`[${SERVER_VERSION} STARTGAME] Request from ${playerName || 'Unknown'} (${socket.id}). State: ${gameData.state}`);
    if (gameData.state !== "Ready to Start") return socket.emit("error", "Game not ready. Need 4 players & 'Ready to Start' state.");
    if (Object.keys(gameData.players).length !== 4) return socket.emit("error", "Need exactly 4 players.");
    
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]); 
    const dealerSocketId = gameData.playerSocketIds[0];
    gameData.dealer = dealerSocketId; 

    gameData.playerOrderActive = [];
    for (let i = 1; i <= 3; i++) {
        const activePlayerSocketId = gameData.playerSocketIds[i % gameData.playerSocketIds.length]; 
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }
    initializeNewRoundState(); 
    gameData.state = "Dealing Pending"; 
    console.log(`[${SERVER_VERSION} STARTGAME] Game started! Dealer ID: ${gameData.dealer} (Name: ${getPlayerNameById(gameData.dealer)}). Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    const playerName = getPlayerNameById(socket.id); 
    const dealerName = getPlayerNameById(gameData.dealer); 
    console.log(`[${SERVER_VERSION} DEALCARDS] Request from ${playerName} (${socket.id}). State: ${gameData.state}, Assigned Dealer: ${dealerName} (ID: ${gameData.dealer})`);

    if (gameData.state !== "Dealing Pending") return socket.emit("error", "Not time for dealing.");
    if (!gameData.dealer || socket.id !== gameData.dealer) return socket.emit("error", "Only the dealer can deal."); 
    if (gameData.playerOrderActive.length !== 3) {
        console.error(`[${SERVER_VERSION} DEALCARDS] Error: Active players: ${gameData.playerOrderActive.length}`);
        return socket.emit("error", "Internal error: Active player setup incorrect.");
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
    console.log(`[${SERVER_VERSION} DEALCARDS] Cards dealt. State: 'Bidding Phase'. Turn: ${gameData.biddingTurnPlayerName}`);
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
        if (alreadyUpgraded) {
            resolveBiddingFinal(); return;
        }
        const frogBidderName = getPlayerNameById(gameData.originalFrogBidderId);
        gameData.state = "Awaiting Frog Upgrade Decision";
        gameData.biddingTurnPlayerName = frogBidderName; 
        io.to(gameData.originalFrogBidderId).emit("promptFrogUpgrade"); 
        io.emit("gameState", gameData); return; 
    }
    resolveBiddingFinal();
  }

  // MODIFIED: resolveBiddingFinal
  function resolveBiddingFinal() {
    const wasAwaitingUpgrade = gameData.state === "Awaiting Frog Upgrade Decision";
    if (!gameData.currentHighestBidDetails) {
        gameData.state = "Round Skipped"; 
        gameData.revealedWidowForFrog = []; // MODIFIED: Clear here
        console.log(`[${SERVER_VERSION} RESOLVEBIDDING] All passed. Round Skipped.`);
        setTimeout(() => { if (gameData.state === "Round Skipped") prepareNextRound(); }, 5000); 
    } else {
      gameData.bidWinnerInfo = { ...gameData.currentHighestBidDetails }; 
      if (gameData.bidWinnerInfo.bid === "Frog") {
        gameData.trumpSuit = "H"; 
        gameData.state = "FrogBidderConfirmWidow";
        // revealedWidowForFrog will be set when bidder confirms via frogBidderConfirmsWidowTake
        io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogBidderConfirmWidow"); 
      } else { 
        gameData.revealedWidowForFrog = []; // MODIFIED: Clear if not Frog bid
        if (gameData.bidWinnerInfo.bid === "Heart Solo") {
          gameData.trumpSuit = "H"; 
          transitionToPlayingPhase(); 
        } else if (gameData.bidWinnerInfo.bid === "Solo") {
          gameData.state = "Trump Selection"; 
          io.to(gameData.bidWinnerInfo.playerId).emit("promptChooseTrump");
        } else { 
          gameData.state = "Error - Invalid Bid Outcome";
          console.error(`[${SERVER_VERSION} RESOLVEBIDDING] Error: Unhandled bid outcome for bid:`, gameData.bidWinnerInfo.bid);
        }
      }
    }
    if (wasAwaitingUpgrade && gameData.state !== "Awaiting Frog Upgrade Decision") { /* cleanup done below */ }
    gameData.originalFrogBidderId = null; 
    gameData.soloBidMadeAfterFrog = false;
    gameData.bidsMadeCount = 0; 
    gameData.biddingTurnPlayerName = null; 
    io.emit("gameState", gameData); 
  }

  socket.on("placeBid", ({ bid }) => { 
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found for bid.");
    console.log(`[${SERVER_VERSION} PLACEBID] Player: ${pName}, Bid: ${bid}, State: ${gameData.state}`);

    if (gameData.state === "Awaiting Frog Upgrade Decision") {
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) {
            return socket.emit("error", "Invalid frog upgrade bid/pass.");
        }
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") {
            gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        }
        resolveBiddingFinal(); 
        return;
    }

    if (gameData.state !== "Bidding Phase" || pName !== gameData.biddingTurnPlayerName || !BID_HIERARCHY.includes(bid)) {
        return socket.emit("error", "Not your turn, wrong phase, or invalid bid type.");
    }
    const currentHighestBidIndex = gameData.currentHighestBidDetails ? BID_HIERARCHY.indexOf(gameData.currentHighestBidDetails.bid) : -1;
    if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) {
        return socket.emit("error", "Bid is not higher than current highest bid.");
    }
    
    gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "RegularBid", bidValue: bid });
    
    if (bid !== "Pass") {
      gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid };
      // This logic for originalFrogBidderId needs to be careful about who is the first *active* player.
      // gameData.playerOrderActive[0] is the first active player.
      if (pName === gameData.playerOrderActive[0] && bid === "Frog" && !gameData.originalFrogBidderId) { 
          gameData.originalFrogBidderId = socket.id;
      } else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) {
          gameData.soloBidMadeAfterFrog = true;
      }
    }
    gameData.bidsMadeCount++;

    if (gameData.bidsMadeCount >= gameData.playerOrderActive.length) {
      const nonPassBids = gameData.bidsThisRound.filter(b => b.bidValue !== "Pass" && b.bidType === "RegularBid");
      const lastRealBidIndex = nonPassBids.length > 0 ? gameData.bidsThisRound.lastIndexOf(nonPassBids[nonPassBids.length - 1]) : -1;
      const passesSinceLastRealBid = gameData.bidsThisRound.slice(lastRealBidIndex + 1)
                                     .filter(b => b.bidValue === "Pass" && b.bidType === "RegularBid").length;

      if ( (gameData.currentHighestBidDetails && passesSinceLastRealBid >= (gameData.playerOrderActive.length - 1) ) ||
           (!gameData.currentHighestBidDetails && gameData.bidsMadeCount === gameData.playerOrderActive.length) ) {
        checkForFrogUpgrade();
      } else {
        let currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
        let nextBidderName = null;
        for (let i = 1; i < gameData.playerOrderActive.length; i++) {
            let nextIndex = (currentBidderIndexInActiveOrder + i) % gameData.playerOrderActive.length;
            let potentialNextBidder = gameData.playerOrderActive[nextIndex];
            const hasPassedThisRoundAlready = gameData.bidsThisRound.find(b => 
                b.playerName === potentialNextBidder && 
                b.bidValue === "Pass" && 
                b.bidType === "RegularBid" &&
                gameData.bidsThisRound.indexOf(b) > lastRealBidIndex // Only count passes *after* the last real bid
            );
            if (!hasPassedThisRoundAlready) {
                nextBidderName = potentialNextBidder;
                break;
            }
        }
        if (nextBidderName) {
            gameData.biddingTurnPlayerName = nextBidderName;
        } else {
            console.log(`[${SERVER_VERSION} PLACEBID] Fallback: All remaining players seem to have passed after a bid. Checking for frog upgrade.`);
            checkForFrogUpgrade();
            return;
        }
        io.emit("gameState", gameData);
      }
    } else { 
      const currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      gameData.biddingTurnPlayerName = gameData.playerOrderActive[(currentBidderIndexInActiveOrder + 1) % gameData.playerOrderActive.length];
      io.emit("gameState", gameData);
    }
  });
  
  // MODIFIED: socket.on("frogBidderConfirmsWidowTake", ...)
  socket.on("frogBidderConfirmsWidowTake", () => {
    const playerName = getPlayerNameById(socket.id);
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog") {
        return socket.emit("error", "Not authorized or not a Frog bid.");
    }
    if (gameData.state !== "FrogBidderConfirmWidow") {
        return socket.emit("error", "Not the correct phase to confirm widow take.");
    }
    
    gameData.state = "Frog Widow Exchange";
    gameData.revealedWidowForFrog = [...gameData.originalDealtWidow]; // MODIFIED: Set for all
    
    console.log(`[${SERVER_VERSION} FROGBIDDERCONFIRMSWIDOWTAKE] ${playerName} confirmed. State: Frog Widow Exchange.`);
    console.log(`[${SERVER_VERSION}] Revealed Widow (for all to see): ${gameData.revealedWidowForFrog.join(', ')}`);
    
    io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogWidowExchange", { widow: [...gameData.originalDealtWidow] }); 
    io.emit("gameState", gameData); 
  });

  // MODIFIED: socket.on("submitFrogDiscards", ...)
  socket.on("submitFrogDiscards", ({ discards }) => {
    const pName = getPlayerNameById(socket.id);
    console.log(`[${SERVER_VERSION} SUBMITFROGDISCARDS] Player: ${pName}, Discards attempted:`, discards);

    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog") {
        return socket.emit("error", "Not your turn or not a Frog bid for discards.");
    }
    if (gameData.state !== "Frog Widow Exchange") { 
        return socket.emit("error", "Not the correct game phase for submitting discards.");
    }
    if (!Array.isArray(discards) || discards.length !== 3) {
        return socket.emit("error", "Must discard exactly 3 cards.");
    }
    
    let originalPlayerHand = gameData.hands[pName] || [];
    if (originalPlayerHand.length !== 11) {
        console.error(`[${SERVER_VERSION} ERROR SUBMITFROGDISCARDS] Player ${pName}'s hand before exchange is not 11. Hand:`, originalPlayerHand);
    }
    let combinedForValidation = [...originalPlayerHand, ...gameData.originalDealtWidow]; 
    console.log(`[${SERVER_VERSION} SUBMITFROGDISCARDS] ${pName}'s combined hand for validation (should be 14 cards):`, combinedForValidation.sort());
    
    let tempCombinedCheck = [...combinedForValidation]; 
    const allDiscardsValid = discards.every(d => { 
        const i = tempCombinedCheck.indexOf(d); 
        if (i > -1) { 
            tempCombinedCheck.splice(i, 1); return true; 
        }
        console.error(`[${SERVER_VERSION} ERROR SUBMITFROGDISCARDS] Invalid discard: ${d} not found in combined hand for ${pName}`);
        return false; 
    });

    if (!allDiscardsValid) {
        return socket.emit("error", "Invalid discards - one or more cards not found in your combined hand (original hand + dealt widow).");
    }
    
    let finalHandAfterExchange = [...combinedForValidation]; 
    discards.forEach(d => { 
        const i = finalHandAfterExchange.indexOf(d); 
        if (i > -1) finalHandAfterExchange.splice(i, 1); 
    });
    
    if (finalHandAfterExchange.length !== 11) {
         console.error(`[${SERVER_VERSION} ERROR SUBMITFROGDISCARDS] Hand size for ${pName} incorrect after discard. Expected 11, got ${finalHandAfterExchange.length}. Final Hand:`, finalHandAfterExchange.sort());
         return socket.emit("error", `Internal error: Hand size incorrect after discard. Expected 11, got ${finalHandAfterExchange.length}.`);
    }

    gameData.hands[pName] = finalHandAfterExchange.sort(); 
    gameData.widowDiscardsForFrogBidder = [...discards].sort(); 
    gameData.widow = [...discards].sort(); 
    gameData.revealedWidowForFrog = []; // MODIFIED: Clear the publicly revealed widow

    console.log(`[${SERVER_VERSION} SUBMITFROGDISCARDS] ${pName} successfully discarded for Frog: ${discards.join(',')}.`);
    console.log(`[${SERVER_VERSION} SUBMITFROGDISCARDS] ${pName}'s new hand: ${gameData.hands[pName].join(',')}`);
    console.log(`[${SERVER_VERSION} SUBMITFROGDISCARDS] Widow for scoring (Frog's discards): ${gameData.widow.join(',')}`);
    
    transitionToPlayingPhase(); 
  });

  socket.on("chooseTrump", (suitKey) => { 
    if (gameData.state !== "Trump Selection" || !gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId) {
        return socket.emit("error", "Cannot choose trump now or not authorized.");
    }
    if (!["D", "S", "C"].includes(suitKey)) return socket.emit("error", "Invalid trump for Solo (cannot be Hearts).");
    gameData.trumpSuit = suitKey; 
    console.log(`[${SERVER_VERSION}] Trump chosen for Solo: ${suitKey} by ${getPlayerNameFromId(gameData.bidWinnerInfo.playerId, gameData.players)}`); // Used getPlayerNameFromId
    transitionToPlayingPhase(); 
  });

  socket.on("playCard", ({ card }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName || gameData.state !== "Playing Phase" || pName !== gameData.trickTurnPlayerName) {
        return socket.emit("error", "Not your turn or not in playing phase.");
    }
    const hand = gameData.hands[pName];
    if (!hand || !hand.includes(card)) return socket.emit("error", "Card not in hand.");
    
    const isLeading = gameData.currentTrickCards.length === 0;
    const playedSuit = getSuit(card);

    if (isLeading) { 
        if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken && !hand.every(c => getSuit(c) === gameData.trumpSuit)) {
            return socket.emit("error", "Cannot lead trump if not broken and non-trump cards are available.");
        }
    } else { 
        const leadCardSuit = gameData.leadSuitCurrentTrick;
        if (playedSuit !== leadCardSuit && hand.some(c => getSuit(c) === leadCardSuit)) { 
            return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        }
        if (playedSuit !== leadCardSuit && !hand.some(c => getSuit(c) === leadCardSuit) && 
            playedSuit !== gameData.trumpSuit && hand.some(c => getSuit(c) === gameData.trumpSuit)) {
            return socket.emit("error", `Void in ${SUITS[leadCardSuit]}, must play trump if you have it.`);
        }
    }

    gameData.hands[pName] = hand.filter(c => c !== card);
    gameData.currentTrickCards.push({ playerId: socket.id, playerName: pName, card });
    if (isLeading) gameData.leadSuitCurrentTrick = playedSuit;
    
    if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken) {
        gameData.trumpBroken = true;
        console.log(`[${SERVER_VERSION}] Trump has been broken by ${pName} playing ${card}.`);
    }
    
    if (gameData.currentTrickCards.length === gameData.playerOrderActive.length) { 
      const winnerName = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      if (winnerName && gameData.capturedTricks[winnerName]) {
          gameData.capturedTricks[winnerName].push([...gameData.currentTrickCards.map(p => p.card)]);
      } else {
          console.error(`[${SERVER_VERSION} ERROR] Assigning captured trick for winner: ${winnerName}`);
          if (winnerName && !gameData.capturedTricks[winnerName]) gameData.capturedTricks[winnerName] = []; 
          if (winnerName) gameData.capturedTricks[winnerName].push([...gameData.currentTrickCards.map(p => p.card)]);
      }
      gameData.tricksPlayedCount++;
      gameData.trickLeaderName = winnerName; 
      console.log(`[${SERVER_VERSION}] Trick ${gameData.tricksPlayedCount} won by ${winnerName}. Cards: ${gameData.currentTrickCards.map(c=>c.card).join()}`);

      if (gameData.tricksPlayedCount === 11) { 
        console.log(`[${SERVER_VERSION}] All 11 tricks played. Winner of last trick: ${gameData.trickLeaderName}. Proceeding to scoring.`);
        calculateRoundScores(); 
      } else {
          gameData.currentTrickCards = []; 
          gameData.leadSuitCurrentTrick = null;
          gameData.trickTurnPlayerName = winnerName; 
          io.emit("gameState", gameData);
      }
    } else { 
      const currentIdxInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      gameData.trickTurnPlayerName = gameData.playerOrderActive[(currentIdxInActiveOrder + 1) % gameData.playerOrderActive.length];
      io.emit("gameState", gameData);
    }
  });

  function calculateRoundScores() {
    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        console.error(`[${SERVER_VERSION} SCORING ERROR] Pre-requisite fail. BidWinner:`, gameData.bidWinnerInfo, "TricksPlayed:", gameData.tricksPlayedCount);
        gameData.state = "Error - Scoring Failed PreRequisite";
        io.emit("gameState", gameData); return;
    }
    console.log(`[${SERVER_VERSION} SCORING] Starting. Winner of last trick: ${gameData.trickLeaderName}`);

    const bidWinnerName = gameData.bidWinnerInfo.playerName; // This is the actual name
    const bidType = gameData.bidWinnerInfo.bid;
    const bidMultiplier = {"Frog": 1, "Solo": 2, "Heart Solo": 3}[bidType];

    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0; 
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null }; // awardedTo will store player NAME

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
    console.log(`[${SERVER_VERSION} SCORING] After widow award: Bidder Pts=${bidderTotalCardPoints}, Defender Pts=${defendersTotalCardPoints}`);

    Object.keys(gameData.capturedTricks).forEach(playerName => { // playerName here is actual name
        const tricksWonByPlayer = gameData.capturedTricks[playerName] || [];
        let playerTrickPoints = 0;
        tricksWonByPlayer.forEach(trickArray => { 
            playerTrickPoints += calculateCardPoints(trickArray);
        });
        if (playerName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else if (gameData.playerOrderActive.includes(playerName)) { 
            defendersTotalCardPoints += playerTrickPoints;
        }
    });
    console.log(`[${SERVER_VERSION} SCORING] After trick points: Bidder Pts=${bidderTotalCardPoints}, Defender Pts=${defendersTotalCardPoints}`);
    
    const totalPointsAccountedFor = bidderTotalCardPoints + defendersTotalCardPoints;
    if (totalPointsAccountedFor !== 120) {
        console.warn(`[${SERVER_VERSION} SCORING WARNING] Total card points (${totalPointsAccountedFor}) do not sum to 120!`);
    }

    const targetPoints = 60;
    const scoreDifferenceFromTarget = bidderTotalCardPoints - targetPoints;
    let bidMadeSuccessfully = bidderTotalCardPoints > targetPoints; 
    let gamePointChangeForBidder = 0;
    let roundMessage = "";

    if (bidderTotalCardPoints === targetPoints) { 
        bidMadeSuccessfully = false; 
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) scored exactly 60. No game points exchanged.`;
    } else if (bidMadeSuccessfully) { 
        const basePointsWonByBidder = scoreDifferenceFromTarget * bidMultiplier;
        gamePointChangeForBidder = basePointsWonByBidder;
        const lossPerActiveOpponent = basePointsWonByBidder / 2; 

        gameData.scores[bidWinnerName] += gamePointChangeForBidder;
        gameData.playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                gameData.scores[pName] -= lossPerActiveOpponent;
            }
        });
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) succeeded! Gains ${gamePointChangeForBidder} pts. Active opponents lose ${lossPerActiveOpponent} each.`;
    } else { 
        const basePointsOwedToEachRecipient = Math.abs(scoreDifferenceFromTarget) * bidMultiplier;
        let totalPointsLostByBidder = 0;

        gameData.playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                gameData.scores[pName] += basePointsOwedToEachRecipient;
                totalPointsLostByBidder += basePointsOwedToEachRecipient;
            }
        });

        const numTotalPlayers = gameData.playerSocketIds.length;
        if (numTotalPlayers === 4 && gameData.dealer) { // gameData.dealer is socket ID
            const dealerNameActual = getPlayerNameById(gameData.dealer); 
            if (dealerNameActual && dealerNameActual !== bidWinnerName && !gameData.playerOrderActive.includes(dealerNameActual)) {
                gameData.scores[dealerNameActual] += basePointsOwedToEachRecipient;
                totalPointsLostByBidder += basePointsOwedToEachRecipient;
            }
        }
        gameData.scores[bidWinnerName] -= totalPointsLostByBidder;
        gamePointChangeForBidder = -totalPointsLostByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) failed. Loses ${totalPointsLostByBidder} pts. Recipients gain ${basePointsOwedToEachRecipient} each.`;
    }

    let isGameOver = false;
    Object.values(gameData.scores).forEach(score => {
        if (score <= 0) { isGameOver = true; }
    });

    let gameWinner = null;
    if (isGameOver) { 
        let contenders = [];
        let highestScore = -Infinity;
        Object.entries(gameData.scores).forEach(([name, score]) => {
            if (score > highestScore) {
                highestScore = score; contenders = [name];
            } else if (score === highestScore) {
                contenders.push(name);
            }
        });
        gameWinner = contenders.join(" & ");
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner} with ${highestScore} points.`;
        gameData.state = "Game Over"; 
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints,
        defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo: awardedWidowInfo,
        bidMadeSuccessfully,
        finalScores: { ...gameData.scores },
        isGameOver,
        gameWinner,
        message: roundMessage,
    };
    console.log(`[${SERVER_VERSION} SCORING] Round Summary:`, gameData.roundSummary);

    if (!isGameOver) gameData.state = "Scoring Phase"; 
    
    io.emit("gameState", gameData);

    if (!isGameOver) {
        console.log(`[${SERVER_VERSION} SCORING] Game not over. Scheduling next round prep.`);
        setTimeout(() => {
            if (gameData.state === "Scoring Phase") prepareNextRound(); 
        }, 10000); 
    } else {
        console.log(`[${SERVER_VERSION} SCORING] Game is OVER. Final scores:`, gameData.scores);
    }
  }

  function prepareNextRound() {
    console.log(`[${SERVER_VERSION}] Preparing for next round. Current Dealer: ${getPlayerNameById(gameData.dealer)}`);
    const numTotalPlayers = gameData.playerSocketIds.length;

    if (numTotalPlayers < 3 || numTotalPlayers > 4) { 
        console.error(`[${SERVER_VERSION} NEXTROUND ERROR] Invalid players: ${numTotalPlayers}`);
        gameData.state = "Error - Player Count Issue";
        io.emit("gameState", gameData); return;
    }

    let currentDealerSocketId = gameData.dealer; 
    if (!currentDealerSocketId || !gameData.playerSocketIds.includes(currentDealerSocketId)) { 
        console.warn(`[${SERVER_VERSION} NEXTROUND WARN] Current dealer SID not found/invalid. Defaulting.`);
        if (gameData.playerSocketIds.length > 0) currentDealerSocketId = gameData.playerSocketIds[gameData.playerSocketIds.length - 1];
        else {
            console.error(`[${SERVER_VERSION} NEXTROUND ERROR] No players to determine dealer.`);
            gameData.state = "Error - Cannot Rotate Dealer";
            io.emit("gameState", gameData); return;
        }
    }
    let currentDealerIndexInTableOrder = gameData.playerSocketIds.indexOf(currentDealerSocketId);
    
    const nextDealerIndexInTableOrder = (currentDealerIndexInTableOrder + 1) % numTotalPlayers;
    gameData.dealer = gameData.playerSocketIds[nextDealerIndexInTableOrder]; 

    gameData.playerOrderActive = [];
    if (numTotalPlayers === 4) { 
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
            gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else if (numTotalPlayers === 3) { 
        for (let i = 0; i < numTotalPlayers; i++) { // All 3 are active, dealer is one of them
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers]; // This order might need adjustment for "first to dealer's left" in bidding
            if (gameData.players[activePlayerSocketId]) { 
                gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
            }
        }
        // For 3 players, the playerOrderActive should be the players in turn order starting from dealer's left.
        // If dealer is playerSocketIds[nextDealerIndexInTableOrder], then active order is:
        // playerSocketIds[(nextDealerIndexInTableOrder + 1)%3]
        // playerSocketIds[(nextDealerIndexInTableOrder + 2)%3]
        // playerSocketIds[(nextDealerIndexInTableOrder + 0)%3] -> the dealer
        // The current loop for 3 players might be simpler: just take them in order after new dealer.
        // Let's ensure playerOrderActive truly reflects the play order.
        // If dealer is index D, active order is (D+1)%N, (D+2)%N, ..., (D+N-1)%N
        // For 3 players, N=3. (D+1)%3, (D+2)%3, dealer (D)%3.
        // The current code for numTotalPlayers === 3:
        // i from 0 to 2 (inclusive of dealer if the loop goes 0 to N-1 and then +1 from dealer).
        // Let's re-verify Sluff rules for 3-player active order if it's different from 4-player "dealer is inactive".
        // Rule 2.1: "3-Player Game: All 3 players are "active" participants"
        // Rule 3.2: "Bidding commences with the first active player to the dealer's left."
        // So, the dealer *is* active. The order should be (dealer's left), (next player), (dealer).
        // Our `playerSocketIds` is table order. `gameData.dealer` is the new dealer's ID.
        // `nextDealerIndexInTableOrder` is their index.
        // Player to dealer's left is `(nextDealerIndexInTableOrder + 1) % numTotalPlayers`.
        gameData.playerOrderActive = []; // Reset
        for (let i = 1; i <= numTotalPlayers; i++) { // Iterate N times to get all N active players
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
             if (gameData.players[activePlayerSocketId]) {
                gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
            }
        }

    }
    
    initializeNewRoundState(); 
    gameData.state = "Dealing Pending"; 
    
    console.log(`[${SERVER_VERSION} NEXTROUND] New round ready. Dealer ID: ${gameData.dealer} (Name: ${getPlayerNameById(gameData.dealer)}). Active: ${gameData.playerOrderActive.join(', ')}.`);
    io.emit("gameState", gameData);
  }

  socket.on("resetGame", () => { 
    console.log(`[${SERVER_VERSION} RESETGAME] Full game reset requested.`);
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });

  socket.on("disconnect", (reason) => {
    const pName = gameData.players[socket.id];
    console.log(`[${SERVER_VERSION} DISCONNECT] ${pName || socket.id} disconnected. Reason: ${reason}`);
    if (pName) {
        const wasDealer = gameData.dealer === socket.id;
        const wasInActiveOrder = gameData.playerOrderActive.includes(pName);

        delete gameData.players[socket.id];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== socket.id);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        
        const numPlayers = Object.keys(gameData.players).length;
        const minPlayersNeeded = gameData.playerSocketIds.length === 3 ? 3 : 4; // Or just check numTotalPlayers before disconnect

        if (gameData.gameStarted && numPlayers < 3) { // Game cannot continue with less than 3
            console.log(`[${SERVER_VERSION} DISCONNECT] Game was in progress, <3 players. Resetting.`);
            resetFullGameData(); 
        } else if (gameData.gameStarted && (wasDealer || wasInActiveOrder)) {
            console.log(`[${SERVER_VERSION} DISCONNECT] Active/Dealer player ${pName} disconnected mid-game. State: ${gameData.state}. Players left: ${numPlayers}`);
            // More complex logic needed here to handle mid-round disconnects gracefully.
            // For now, if enough players remain, the game might stall if it was their turn.
            // Consider resetting if it's a critical phase.
            if (numPlayers < 3) resetFullGameData(); // If drops below 3 due to this disconnect
        } else if (!gameData.gameStarted && numPlayers < 4 && gameData.state === "Ready to Start") { // Was ready, now not
            gameData.state = "Waiting for Players to Join";
        } else if (!gameData.gameStarted && numPlayers < 4) { // Generally, if not started and < 4
             gameData.state = "Waiting for Players to Join";
        }
        
        if (numPlayers === 0) { 
            console.log(`[${SERVER_VERSION} DISCONNECT] All players disconnected. Resetting game.`);
            resetFullGameData();
        }
        io.emit("gameState", gameData); 
    }
  });
}); // End of io.on("connection")

// --- Server Listen ---
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { 
  res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`);
});
server.listen(PORT, () => {
  console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`);
});