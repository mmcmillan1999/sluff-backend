require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*", credentials: true }));
app.use(express.json());

// Deck of Cards & Card Utils
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"]; 
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };

let deck = [];
for (let suitKey in SUITS) {
  for (let rank of RANKS_ORDER) {
    deck.push(rank + suitKey);
  }
}

const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];

function getSuit(cardStr) { return cardStr ? cardStr.slice(-1) : null; }
function getRank(cardStr) { return cardStr ? cardStr.slice(0, -1) : null; }

// Game State Initialization
let gameData = {
  state: "Waiting for Players to Join",
  players: {}, 
  playerSocketIds: [],
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
};


function getPlayerNameById(socketId) {
    return gameData.players[socketId];
}

function shuffle(array) {
  let currentIndex = array.length,  randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
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
    gameData.hands = {};
    gameData.widow = []; 
    gameData.originalDealtWidow = [];
    gameData.widowDiscardsForFrogBidder = [];
    gameData.bidsThisRound = [];
    gameData.currentHighestBidDetails = null;
    gameData.trumpSuit = null; 
    gameData.bidWinnerInfo = null;
    gameData.biddingTurnPlayerName = null;
    gameData.bidsMadeCount = 0;
    gameData.originalFrogBidderId = null;
    gameData.soloBidMadeAfterFrog = false;
    gameData.currentTrickCards = [];
    gameData.trickTurnPlayerName = null;
    gameData.tricksPlayedCount = 0;
    gameData.leadSuitCurrentTrick = null;
    gameData.trumpBroken = false; 
    gameData.trickLeaderName = null;
    gameData.capturedTricks = {};
    gameData.roundSummary = null;

    Object.values(gameData.players).forEach(pName => {
        if(pName) gameData.capturedTricks[pName] = [];
    });
    console.log("[SERVER] New round state initialized.");
}

function resetFullGameData() {
    console.log("[SERVER] Performing full game data reset.");
    gameData = {
        state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
        playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
        widowDiscardsForFrogBidder: [],
        scores: {}, bidsThisRound: [], currentHighestBidDetails: null, biddingTurnPlayerName: null,
        bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false,
        currentTrickCards: [], trickTurnPlayerName: null, tricksPlayedCount: 0,
        leadSuitCurrentTrick: null, trumpBroken: false, trickLeaderName: null, capturedTricks: {},
        roundSummary: null
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
    else winningPlay = trickCards[0]; 
    
    return winningPlay ? winningPlay.playerName : null;
}


io.on("connection", (socket) => {
  console.log(`[SERVER CONNECT] Player connected: ${socket.id}. Players: ${Object.keys(gameData.players).length}`);
  socket.emit("gameState", gameData); 

  socket.on("submitName", (name) => {
    // ... (same as previous version)
    console.log(`[SERVER SUBMITNAME] ${socket.id} with name "${name}". Players: ${Object.keys(gameData.players).length}, Started: ${gameData.gameStarted}`);
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
    console.log(`[SERVER SUBMITNAME] ${name} (${socket.id}) joined. Players now: ${Object.keys(gameData.players).length}.`);
    socket.emit("playerJoined", { playerId: socket.id, name }); 
    io.emit("gameState", gameData); 
    if (!gameData.gameStarted && Object.keys(gameData.players).length === 4) {
      gameData.state = "Ready to Start";
      io.emit("gameState", gameData);
    }
  });

  socket.on("startGame", () => {
    // ... (same as previous version)
    if (gameData.state !== "Ready to Start") return socket.emit("error", "Game not ready.");
    if (Object.keys(gameData.players).length !== 4) return socket.emit("error", "Need 4 players to start this configuration.");
    
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]); 
    const dealerIndexInTableOrder = 0; 
    gameData.dealer = gameData.players[gameData.playerSocketIds[dealerIndexInTableOrder]];
    gameData.playerOrderActive = [];
    const numTotalPlayers = gameData.playerSocketIds.length;

    if (numTotalPlayers === 4) {
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(dealerIndexInTableOrder + i) % numTotalPlayers];
            gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else {
        return socket.emit("error", "Unsupported number of players for starting game logic (needs 4).");
    }
    initializeNewRoundState(); 
    gameData.state = "Dealing Pending";
    console.log(`[SERVER STARTGAME] Game started. Table order: ${gameData.playerSocketIds.map(id => gameData.players[id]).join(', ')}. Dealer: ${gameData.dealer}. Active players for round: ${gameData.playerOrderActive.join(', ')}.`);
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    // ... (same as previous version)
    if (gameData.state !== "Dealing Pending" || getPlayerNameById(socket.id) !== gameData.dealer) return;
    if (gameData.playerOrderActive.length !== 3) {
        console.error("[SERVER DEALCARDS] Incorrect number of active players for dealing:", gameData.playerOrderActive.length);
        return socket.emit("error", "Internal error: Active player setup incorrect for dealing.");
    }

    const shuffled = shuffle([...deck]);
    gameData.playerOrderActive.forEach((pName, i) => { 
        if(pName) gameData.hands[pName] = shuffled.slice(i * 11, (i + 1) * 11); 
    });
    const cardsDealtToPlayers = 11 * gameData.playerOrderActive.length;
    gameData.widow = shuffled.slice(cardsDealtToPlayers);
    gameData.originalDealtWidow = [...gameData.widow];

    gameData.state = "Bidding Phase";
    gameData.bidsMadeCount = 0;
    gameData.biddingTurnPlayerName = gameData.playerOrderActive[0]; 
    io.emit("gameState", gameData);
  });

  socket.on("placeBid", ({ bid }) => { 
    // ... (same as previous version)
    const pName = getPlayerNameById(socket.id);
    if (!pName) return;
    if (gameData.state === "Awaiting Frog Upgrade Decision") {
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        // gameData.state = "Bidding Phase"; // This was incorrect, resolveBiddingFinal handles state
        resolveBiddingFinal(); return;
    }
    if (gameData.state !== "Bidding Phase" || pName !== gameData.biddingTurnPlayerName || !BID_HIERARCHY.includes(bid)) return;
    const currentIdx = gameData.currentHighestBidDetails ? BID_HIERARCHY.indexOf(gameData.currentHighestBidDetails.bid) : -1;
    if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentIdx) return socket.emit("error", "Bid too low.");
    
    gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "RegularBid", bidValue: bid });
    
    if (bid !== "Pass") {
      gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid };
      const isFirstBidderInOrder = gameData.playerOrderActive.indexOf(pName) === 0;
      if (isFirstBidderInOrder && bid === "Frog" && !gameData.originalFrogBidderId) {
          gameData.originalFrogBidderId = socket.id;
      } else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) {
          gameData.soloBidMadeAfterFrog = true;
      }
    }
    gameData.bidsMadeCount++;
    if (gameData.bidsMadeCount >= gameData.playerOrderActive.length) {
      checkForFrogUpgrade();
    } else {
      const currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      gameData.biddingTurnPlayerName = gameData.playerOrderActive[(currentBidderIndexInActiveOrder + 1) % gameData.playerOrderActive.length];
      io.emit("gameState", gameData);
    }
  });

  function checkForFrogUpgrade() {
    // ... (same as previous version)
    const isFrogBidderHighestOrSoloByOtherIsHighest = 
        gameData.currentHighestBidDetails && 
        ( (gameData.currentHighestBidDetails.bid === "Frog" && gameData.currentHighestBidDetails.playerId === gameData.originalFrogBidderId) ||
          (gameData.currentHighestBidDetails.bid === "Solo" && gameData.currentHighestBidDetails.playerId !== gameData.originalFrogBidderId && gameData.soloBidMadeAfterFrog) );

    if (gameData.originalFrogBidderId && gameData.soloBidMadeAfterFrog && isFrogBidderHighestOrSoloByOtherIsHighest &&
        (!gameData.currentHighestBidDetails || gameData.currentHighestBidDetails.bid !== "Heart Solo") ) {
        
        const alreadyUpgraded = gameData.bidsThisRound.some(b => b.playerId === gameData.originalFrogBidderId && b.bidValue === "Heart Solo" && b.bidType === "FrogUpgradeDecision");
        if (alreadyUpgraded) {
            resolveBiddingFinal();
            return;
        }

        const frogBidderName = getPlayerNameById(gameData.originalFrogBidderId);
        gameData.state = "Awaiting Frog Upgrade Decision";
        gameData.biddingTurnPlayerName = frogBidderName; 
        io.to(gameData.originalFrogBidderId).emit("promptFrogUpgrade"); 
        io.emit("gameState", gameData); return; 
    }
    resolveBiddingFinal();
  }

  function resolveBiddingFinal() {
    // ... (same as previous version, ensure state transitions are correct)
    // Reset bidding flags for the next round
    const wasAwaitingUpgrade = gameData.state === "Awaiting Frog Upgrade Decision";

    if (!gameData.currentHighestBidDetails) {
        gameData.state = "Round Skipped";
        console.log("[SERVER RESOLVEBIDDING] All passed. Round Skipped.");
        setTimeout(() => { prepareNextRound(); }, 5000); 
    } else {
      gameData.bidWinnerInfo = { ...gameData.currentHighestBidDetails }; 
      if (gameData.bidWinnerInfo.bid === "Frog") {
        gameData.trumpSuit = "H"; 
        gameData.state = "FrogBidderConfirmWidow";
        io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogBidderConfirmWidow"); 
      } else if (gameData.bidWinnerInfo.bid === "Heart Solo") {
        gameData.trumpSuit = "H"; 
        transitionToPlayingPhase(); 
      } else if (gameData.bidWinnerInfo.bid === "Solo") {
        gameData.state = "Trump Selection"; 
        io.to(gameData.bidWinnerInfo.playerId).emit("promptChooseTrump");
      } else {
        gameData.state = "Round Skipped"; // Fallback
         setTimeout(() => { prepareNextRound(); }, 5000);
      }
    }
    
    if (wasAwaitingUpgrade && gameData.state !== "Awaiting Frog Upgrade Decision") {
      // If we were awaiting upgrade and now resolved, clear originalFrogBidderId related flags earlier if needed
      // This is generally okay as they are reset here anyway for any outcome.
    }

    gameData.originalFrogBidderId = null; 
    gameData.soloBidMadeAfterFrog = false;
    gameData.bidsMadeCount = 0; 
    gameData.biddingTurnPlayerName = null;

    io.emit("gameState", gameData); 
  }

  socket.on("frogBidderConfirmsWidowTake", () => {
    // ... (same as previous version)
    const playerName = getPlayerNameById(socket.id);
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog") {
        return socket.emit("error", "Not authorized or not a Frog bid.");
    }
    if (gameData.state !== "FrogBidderConfirmWidow") {
        return socket.emit("error", "Not the correct phase to confirm widow take.");
    }
    
    gameData.state = "Frog Widow Exchange";
    console.log(`[SERVER] ${playerName} confirmed widow take. State: Frog Widow Exchange. Sending original widow for exchange:`, gameData.originalDealtWidow);
    io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogWidowExchange", { widow: [...gameData.originalDealtWidow] });
    io.emit("gameState", gameData);
  });


  function transitionToPlayingPhase() {
    // ... (same as previous version)
    gameData.state = "Playing Phase";
    gameData.tricksPlayedCount = 0; 
    gameData.trumpBroken = false; 
    gameData.currentTrickCards = []; 
    gameData.leadSuitCurrentTrick = null;
    gameData.trickLeaderName = gameData.bidWinnerInfo.playerName; 
    gameData.trickTurnPlayerName = gameData.bidWinnerInfo.playerName;
    
    console.log("[SERVER] Transitioning to Playing Phase. Winner:", gameData.bidWinnerInfo.playerName, "Trump:", gameData.trumpSuit);
    io.emit("gameState", gameData);
  }

  socket.on("submitFrogDiscards", ({ discards }) => {
    // ... (same as previous version, ensure validation is strict)
    const pName = getPlayerNameById(socket.id);
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog") {
        return socket.emit("error", "Not your turn or not a Frog bid for discards.");
    }
    if (gameData.state !== "Frog Widow Exchange") { 
        return socket.emit("error", "Not the correct game phase for submitting discards.");
    }
    if (!Array.isArray(discards) || discards.length !== 3) return socket.emit("error", "Must discard 3 cards.");
    
    let originalPlayerHand = gameData.hands[pName] || [];
    let combinedForValidation = [...originalPlayerHand, ...gameData.originalDealtWidow]; 
    
    let tempCombinedCheck = [...combinedForValidation]; 
    if (!discards.every(d => { const i = tempCombinedCheck.indexOf(d); if (i > -1) { tempCombinedCheck.splice(i, 1); return true; } return false; })) {
        console.error("Invalid discards. Player hand:", originalPlayerHand, "Original Dealt Widow:", gameData.originalDealtWidow, "Discards attempt:", discards);
        return socket.emit("error", "Invalid discards - cards not found in your original hand + dealt widow.");
    }
    
    let finalHandAfterExchange = [...combinedForValidation]; 
    discards.forEach(d => { const i = finalHandAfterExchange.indexOf(d); if (i > -1) finalHandAfterExchange.splice(i, 1); });
    
    if (finalHandAfterExchange.length !== 11) {
         return socket.emit("error", `Hand size incorrect after discard. Expected 11, got ${finalHandAfterExchange.length}.`);
    }

    gameData.hands[pName] = finalHandAfterExchange; 
    gameData.widowDiscardsForFrogBidder = [...discards]; 
    gameData.widow = [...discards];

    console.log(`[SERVER] ${pName} discarded for Frog: ${discards.join()}. New hand size: ${gameData.hands[pName].length}.`);
    transitionToPlayingPhase(); 
  });

  socket.on("chooseTrump", (suitKey) => { 
    // ... (same as previous version)
    if (gameData.state !== "Trump Selection" || !gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId) return;
    if (!["D", "S", "C"].includes(suitKey)) return socket.emit("error", "Invalid trump for Solo (cannot be Hearts).");
    gameData.trumpSuit = suitKey; 
    transitionToPlayingPhase(); 
  });

  socket.on("playCard", ({ card }) => {
    // ... (same as previous version, ensure trickLeaderName is updated for last trick)
    const pName = getPlayerNameById(socket.id);
    if (!pName || gameData.state !== "Playing Phase" || pName !== gameData.trickTurnPlayerName) return;
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
    }
    
    if (gameData.currentTrickCards.length === gameData.playerOrderActive.length) { 
      const winnerName = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      if (winnerName && gameData.capturedTricks[winnerName]) {
          gameData.capturedTricks[winnerName].push([...gameData.currentTrickCards.map(p => p.card)]);
      } else {
          console.error("Error assigning captured trick for winner:", winnerName);
          if (winnerName && !gameData.capturedTricks[winnerName]) gameData.capturedTricks[winnerName] = []; // Safety init
          if (winnerName) gameData.capturedTricks[winnerName].push([...gameData.currentTrickCards.map(p => p.card)]);
      }
      gameData.tricksPlayedCount++;
      gameData.trickLeaderName = winnerName; // Crucial: winner of this trick IS the trickLeaderName

      if (gameData.tricksPlayedCount === 11) {
        console.log("[SERVER PLAYCARD] All 11 tricks played. Winner of last trick:", gameData.trickLeaderName, ". Proceeding to scoring.");
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
    // ... (same as previous version, with added logging)
    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        console.error("[SERVER SCORING] PRE-REQUISITE FAIL: Cannot calculate scores. BidWinner:", gameData.bidWinnerInfo, "TricksPlayed:", gameData.tricksPlayedCount);
        gameData.state = "Error - Scoring Failed PreRequisite";
        io.emit("gameState", gameData);
        return;
    }
    console.log("[SERVER SCORING] Starting score calculation. Winner of last trick:", gameData.trickLeaderName);

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
        // gameData.trickLeaderName is the winner of the 11th (final) trick
        if (gameData.trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = bidWinnerName;
        } else {
            defendersTotalCardPoints += awardedWidowInfo.points; 
            awardedWidowInfo.awardedTo = gameData.trickLeaderName; 
        }
    }
    console.log(`[SERVER SCORING] After widow award: Bidder Pts=${bidderTotalCardPoints}, Defender Pts=${defendersTotalCardPoints}, Widow Info:`, awardedWidowInfo);

    gameData.playerOrderActive.forEach(playerName => {
        const tricks = gameData.capturedTricks[playerName] || [];
        let playerTrickPoints = 0;
        tricks.forEach(trick => {
            playerTrickPoints += calculateCardPoints(trick);
        });
        if (playerName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });
    console.log(`[SERVER SCORING] After trick points: Bidder Pts=${bidderTotalCardPoints}, Defender Pts=${defendersTotalCardPoints}`);
    
    const totalPointsAccountedFor = bidderTotalCardPoints + defendersTotalCardPoints;
    if (totalPointsAccountedFor !== 120) {
        console.warn(`[SCORING WARNING] Total card points (${totalPointsAccountedFor}) do not sum to 120!`);
    }

    const targetPoints = 60;
    const scoreDifferenceFromTarget = bidderTotalCardPoints - targetPoints;
    let bidMadeSuccessfully = bidderTotalCardPoints > targetPoints; 
    let gamePointChangeForBidder = 0;
    let gamePointChangePerRecipient = 0;
    let roundMessage = "";

    if (bidderTotalCardPoints === targetPoints) {
        bidMadeSuccessfully = false;
        gamePointChangeForBidder = 0;
        gamePointChangePerRecipient = 0;
        roundMessage = `${bidWinnerName} scored exactly 60. No game points exchanged.`;
    } else if (bidMadeSuccessfully) {
        const basePointsWonByBidder = scoreDifferenceFromTarget * bidMultiplier;
        gamePointChangeForBidder = basePointsWonByBidder;
        const lossPerActiveOpponent = basePointsWonByBidder / 2;
        gamePointChangePerRecipient = -lossPerActiveOpponent; 

        gameData.scores[bidWinnerName] += gamePointChangeForBidder;
        gameData.playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                gameData.scores[pName] -= lossPerActiveOpponent;
            }
        });
        roundMessage = `${bidWinnerName} succeeded! Gains ${gamePointChangeForBidder} pts. Active opponents lose ${lossPerActiveOpponent} each.`;
    } else { 
        const basePointsOwedToEachRecipient = Math.abs(scoreDifferenceFromTarget) * bidMultiplier;
        gamePointChangePerRecipient = basePointsOwedToEachRecipient;
        let totalPointsLostByBidder = 0;

        gameData.playerOrderActive.forEach(pName => {
            if (pName !== bidWinnerName) {
                gameData.scores[pName] += basePointsOwedToEachRecipient;
                totalPointsLostByBidder += basePointsOwedToEachRecipient;
            }
        });

        const numTotalPlayers = gameData.playerSocketIds.length;
        if (numTotalPlayers === 4 && gameData.dealer) {
            if (gameData.dealer !== bidWinnerName && !gameData.playerOrderActive.includes(gameData.dealer)) {
                gameData.scores[gameData.dealer] += basePointsOwedToEachRecipient;
                totalPointsLostByBidder += basePointsOwedToEachRecipient;
            }
        }
        gameData.scores[bidWinnerName] -= totalPointsLostByBidder;
        gamePointChangeForBidder = -totalPointsLostByBidder;
        roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLostByBidder} pts. Recipients gain ${basePointsOwedToEachRecipient} each.`;
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
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner}.`;
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints,
        defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo: awardedWidowInfo,
        bidMadeSuccessfully,
        gamePointChangeForBidder,
        gamePointChangePerRecipient,
        finalScores: { ...gameData.scores },
        isGameOver,
        gameWinner,
        message: roundMessage,
    };
    console.log("[SERVER SCORING] Populated roundSummary:", JSON.stringify(gameData.roundSummary, null, 2));

    gameData.state = "Scoring Phase";
    console.log(`[SERVER SCORING] Emitting gameState for Scoring Phase. Message: ${roundMessage}`);
    io.emit("gameState", gameData); // Crucial: Emit after roundSummary is fully populated

    if (!isGameOver) {
        console.log("[SERVER SCORING] Game not over. Scheduling next round preparation.");
        setTimeout(() => {
            prepareNextRound();
        }, 10000);
    } else {
        console.log("[SERVER SCORING] Game is OVER. No next round scheduled.");
    }
}

function prepareNextRound() {
    // ... (same as previous version)
    console.log("[SERVER] Preparing for next round.");
    const numTotalPlayers = gameData.playerSocketIds.length;

    if (numTotalPlayers < 3 || numTotalPlayers > 4) { 
        console.error("[SERVER NEXTROUND] Invalid number of players:", numTotalPlayers);
        gameData.state = "Error - Player Count Issue for Next Round";
        io.emit("gameState", gameData);
        return;
    }

    let currentDealerName = gameData.dealer;
    let currentDealerSocketId = gameData.playerSocketIds.find(id => gameData.players[id] === currentDealerName);
    
    if (!currentDealerSocketId && gameData.playerSocketIds.length > 0) { 
        console.warn("[SERVER NEXTROUND] Current dealer SID not found. Defaulting.");
        currentDealerSocketId = gameData.playerSocketIds[numTotalPlayers-1]; 
    } else if (!currentDealerSocketId) {
        console.error("[SERVER NEXTROUND] Cannot determine dealer for rotation, no players in socket IDs.");
        gameData.state = "Error - Cannot Rotate Dealer";
        io.emit("gameState", gameData);
        return;
    }
    let currentDealerIndexInTableOrder = gameData.playerSocketIds.indexOf(currentDealerSocketId);
    
    const nextDealerIndexInTableOrder = (currentDealerIndexInTableOrder + 1) % numTotalPlayers;
    gameData.dealer = gameData.players[gameData.playerSocketIds[nextDealerIndexInTableOrder]];

    gameData.playerOrderActive = [];
    if (numTotalPlayers === 4) { 
        for (let i = 1; i <= 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
            gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else if (numTotalPlayers === 3) { 
        for (let i = 1; i <= numTotalPlayers; i++) { 
            const activePlayerSocketId = gameData.playerSocketIds[(nextDealerIndexInTableOrder + i) % numTotalPlayers];
            gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    }
    
    initializeNewRoundState(); 
    gameData.state = "Dealing Pending";
    
    console.log(`[SERVER NEXTROUND] New round ready. Dealer: ${gameData.dealer}. Active: ${gameData.playerOrderActive.join(', ')}.`);
    io.emit("gameState", gameData);
}


  socket.on("resetGame", () => { 
    console.log("[SERVER RESETGAME] Full game reset requested.");
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });

  socket.on("disconnect", () => {
    // ... (same as previous version)
    const pName = gameData.players[socket.id];
    console.log(`[SERVER DISCONNECT] ${pName || socket.id} disconnected.`);
    if (pName) {
        delete gameData.players[socket.id];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== socket.id);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        
        if (gameData.gameStarted && Object.keys(gameData.players).length < 4) {
            console.log("[SERVER DISCONNECT] Game was in progress, not enough players. Resetting.");
            resetFullGameData();
        } else if (!gameData.gameStarted && gameData.state === "Ready to Start" && Object.keys(gameData.players).length < 4) {
            gameData.state = "Waiting for Players to Join";
        }
        
        if (Object.keys(gameData.players).length === 0 && gameData.gameStarted) {
            console.log("[SERVER DISCONNECT] Last player left. Resetting game data.");
            resetFullGameData(); 
        }
        io.emit("gameState", gameData);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});