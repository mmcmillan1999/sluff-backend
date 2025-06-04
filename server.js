// --- Backend/server.js ---
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors =require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "3.0.2 - Insurance Mechanic Foundation"; // SERVER VERSION
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
const BID_MULTIPLIERS = { "Frog": 1, "Solo": 2, "Heart Solo": 3 }; // For insurance default values and ranges
const PLACEHOLDER_ID = "ScoreAbsorber"; // Used in 3-player scoring for the "dummy"

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
        bidMultiplier: null, // Will store the multiplier of the winning bid
        bidderPlayerName: null,
        bidderRequirement: 0,
        defenderOffers: {}, // e.g., { defenderName1: offerValue1, defenderName2: offerValue2 }
        dealExecuted: false, // Will be true if an insurance deal is made
        executedDetails: null // Will store details of the executed deal
    };
}

// --- Initial Game Data Structure ---
let gameData = {
  state: "Waiting for Players to Join",
  players: {}, // socket.id: playerName
  playerSocketIds: [], // Array of socket.ids, order can be used for turns if shuffled
  playerOrderActive: [], // Array of playerNames who are active in the current round (always 3)
  dealer: null, // socket.id of the current dealer
  hands: {}, // playerName: [cards]
  widow: [],
  originalDealtWidow: [], // To remember widow for Solo/HeartSolo before any exchange
  widowDiscardsForFrogBidder: [], // Cards Frog bidder discards into the widow pile
  scores: {}, // playerName: score
  bidsThisRound: [], // [{playerId, playerName, bidType ("RegularBid"|"FrogUpgradeDecision"), bidValue}]
  currentHighestBidDetails: null, // {playerId, playerName, bid}
  biddingTurnPlayerName: null,
  bidsMadeCount: 0,
  originalFrogBidderId: null, // socket.id of player who initially bid Frog if Solo is later bid
  soloBidMadeAfterFrog: false, // Flag for Frog upgrade logic
  trumpSuit: null, // 'H', 'D', 'C', 'S'
  bidWinnerInfo: null, // {playerId, playerName, bid}
  gameStarted: false,
  currentTrickCards: [], // [{playerId, playerName, card}]
  trickTurnPlayerName: null,
  tricksPlayedCount: 0,
  leadSuitCurrentTrick: null,
  trumpBroken: false,
  trickLeaderName: null, // Player who won the last trick (and leads next, unless it's first trick)
  capturedTricks: {}, // playerName: [[cards_trick1], [cards_trick2], ...]
  roundSummary: null, // Object containing details of the completed round
  revealedWidowForFrog: [], // Widow cards shown to others during Frog exchange
  lastCompletedTrick: null, // { cards: [], winnerName: "", leadSuit: "", trickNumber: 0 }
  playersWhoPassedThisRound: [], // Array of playerNames who passed
  playerMode: null, // 3 or 4 (players in game)
  serverVersion: SERVER_VERSION,
  insurance: getInitialInsuranceState() // Insurance mechanic state
};
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initial gameData structure defined.`);

// --- Utility Functions ---
function getPlayerNameById(socketId) { return gameData.players[socketId]; }
function getSocketIdByName(playerName) {
    for (const id in gameData.players) {
        if (gameData.players[id] === playerName) return id;
    }
    return null;
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

// --- State Management Functions ---
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
    gameData.insurance = getInitialInsuranceState(); // Reset insurance state for the new round

    // Initialize capturedTricks for all active players (or all players if playerOrderActive isn't set yet)
    const playersToInitTricksFor = gameData.playerOrderActive.length > 0 ? gameData.playerOrderActive : Object.values(gameData.players);
    playersToInitTricksFor.forEach(pName => {
        if (pName && gameData.scores && gameData.scores[pName] !== undefined) { // Ensure player is valid and has a score entry
            gameData.capturedTricks[pName] = [];
        }
    });
    console.log(`[${SERVER_VERSION}] New round state initialized, insurance reset.`);
}

function resetFullGameData() {
    console.log(`[${SERVER_VERSION}] Performing full game data reset.`);
    const previousPlayers = {...gameData.players}; // For logging or potential re-invite logic

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
        serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState() // Reset insurance state on full game reset
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
        } else if (cardSuit === leadSuit) { // Only consider lead suit if not trumped
            if (!highestLeadSuitPlay || cardRankIndex > RANKS_ORDER.indexOf(getRank(highestLeadSuitPlay.card))) {
                highestLeadSuitPlay = play;
            }
        }
    }
    if (highestTrumpPlay) winningPlay = highestTrumpPlay;
    else if (highestLeadSuitPlay) winningPlay = highestLeadSuitPlay;
    // If neither (e.g., all off-suit cards, no trump), the first card of lead suit would win if logic was simpler,
    // but our logic implies highestLeadSuitPlay covers this. If trickCards is full, one must be lead suit.
    return winningPlay ? winningPlay.playerName : null;
}

function transitionToPlayingPhase() {
    gameData.state = "Playing Phase";
    gameData.tricksPlayedCount = 0;
    gameData.trumpBroken = false; // Trump is not broken at the start of play
    gameData.currentTrickCards = [];
    gameData.leadSuitCurrentTrick = null;
    gameData.lastCompletedTrick = null; // Clear last completed trick

    if (gameData.bidWinnerInfo && gameData.bidWinnerInfo.playerName && gameData.bidWinnerInfo.bid) {
        gameData.trickLeaderName = gameData.bidWinnerInfo.playerName; // Bid winner leads the first trick
        gameData.trickTurnPlayerName = gameData.bidWinnerInfo.playerName;

        // --- Initialize Insurance Mechanic Data ---
        // This is the correct timing: after bid is won, and any pre-play phases (Frog exchange, Trump selection) are done.
        const bidWinnerName = gameData.bidWinnerInfo.playerName;
        const bidType = gameData.bidWinnerInfo.bid;
        const currentBidMultiplier = BID_MULTIPLIERS[bidType];

        if (currentBidMultiplier && gameData.playerOrderActive.length === 3) { // Insurance is relevant for 3 active players
            gameData.insurance.isActive = true;
            gameData.insurance.bidMultiplier = currentBidMultiplier; // Store for validation later
            gameData.insurance.bidderPlayerName = bidWinnerName;
            gameData.insurance.bidderRequirement = 120 * currentBidMultiplier; // Default requirement
            gameData.insurance.defenderOffers = {};
            gameData.insurance.dealExecuted = false;
            gameData.insurance.executedDetails = null;

            const defenders = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
            if (defenders.length === 2) { // Should always be 2 defenders in a 3-active-player setup
                defenders.forEach(defName => {
                    gameData.insurance.defenderOffers[defName] = -60 * currentBidMultiplier; // Default offer
                });
                console.log(`[${SERVER_VERSION} INSURANCE] Insurance mechanic activated. Bidder: ${bidWinnerName}, BidType: ${bidType}, Multiplier: ${currentBidMultiplier}, Req: ${gameData.insurance.bidderRequirement}, Defenders: ${JSON.stringify(gameData.insurance.defenderOffers)}`);
            } else {
                 console.warn(`[${SERVER_VERSION} INSURANCE WARN] Expected 2 defenders for insurance, found ${defenders.length}. Insurance not fully initialized for defenders.`);
                 gameData.insurance.isActive = false; // Safety: Deactivate if defender setup is wrong
            }
        } else {
            console.log(`[${SERVER_VERSION} INSURANCE] Insurance mechanic not activated (no valid multiplier or incorrect player count for insurance). BidType: ${bidType}, Multiplier: ${currentBidMultiplier}, Active Players: ${gameData.playerOrderActive.length}`);
            gameData.insurance = getInitialInsuranceState(); // Ensure it's reset if not activated
        }
        // --- End of Insurance Initialization ---

    } else {
        console.error(`[${SERVER_VERSION} ERROR] Cannot transition to playing phase: bidWinnerInfo, playerName, or bid not set.`);
        gameData.state = "Error - Bid Winner Not Set for Play";
        gameData.insurance = getInitialInsuranceState(); // Ensure insurance is reset on error
        io.emit("gameState", gameData); return;
    }
    console.log(`[${SERVER_VERSION}] Transitioning to Playing Phase. Bid Winner: ${gameData.bidWinnerInfo.playerName}, Trump: ${SUITS[gameData.trumpSuit] || 'N/A'}`);
    io.emit("gameState", gameData);
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Helper and state functions defined.`);

// --- Socket.IO Connection Handling ---
io.on("connection", (socket) => {
  console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData); // Send current game state to newly connected client

  socket.on("submitName", (name) => {
    if (gameData.players[socket.id] === name) { // Player might be reconnecting with same name
        socket.emit("playerJoined", { playerId: socket.id, name }); // Confirm join
        io.emit("gameState", gameData); return;
    }
    if (Object.values(gameData.players).includes(name)) {
        return socket.emit("error", "Name already taken.");
    }
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) { // Room full for new players
        return socket.emit("error", "Room full (max 4 players).");
    }
    if (gameData.gameStarted && !gameData.players[socket.id]) { // Game in progress, no new joins
        return socket.emit("error", "Game in progress. Cannot join now.");
    }

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) {
        gameData.playerSocketIds.push(socket.id);
    }
    if(gameData.scores[name] === undefined) gameData.scores[name] = 120; // Initialize score if new player
    socket.emit("playerJoined", { playerId: socket.id, name }); // Acknowledge to sender

    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted) { // Update game state based on player count if game hasn't started
        if (numPlayers === 4) {
            gameData.state = "Ready to Start 4P";
        } else if (numPlayers === 3) {
            gameData.state = "Ready to Start 3P or Wait";
        } else {
            gameData.state = "Waiting for Players to Join";
        }
    }
    io.emit("gameState", gameData); // Broadcast updated state
  });

  socket.on("startGame", () => { // For 4-player game start
    if (Object.keys(gameData.players).length !== 4) return socket.emit("error", "Need exactly 4 players to start a 4-player game.");
    if (gameData.gameStarted) return socket.emit("error", "Game already in progress.");

    console.log(`[${SERVER_VERSION}] Attempting to start 4-PLAYER game.`);
    gameData.playerMode = 4;
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]); // Shuffle for random dealer/order
    gameData.dealer = gameData.playerSocketIds[0]; // First player in shuffled list is dealer

    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    for (let i = 1; i <= 3; i++) { // The 3 players after the dealer are active
        const activePlayerSocketId = gameData.playerSocketIds[(dealerIndex + i) % 4];
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }

    initializeNewRoundState(); // Prepare for the first round
    gameData.state = "Dealing Pending"; // Dealer needs to deal
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
    gameData.dealer = gameData.playerSocketIds[0]; // This player "deals" but all 3 are active in play

    gameData.playerOrderActive = [];
    const dealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);
    // In 3-player mode, all 3 players are active. The order starts "left" of the dealer.
    for (let i = 0; i < 3; i++) {
        const activePlayerSocketId = gameData.playerSocketIds[(dealerIndex + i + 1) % 3]; // Order: P1 (left of D), P2, P3 (Dealer)
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }
    // Ensure scores object for the dummy player in 3P if it's used for scoring.
    if (gameData.scores[PLACEHOLDER_ID] === undefined) gameData.scores[PLACEHOLDER_ID] = 120;

    initializeNewRoundState();
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] 3-PLAYER game started. Conceptual Dealer (deals): ${getPlayerNameById(gameData.dealer)}. All 3 players active: ${gameData.playerOrderActive.join(', ')}. ${PLACEHOLDER_ID} score initialized.`);
    io.emit("gameState", gameData);
  });

  socket.on("dealCards", () => {
    if (gameData.state !== "Dealing Pending" || !gameData.dealer || socket.id !== gameData.dealer) return socket.emit("error", "Not dealer or not dealing phase.");
    if (!gameData.playerOrderActive || gameData.playerOrderActive.length !== 3) {
        console.error(`[${SERVER_VERSION} DEAL ERROR] Active player setup error. Expected 3 active players. Found: ${gameData.playerOrderActive.length}. Active: ${gameData.playerOrderActive.join(', ')}`);
        return socket.emit("error", "Internal error: Active player setup incorrect for dealing.");
    }

    const shuffledDeck = shuffle([...deck]);
    gameData.playerOrderActive.forEach((activePName, i) => {
        if (activePName) gameData.hands[activePName] = shuffledDeck.slice(i * 11, (i + 1) * 11);
    });
    const cardsDealtToPlayers = 11 * gameData.playerOrderActive.length; // Should be 33
    gameData.widow = shuffledDeck.slice(cardsDealtToPlayers, cardsDealtToPlayers + 3); // Last 3 cards to widow
    gameData.originalDealtWidow = [...gameData.widow]; // Store a copy

    gameData.state = "Bidding Phase";
    gameData.bidsMadeCount = 0; gameData.bidsThisRound = []; gameData.currentHighestBidDetails = null;
    gameData.biddingTurnPlayerName = gameData.playerOrderActive[0]; // First player in active order bids
    gameData.roundSummary = null; // Clear previous round summary
    gameData.lastCompletedTrick = null; // Clear last trick from previous round
    gameData.playersWhoPassedThisRound = [];
    gameData.insurance = getInitialInsuranceState(); // Ensure insurance is reset before bidding starts
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
        if (alreadyUpgraded) { resolveBiddingFinal(); return; } // Already made decision or upgraded

        gameData.state = "Awaiting Frog Upgrade Decision";
        gameData.biddingTurnPlayerName = getPlayerNameById(gameData.originalFrogBidderId);
        io.to(gameData.originalFrogBidderId).emit("promptFrogUpgrade"); // Prompt only the original Frog bidder
        io.emit("gameState", gameData); return; // Wait for their decision
    }
    resolveBiddingFinal(); // No upgrade scenario, or decision already made
  }

  function resolveBiddingFinal() {
    if (!gameData.currentHighestBidDetails) { // All players passed
        gameData.state = "Round Skipped"; gameData.revealedWidowForFrog = [];
        gameData.lastCompletedTrick = null;
        gameData.insurance = getInitialInsuranceState(); // Reset insurance if round skipped
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
        gameData.trumpSuit = "H"; // Frog is always Hearts
        gameData.state = "FrogBidderConfirmWidow"; // Bidder must confirm taking widow
        io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogBidderConfirmWidow");
      } else { // Solo or Heart Solo
        gameData.revealedWidowForFrog = []; // No widow reveal for these bids before play
        if (gameData.bidWinnerInfo.bid === "Heart Solo") {
            gameData.trumpSuit = "H"; // Heart Solo is always Hearts
            transitionToPlayingPhase(); // Straight to play, insurance will be init here
        }
        else if (gameData.bidWinnerInfo.bid === "Solo") {
            gameData.state = "Trump Selection"; // Bidder chooses trump
            io.to(gameData.bidWinnerInfo.playerId).emit("promptChooseTrump");
        }
        else { // Should not happen if BID_HIERARCHY is correct
            console.error(`[${SERVER_VERSION} ERROR] Invalid bid outcome in resolveBiddingFinal: ${gameData.bidWinnerInfo.bid}`);
            gameData.state = "Error - Invalid Bid Outcome";
            gameData.insurance = getInitialInsuranceState(); // Reset on error
        }
      }
    }
    gameData.originalFrogBidderId = null; gameData.soloBidMadeAfterFrog = false; // Reset flags for next round
    io.emit("gameState", gameData);
  }

  socket.on("placeBid", ({ bid }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found.");

    // Handle Frog Upgrade Decision
    if (gameData.state === "Awaiting Frog Upgrade Decision") {
        if (socket.id !== gameData.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) {
            return socket.emit("error", "Invalid frog upgrade bid/pass. Only original Frog bidder can upgrade to Heart Solo or Pass.");
        }
        gameData.bidsThisRound.push({ playerId: socket.id, playerName: pName, bidType: "FrogUpgradeDecision", bidValue: bid });
        if (bid === "Heart Solo") { // Frog bidder chose to upgrade
            gameData.currentHighestBidDetails = { playerId: socket.id, playerName: pName, bid: "Heart Solo" };
        }
        // If Pass, currentHighestBidDetails remains the Solo bid by the other player.
        gameData.biddingTurnPlayerName = null; // Decision made
        resolveBiddingFinal(); // Finalize bidding based on this decision
        return;
    }

    // Handle Regular Bidding
    if (gameData.state !== "Bidding Phase") return socket.emit("error", "Not in Bidding Phase.");
    if (pName !== gameData.biddingTurnPlayerName) return socket.emit("error", "Not your turn to bid.");
    if (!BID_HIERARCHY.includes(bid)) return socket.emit("error", "Invalid bid type.");

    if (gameData.playersWhoPassedThisRound.includes(pName)) { // Should not happen if UI is correct
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
          // If this is the first Frog bid, or the original Frog bidder is making another Frog bid (e.g. after others passed)
          if(!gameData.originalFrogBidderId) gameData.originalFrogBidderId = socket.id;
      } else if (gameData.originalFrogBidderId && bid === "Solo" && socket.id !== gameData.originalFrogBidderId) {
          // A Solo bid was made by someone else after an initial Frog bid
          gameData.soloBidMadeAfterFrog = true;
      }
    } else { // Player passed
        if (!gameData.playersWhoPassedThisRound.includes(pName)) {
            gameData.playersWhoPassedThisRound.push(pName);
        }
    }

    // Determine if bidding ends or continues
    const activeBiddersRemaining = gameData.playerOrderActive.filter(playerName => !gameData.playersWhoPassedThisRound.includes(playerName));
    let endBidding = false;
    if (activeBiddersRemaining.length === 0) { // All remaining players passed
        endBidding = true;
    } else if (activeBiddersRemaining.length === 1 && gameData.currentHighestBidDetails && activeBiddersRemaining[0] === gameData.currentHighestBidDetails.playerName) {
        // Only one active bidder left, and they hold the highest bid
        endBidding = true;
    } else if (gameData.playersWhoPassedThisRound.length === gameData.playerOrderActive.length) {
        // All players have passed (even if no bid was made, covered by initial check for currentHighestBidDetails in resolve)
        endBidding = true;
    }

    // A more robust check: if a bid is on the table, and all other active players have passed since that bid.
    if (!endBidding && gameData.currentHighestBidDetails) {
        const highestBidderName = gameData.currentHighestBidDetails.playerName;
        // Check if all *other* active players have passed
        const otherActivePlayers = gameData.playerOrderActive.filter(player => player !== highestBidderName);
        const allOthersPassed = otherActivePlayers.every(player => gameData.playersWhoPassedThisRound.includes(player));
        if (allOthersPassed) {
            endBidding = true;
        }
    }


    if (endBidding) {
        gameData.biddingTurnPlayerName = null; // Bidding concluded
        checkForFrogUpgrade(); // Check if the Frog upgrade scenario applies
    } else { // Find next bidder
        let currentBidderIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
        let nextBidderName = null;
        for (let i = 1; i < gameData.playerOrderActive.length; i++) { // Check next players in order
            let nextIndex = (currentBidderIndexInActiveOrder + i) % gameData.playerOrderActive.length;
            let potentialNextBidder = gameData.playerOrderActive[nextIndex];
            if (!gameData.playersWhoPassedThisRound.includes(potentialNextBidder)) {
                nextBidderName = potentialNextBidder;
                break;
            }
        }
        if (nextBidderName) {
            gameData.biddingTurnPlayerName = nextBidderName;
        } else { // Should be covered by endBidding logic, but as a fallback
            console.log(`[${SERVER_VERSION} PLACEBID WARN] Fallback: No eligible next bidder found, but endBidding was false. Checking frog upgrade.`);
            gameData.biddingTurnPlayerName = null;
            checkForFrogUpgrade();
            return; // Exit to prevent emitting gameState if checkForFrogUpgrade handles it
        }
        io.emit("gameState", gameData);
    }
  });

  socket.on("frogBidderConfirmsWidowTake", () => {
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog" || gameData.state !== "FrogBidderConfirmWidow") {
        return socket.emit("error", "Not authorized or wrong phase for Frog widow confirmation.");
    }
    gameData.state = "Frog Widow Exchange";
    gameData.revealedWidowForFrog = [...gameData.originalDealtWidow]; // Reveal widow to all
    io.to(gameData.bidWinnerInfo.playerId).emit("promptFrogWidowExchange", { widow: [...gameData.originalDealtWidow] }); // Send widow to bidder for exchange
    io.emit("gameState", gameData); // Update all players
  });

  socket.on("submitFrogDiscards", ({ discards }) => {
    const pName = getPlayerNameById(socket.id);
    if (!gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId || gameData.bidWinnerInfo.bid !== "Frog" || gameData.state !== "Frog Widow Exchange") {
        return socket.emit("error", "Not authorized or wrong phase for Frog discards.");
    }
    if (!Array.isArray(discards) || discards.length !== 3) {
        return socket.emit("error", "Must discard exactly 3 cards for Frog bid.");
    }

    let originalPlayerHand = gameData.hands[pName] || [];
    let combinedForValidation = [...originalPlayerHand, ...gameData.originalDealtWidow]; // Bidder has widow in hand conceptually
    let tempCombinedCheck = [...combinedForValidation]; // Use a copy for validation splicing

    const allDiscardsValid = discards.every(dCard => {
        const indexInCombined = tempCombinedCheck.indexOf(dCard);
        if (indexInCombined > -1) {
            tempCombinedCheck.splice(indexInCombined, 1); // Remove to ensure unique cards if duplicates exist
            return true;
        }
        return false;
    });

    if (!allDiscardsValid) {
        return socket.emit("error", "Invalid discards. Cards not found in combined hand and widow, or duplicate discards sent for unique cards.");
    }

    let finalHandAfterExchange = combinedForValidation.filter(card => !discards.includes(card));
    gameData.hands[pName] = finalHandAfterExchange.sort(); // Update bidder's hand
    gameData.widowDiscardsForFrogBidder = [...discards].sort(); // These are the "new" widow cards, won by bidder
    gameData.widow = [...discards].sort(); // Update main widow reference
    gameData.revealedWidowForFrog = []; // Hide widow again after exchange

    console.log(`[${SERVER_VERSION}] Player ${pName} (Frog Bidder) discarded: ${discards.join(', ')}. New hand size: ${gameData.hands[pName].length}`);
    transitionToPlayingPhase(); // Insurance will be initialized here
  });

  socket.on("chooseTrump", (suitKey) => {
    if (gameData.state !== "Trump Selection" || !gameData.bidWinnerInfo || socket.id !== gameData.bidWinnerInfo.playerId) {
        return socket.emit("error", "Not authorized or wrong phase for trump selection.");
    }
    if (!["D", "S", "C"].includes(suitKey)) { // Hearts ("H") cannot be chosen for a "Solo" bid
        return socket.emit("error", "Invalid trump for Solo (must be Diamonds, Spades, or Clubs).");
    }
    gameData.trumpSuit = suitKey;
    console.log(`[${SERVER_VERSION}] Trump chosen for Solo: ${SUITS[suitKey]} by ${getPlayerNameById(gameData.bidWinnerInfo.playerId)}`);
    transitionToPlayingPhase(); // Insurance will be initialized here
  });

  socket.on("playCard", ({ card }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName || gameData.state !== "Playing Phase" || pName !== gameData.trickTurnPlayerName) {
        return socket.emit("error", "Invalid play action: Not your turn or not in playing phase.");
    }
    // Insurance: Play continues even if insurance is active/values are being set.
    // If a deal *executes*, that's a future consideration for how play might be affected.

    const hand = gameData.hands[pName];
    if (!hand || !hand.includes(card)) return socket.emit("error", "Card not in hand.");

    // Validate play based on game rules (follow suit, trump, etc.)
    const isLeading = gameData.currentTrickCards.length === 0;
    const playedSuit = getSuit(card);
    if (isLeading) { // Player is leading the trick
        const isHandAllTrump = hand.every(c => getSuit(c) === gameData.trumpSuit);
        if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken && !isHandAllTrump) {
            // Cannot lead trump if not broken, unless hand is all trump cards.
            return socket.emit("error", "Cannot lead trump if it's not broken (unless your hand is all trump).");
        }
    } else { // Player is following
        const leadCardSuit = gameData.leadSuitCurrentTrick;
        const hasLeadSuit = hand.some(c => getSuit(c) === leadCardSuit);
        const hasTrumpSuit = hand.some(c => getSuit(c) === gameData.trumpSuit);

        if (playedSuit !== leadCardSuit && hasLeadSuit) { // Must follow suit if possible
            return socket.emit("error", `Must follow ${SUITS[leadCardSuit]}.`);
        }
        // If cannot follow suit, and has trump, but plays a different off-suit card (renege if has trump)
        if (playedSuit !== leadCardSuit && !hasLeadSuit && playedSuit !== gameData.trumpSuit && hasTrumpSuit) {
             return socket.emit("error", `Void in lead suit (${SUITS[leadCardSuit]}), must play trump if available.`);
        }
    }

    // Play is valid, update game state
    gameData.hands[pName] = hand.filter(c => c !== card); // Remove card from hand
    gameData.currentTrickCards.push({ playerId: socket.id, playerName: pName, card });
    if (isLeading) gameData.leadSuitCurrentTrick = playedSuit;
    if (playedSuit === gameData.trumpSuit && !gameData.trumpBroken) gameData.trumpBroken = true;

    const expectedCardsInTrick = gameData.playerOrderActive.length; // Should be 3

    if (gameData.currentTrickCards.length === expectedCardsInTrick) { // Trick is complete
      const winnerNameOfTrick = determineTrickWinner(gameData.currentTrickCards, gameData.leadSuitCurrentTrick, gameData.trumpSuit);
      const currentTrickNumber = gameData.tricksPlayedCount + 1;

      if (winnerNameOfTrick && gameData.capturedTricks[winnerNameOfTrick]) {
          gameData.capturedTricks[winnerNameOfTrick].push([...gameData.currentTrickCards.map(p => p.card)]);
      } else if (winnerNameOfTrick) { // Should not happen if capturedTricks is initialized
          console.warn(`[${SERVER_VERSION} WARN] capturedTricks not initialized for trick winner: ${winnerNameOfTrick}. Initializing now.`);
          gameData.capturedTricks[winnerNameOfTrick] = [[...gameData.currentTrickCards.map(p => p.card)]];
      } else {
          console.error(`[${SERVER_VERSION} ERROR] No winner determined for a full trick. Cards: ${gameData.currentTrickCards.map(c=>c.card).join(',')}, Lead: ${gameData.leadSuitCurrentTrick}, Trump: ${gameData.trumpSuit}`);
      }

      gameData.lastCompletedTrick = {
          cards: [...gameData.currentTrickCards],
          winnerName: winnerNameOfTrick,
          leadSuit: gameData.leadSuitCurrentTrick,
          trickNumber: currentTrickNumber
      };
      gameData.tricksPlayedCount++;
      gameData.trickLeaderName = winnerNameOfTrick; // Winner for record, next leader set after linger

      if (gameData.tricksPlayedCount === 11) { // Last trick of the round
        // If insurance was active and no deal was made by this point, it's considered "closed" without execution.
        if(gameData.insurance.isActive && !gameData.insurance.dealExecuted) {
            console.log(`[${SERVER_VERSION} INSURANCE] Insurance was active but no deal was made by end of round ${currentTrickNumber}.`);
            // gameData.insurance.isActive will be reset in calculateRoundScores or initializeNewRound
        }
        calculateRoundScores(); // Proceed to scoring
      } else { // Not the last trick, implement linger
        gameData.state = "TrickCompleteLinger";
        console.log(`[${SERVER_VERSION}] Trick ${currentTrickNumber} complete. Winner: ${winnerNameOfTrick}. Lingering for 2s.`);
        io.emit("gameState", gameData); // Emit state with currentTrickCards still populated for display

        setTimeout(() => {
            if (gameData.gameStarted && gameData.state === "TrickCompleteLinger" &&
                gameData.lastCompletedTrick && gameData.lastCompletedTrick.trickNumber === currentTrickNumber) {

                console.log(`[${SERVER_VERSION}] Linger timeout for trick ${currentTrickNumber}. Clearing trick and setting next turn.`);
                gameData.currentTrickCards = [];
                gameData.leadSuitCurrentTrick = null;
                gameData.trickTurnPlayerName = winnerNameOfTrick; // Winner of the trick leads next
                gameData.state = "Playing Phase";
                io.emit("gameState", gameData);
            } else {
                 console.log(`[${SERVER_VERSION} LINGER TIMEOUT] Game state changed or reset during linger for trick ${currentTrickNumber}. Aborting clear. Current state: ${gameData.state}, Expected trick no: ${currentTrickNumber}, Actual last trick no: ${gameData.lastCompletedTrick?.trickNumber}`);
            }
        }, 2000); // 2-second linger
      }
    } else { // Trick not yet full, advance turn
      const currentTurnPlayerIndexInActiveOrder = gameData.playerOrderActive.indexOf(pName);
      if (currentTurnPlayerIndexInActiveOrder === -1) { // Should not happen
          console.error(`[${SERVER_VERSION} ERROR PLAYCARD] Current turn player ${pName} not found in active order: ${gameData.playerOrderActive.join(', ')}. Resetting game.`);
          resetFullGameData();
          io.emit("gameState", gameData); // Notify clients of reset
          return;
      }
      gameData.trickTurnPlayerName = gameData.playerOrderActive[(currentTurnPlayerIndexInActiveOrder + 1) % expectedCardsInTrick];
      io.emit("gameState", gameData);
    }
  });

  socket.on("updateInsuranceSetting", ({ settingType, value }) => {
    const pName = getPlayerNameById(socket.id);
    if (!pName) return socket.emit("error", "Player not found for insurance update.");

    if (!gameData.insurance.isActive) {
        return socket.emit("error", "Insurance is not currently active.");
    }
    if (gameData.insurance.dealExecuted) {
        return socket.emit("error", "An insurance deal has already been executed this round.");
    }

    const currentBidMultiplier = gameData.insurance.bidMultiplier;
    if (!currentBidMultiplier) { // Should be set if insurance.isActive is true
        console.error(`[${SERVER_VERSION} INSURANCE ERROR] Bid multiplier missing in active insurance state for player ${pName}. This indicates an initialization error.`);
        return socket.emit("error", "Internal server error: Insurance configuration missing (no multiplier).");
    }

    let updated = false;
    const parsedValue = parseInt(value, 10); // Ensure value is treated as a number

    if (isNaN(parsedValue)) {
        return socket.emit("error", "Invalid value for insurance setting. Must be a whole number.");
    }

    if (settingType === 'bidderRequirement') {
        if (pName !== gameData.insurance.bidderPlayerName) {
            return socket.emit("error", "Only the bid winner can update the concession requirement.");
        }
        const minReq = -120 * currentBidMultiplier;
        const maxReq = 120 * currentBidMultiplier;
        if (parsedValue < minReq || parsedValue > maxReq) {
            return socket.emit("error", `Requirement value ${parsedValue} is out of the allowed range [${minReq}, ${maxReq}].`);
        }
        gameData.insurance.bidderRequirement = parsedValue;
        updated = true;
        console.log(`[${SERVER_VERSION} INSURANCE] Bidder ${pName} updated requirement to: ${parsedValue}`);
    } else if (settingType === 'defenderOffer') {
        if (!gameData.insurance.defenderOffers.hasOwnProperty(pName)) {
            return socket.emit("error", "You are not a listed defender for this insurance bid or your offer cannot be set.");
        }
        const minOffer = -60 * currentBidMultiplier;
        const maxOffer = 60 * currentBidMultiplier;
        if (parsedValue < minOffer || parsedValue > maxOffer) {
            return socket.emit("error", `Offer value ${parsedValue} is out of the allowed range [${minOffer}, ${maxOffer}].`);
        }
        gameData.insurance.defenderOffers[pName] = parsedValue;
        updated = true;
        console.log(`[${SERVER_VERSION} INSURANCE] Defender ${pName} updated offer to: ${parsedValue}`);
    } else {
        return socket.emit("error", "Invalid insurance setting type specified.");
    }

    if (updated) {
        // IMPORTANT: Logic to check if the gap has closed and to execute the deal
        // (including point exchange and setting dealExecuted = true)
        // is NOT part of this task and will be added in a future update.
        // For now, we just broadcast the updated gameState.
        console.log(`[${SERVER_VERSION} INSURANCE] State after update: ${JSON.stringify(gameData.insurance)}`);
        io.emit("gameState", gameData);
    }
  });


  function calculateRoundScores() {
    // Future: If gameData.insurance.dealExecuted is true, scoring here should reflect the agreed insurance points,
    // and card points might only be for show or a secondary outcome.
    // For THIS task, we assume if insurance deal is NOT executed, standard scoring applies.
    if (gameData.insurance.isActive && gameData.insurance.dealExecuted) {
        console.log(`[${SERVER_VERSION} SCORING] Insurance deal was executed. Points should have been exchanged already. Hand played out for record.`);
        // The actual point exchange for insurance would happen when the deal is made, not here.
        // This function might just formalize the round end.
        // For now, we'll assume if dealExecuted is true, the round summary needs to reflect that.
        // The actual game point exchange for insurance is NOT handled here yet.
    }

    // Ensure insurance is marked inactive for the next round's initialization.
    // It will be reset by initializeNewRoundState(), but good to be explicit if ending round.
    gameData.insurance.isActive = false;

    if (!gameData.bidWinnerInfo || gameData.tricksPlayedCount !== 11) {
        console.error(`[${SERVER_VERSION} SCORING ERROR] PreRequisites not met. BidWinner: ${!!gameData.bidWinnerInfo}, TricksPlayed: ${gameData.tricksPlayedCount}`);
        gameData.state = "Error - Scoring PreRequisite"; io.emit("gameState", gameData); return;
    }
    const bidWinnerName = gameData.bidWinnerInfo.playerName;
    const bidType = gameData.bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType]; // Standard bid multiplier for card points
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;
    let awardedWidowInfo = { cards: [], points: 0, awardedTo: null };

    // Calculate card points from widow based on bid type
    if (bidType === "Frog") { // Discarded widow cards go to Frog bidder
        awardedWidowInfo.cards = [...gameData.widowDiscardsForFrogBidder];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Solo") { // Original widow cards go to Solo bidder
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        bidderTotalCardPoints += awardedWidowInfo.points;
        awardedWidowInfo.awardedTo = bidWinnerName;
    } else if (bidType === "Heart Solo") { // Original widow cards go to winner of the LAST trick
        awardedWidowInfo.cards = [...gameData.originalDealtWidow];
        awardedWidowInfo.points = calculateCardPoints(awardedWidowInfo.cards);
        // gameData.trickLeaderName at end of 11 tricks is winner of 11th trick
        if (gameData.trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = bidWinnerName;
        } else { // A defender won the last trick
            defendersTotalCardPoints += awardedWidowInfo.points;
            awardedWidowInfo.awardedTo = gameData.trickLeaderName;
        }
    }

    // Calculate card points from captured tricks
    gameData.playerOrderActive.forEach(activePlayerName => {
        const playerTrickPoints = (gameData.capturedTricks[activePlayerName] || []).reduce((sum, trick) => sum + calculateCardPoints(trick), 0);
        if (activePlayerName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });

    console.log(`[${SERVER_VERSION} SCORING] Bidder: ${bidWinnerName}, Bid: ${bidType}`);
    console.log(`[${SERVER_VERSION} SCORING] Card Pts (incl. widow) -> Bidder: ${bidderTotalCardPoints}, Defenders: ${defendersTotalCardPoints}`);
    if (bidderTotalCardPoints + defendersTotalCardPoints !== 120) {
        console.warn(`[${SERVER_VERSION} SCORING WARNING] Total card points in play (${bidderTotalCardPoints + defendersTotalCardPoints}) != 120! Widow awarded to: ${awardedWidowInfo.awardedTo}, Widow points: ${awardedWidowInfo.points}`);
    }

    // Standard game point exchange based on card points (if no insurance deal was made or if insurance doesn't override this)
    const targetPoints = 60;
    const scoreDifferenceFrom60 = bidderTotalCardPoints - targetPoints;
    const pointsDelta = Math.abs(scoreDifferenceFrom60);
    const exchangeValuePerPlayer = pointsDelta * currentBidMultiplier;

    let roundMessage = "";
    let bidMadeSuccessfully = bidderTotalCardPoints > targetPoints;
    let humanPlayerScoresBeforeExchange = {}; // Snapshot of scores before this round's changes
    gameData.playerSocketIds.forEach(id => {
        const playerName = gameData.players[id];
        if(playerName && gameData.scores[playerName] !== undefined) humanPlayerScoresBeforeExchange[playerName] = gameData.scores[playerName];
    });
    if(gameData.playerMode === 3 && gameData.scores[PLACEHOLDER_ID] !== undefined) {
        humanPlayerScoresBeforeExchange[PLACEHOLDER_ID] = gameData.scores[PLACEHOLDER_ID];
    }

    if (scoreDifferenceFrom60 === 0) { // Exactly 60 points
        bidMadeSuccessfully = false; // Technically not "made" if target is >60
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) scored exactly 60 card points. No game points exchanged for card play.`;
    } else if (bidderTotalCardPoints > targetPoints) { // Bidder succeeded
        bidMadeSuccessfully = true;
        let totalPointsGainedByBidder = 0;
        const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);

        activeOpponents.forEach(oppName => {
            gameData.scores[oppName] = (gameData.scores[oppName] || 0) - exchangeValuePerPlayer;
            totalPointsGainedByBidder += exchangeValuePerPlayer;
        });
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) + totalPointsGainedByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) succeeded with ${bidderTotalCardPoints} card points! Gains ${totalPointsGainedByBidder} game pts.`;
    } else { // Bidder failed
        bidMadeSuccessfully = false;
        let totalPointsLostByBidder = 0;
        const activeOpponents = gameData.playerOrderActive.filter(pName => pName !== bidWinnerName);
        activeOpponents.forEach(oppName => {
            gameData.scores[oppName] = (gameData.scores[oppName] || 0) + exchangeValuePerPlayer;
            totalPointsLostByBidder += exchangeValuePerPlayer;
        });

        // Inactive player (dealer in 4P, or placeholder in 3P) also gets points if bidder fails
        if (gameData.playerMode === 3) {
            gameData.scores[PLACEHOLDER_ID] = (gameData.scores[PLACEHOLDER_ID] || 0) + exchangeValuePerPlayer;
            totalPointsLostByBidder += exchangeValuePerPlayer;
            console.log(`[${SERVER_VERSION} SCORING] 3P Mode Failed Bid: ${PLACEHOLDER_ID} also gains ${exchangeValuePerPlayer}.`);
        } else if (gameData.playerMode === 4) {
            const dealerNameActual = getPlayerNameById(gameData.dealer);
            if (dealerNameActual && dealerNameActual !== bidWinnerName && !gameData.playerOrderActive.includes(dealerNameActual)) {
                gameData.scores[dealerNameActual] = (gameData.scores[dealerNameActual] || 0) + exchangeValuePerPlayer;
                totalPointsLostByBidder += exchangeValuePerPlayer;
                console.log(`[${SERVER_VERSION} SCORING] 4P Mode Failed Bid: Inactive Dealer ${dealerNameActual} also gains ${exchangeValuePerPlayer}.`);
            } else {
                 console.warn(`[${SERVER_VERSION} SCORING WARNING] 4P Mode Failed Bid: Could not identify distinct inactive dealer ${dealerNameActual} to pay, or dealer was bidder/active.`);
            }
        }
        gameData.scores[bidWinnerName] = (gameData.scores[bidWinnerName] || 0) - totalPointsLostByBidder;
        roundMessage = `${bidWinnerName} (Bid: ${bidType}) failed with ${bidderTotalCardPoints} card points. Loses ${totalPointsLostByBidder} game pts.`;
    }

    // Check for game over
    let isGameOver = false;
    let humanPlayersWithScores = []; // For determining winner
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
        humanPlayersWithScores.forEach(player => { // Find highest score among human players
            if (player.score > highestScore) {
                highestScore = player.score;
                contenders = [player.name];
            } else if (player.score === highestScore) {
                contenders.push(player.name);
            }
        });
        // If all are <=0, highest is least negative.
        if (contenders.length === 0 && humanPlayersWithScores.length > 0) { // Should not happen if highestScore starts at -Infinity
            highestScore = -Infinity; // Re-evaluate if needed, though logic should cover it
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
        roundMessage += ` GAME OVER! Winner(s): ${gameWinner || 'N/A'} with ${highestScore} points.`;
        gameData.state = "Game Over";
    }

    gameData.roundSummary = {
        bidWinnerName, bidType, trumpSuit: gameData.trumpSuit,
        bidderCardPoints: bidderTotalCardPoints, defenderCardPoints: defendersTotalCardPoints,
        awardedWidowInfo, bidMadeSuccessfully,
        scoresBeforeExchange: humanPlayerScoresBeforeExchange,
        finalScores: { ...gameData.scores }, // Current scores after exchange
        isGameOver, gameWinner, message: roundMessage,
        dealerOfRoundSocketId: gameData.dealer, // Socket ID of the dealer for this round
        insuranceDealWasMade: gameData.insurance.dealExecuted, // Include if an insurance deal happened
        insuranceDetails: gameData.insurance.dealExecuted ? gameData.insurance.executedDetails : null
    };

    console.log(`[${SERVER_VERSION} SCORING] Scores After Exchange:`, JSON.stringify(gameData.scores));
    // Score sum verification
    const totalExpectedScore = gameData.playerMode === 3 ? 120 * (gameData.playerSocketIds.length + 1) : 120 * gameData.playerSocketIds.length; // +1 for placeholder in 3P
    const actualTotalScore = Object.values(gameData.scores).reduce((sum, s) => sum + s, 0);
    if (actualTotalScore !== totalExpectedScore) {
        console.warn(`[${SERVER_VERSION} SCORING WARNING ${gameData.playerMode}P] Total game points (${actualTotalScore}) != ${totalExpectedScore}! Scores: ${JSON.stringify(gameData.scores)}`);
    }

    if (!isGameOver) gameData.state = "Awaiting Next Round Trigger";
    io.emit("gameState", gameData);
  }

  function prepareNextRound() {
    const numHumanPlayers = gameData.playerSocketIds.length;
    if (!gameData.playerMode || (gameData.playerMode === 3 && numHumanPlayers !== 3) || (gameData.playerMode === 4 && numHumanPlayers !== 4)) {
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Mismatch playerMode (${gameData.playerMode}) and humans (${numHumanPlayers}) or playerMode not set. Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }
    if (numHumanPlayers < 3) { // Should be caught by above, but as a safeguard
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Insufficient players (${numHumanPlayers}) for mode ${gameData.playerMode}. Resetting.`);
        resetFullGameData();
        io.emit("gameState", gameData); return;
    }

    let lastRoundDealerSocketId = gameData.roundSummary ? gameData.roundSummary.dealerOfRoundSocketId : gameData.dealer;
    if (!lastRoundDealerSocketId || !gameData.playerSocketIds.includes(lastRoundDealerSocketId)) {
        console.warn(`[${SERVER_VERSION} NEXT ROUND WARN] Last dealer ID (${lastRoundDealerSocketId}) invalid or not in current player list. Choosing new from existing players.`);
        if (gameData.playerSocketIds.length > 0) lastRoundDealerSocketId = gameData.playerSocketIds[0]; // Fallback
        else { gameData.state = "Error - Cannot Rotate Dealer (No Players)"; io.emit("gameState", gameData); return; }
    }

    let lastRoundDealerIndexInSockets = gameData.playerSocketIds.indexOf(lastRoundDealerSocketId);
    const nextDealerIndexInSockets = (lastRoundDealerIndexInSockets + 1) % numHumanPlayers;
    gameData.dealer = gameData.playerSocketIds[nextDealerIndexInSockets]; // Rotate dealer

    // Determine playerOrderActive for the new round
    gameData.playerOrderActive = [];
    const currentDealerIndex = gameData.playerSocketIds.indexOf(gameData.dealer);

    if (gameData.playerMode === 4) {
        for (let i = 1; i <= 3; i++) { // Next 3 players after new dealer
            const activePlayerSocketId = gameData.playerSocketIds[(currentDealerIndex + i) % numHumanPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else if (gameData.playerMode === 3) { // All 3 players are active, order relative to new dealer
        for (let i = 0; i < 3; i++) {
            const activePlayerSocketId = gameData.playerSocketIds[(currentDealerIndex + i + 1) % numHumanPlayers];
            if (gameData.players[activePlayerSocketId]) gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
        }
    } else { // Should not happen
        console.error(`[${SERVER_VERSION} NEXT ROUND ERROR] Invalid playerMode for playerOrderActive: ${gameData.playerMode}. Resetting.`);
        resetFullGameData(); io.emit("gameState", gameData); return;
    }

    if (gameData.playerOrderActive.length !== 3) {
        console.error(`[${SERVER_VERSION} NEXT ROUND CRITICAL ERROR] playerOrderActive not 3. Actual: ${gameData.playerOrderActive.length}. Mode: ${gameData.playerMode}. Players: ${gameData.playerSocketIds.map(id => getPlayerNameById(id)).join(',')}. Dealer: ${getPlayerNameById(gameData.dealer)}. Resetting.`);
        resetFullGameData(); io.emit("gameState", gameData); return;
    }

    initializeNewRoundState(); // This will reset game state variables including insurance
    gameData.state = "Dealing Pending";
    console.log(`[${SERVER_VERSION}] Next round prepared. Mode: ${gameData.playerMode}P. New Dealer: ${getPlayerNameById(gameData.dealer)}. Active: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  }

  socket.on("requestNextRound", () => {
    if (gameData.state === "Awaiting Next Round Trigger" && gameData.roundSummary && socket.id === gameData.roundSummary.dealerOfRoundSocketId) {
        prepareNextRound();
    } else {
        let reason = "Not correct state or not authorized.";
        if (gameData.state !== "Awaiting Next Round Trigger") reason = `Not 'Awaiting Next Round Trigger' state (current: ${gameData.state}).`;
        else if (!gameData.roundSummary) reason = "Round summary not available.";
        else if (gameData.roundSummary.dealerOfRoundSocketId && socket.id !== gameData.roundSummary.dealerOfRoundSocketId) reason = `Only dealer of last round (${getPlayerNameById(gameData.roundSummary.dealerOfRoundSocketId) || 'Unknown'}) can start. You: ${getPlayerNameById(socket.id)}.`;
        else if (!gameData.roundSummary.dealerOfRoundSocketId) reason = "Dealer of last round info missing in summary.";
        socket.emit("error", `Cannot start next round: ${reason}`);
    }
  });

  socket.on("resetGame", () => {
    console.log(`[${SERVER_VERSION}] 'resetGame' event received from ${getPlayerNameById(socket.id) || socket.id}. Performing full reset.`);
    resetFullGameData();
    io.emit("gameState", gameData); // Notify all clients of the reset
  });

  socket.on("requestBootAll", () => { // Admin action to reset everything
    const playerName = getPlayerNameById(socket.id) || "A player";
    console.log(`[${SERVER_VERSION} REQUESTBOOTALL] Received from ${playerName} (${socket.id}). Resetting game for all.`);
    resetFullGameData();
    io.emit("gameState", gameData);
  });

  socket.on("disconnect", (reason) => {
    const pName = getPlayerNameById(socket.id);
    const disconnectingSocketId = socket.id;
    console.log(`[${SERVER_VERSION} DISCONNECT] Player ${pName || 'Unknown'} (ID: ${disconnectingSocketId}) disconnected. Reason: ${reason}`);

    if (pName) { // If the disconnected socket was an actual player
        const wasDealer = gameData.dealer === disconnectingSocketId || (gameData.roundSummary && gameData.roundSummary.dealerOfRoundSocketId === disconnectingSocketId);
        let gameResetDueToDisconnect = false;

        // --- Handle Insurance Implications on Disconnect ---
        if (gameData.insurance.isActive && !gameData.insurance.dealExecuted) {
            if (gameData.insurance.bidderPlayerName === pName) {
                console.log(`[${SERVER_VERSION} INSURANCE DISCONNECT] Bidder ${pName} disconnected. Deactivating insurance for the round.`);
                gameData.insurance.isActive = false; // Deactivate insurance
                // Further game reset might occur below due to player count or turn.
            } else if (gameData.insurance.defenderOffers.hasOwnProperty(pName)) {
                console.log(`[${SERVER_VERSION} INSURANCE DISCONNECT] Defender ${pName} disconnected. Removing their offer: ${gameData.insurance.defenderOffers[pName]}.`);
                delete gameData.insurance.defenderOffers[pName]; // Remove defender's offer
                // The game continues, but this defender can no longer participate in the insurance deal.
            }
        }
        // --- End of Insurance Handling on Disconnect ---

        // Remove player from game structures
        delete gameData.players[disconnectingSocketId];
        // Note: Scores are kept unless a full reset. If player rejoins, they might get their score back.
        // For simplicity here, we are not deleting scores, but a full reset would.
        // If a game is active and a player drops, their score might become 0 or handled by rules.
        // For now, just removing from active lists.
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== disconnectingSocketId);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);

        const numHumanPlayers = gameData.playerSocketIds.length;

        if (gameData.gameStarted) { // If a game was in progress
            if (numHumanPlayers < 3) {
                console.log(`[${SERVER_VERSION} DISCONNECT] Player count (${numHumanPlayers}) fell below 3 during active game. Resetting game.`);
                resetFullGameData(); gameResetDueToDisconnect = true;
            } else if (gameData.playerMode === 4 && numHumanPlayers === 3) {
                // If 4P game drops to 3, current rules reset. Future could adapt.
                console.log(`[${SERVER_VERSION} DISCONNECT] 4-Player game lost a player, now 3 human players. Resetting (dynamic mode change not currently supported).`);
                resetFullGameData(); gameResetDueToDisconnect = true;
            } else if (wasDealer && gameData.state === "Awaiting Next Round Trigger" && !gameResetDueToDisconnect) {
                 console.log(`[${SERVER_VERSION} DISCONNECT] Dealer ${pName} disconnected in 'Awaiting Next Round Trigger'. Game may stall or await manual reset by another player if that's implemented.`);
                 // Game might need a new dealer to be chosen or a timeout to reset.
                 // For now, it will wait for "requestNextRound" from the *new* dealer if rotation logic can handle it.
            } else if ((gameData.biddingTurnPlayerName === pName || gameData.trickTurnPlayerName === pName) && !gameResetDueToDisconnect) {
                // If it was the disconnected player's turn
                console.log(`[${SERVER_VERSION} DISCONNECT] Active turn player ${pName} disconnected. Resetting game.`);
                resetFullGameData(); gameResetDueToDisconnect = true;
            } else if (gameData.insurance.bidderPlayerName === pName && gameData.insurance.isActive && !gameResetDueToDisconnect) {
                // Bidder disconnected, insurance was active, game didn't reset for other reasons.
                // Insurance already deactivated above. Game might continue if enough players and not bidder's turn.
                console.log(`[${SERVER_VERSION} DISCONNECT] Insurance Bidder ${pName} disconnected. Insurance deactivated. Game continues if possible.`);
            }
        } else { // Game not started, update waiting state
            if (numHumanPlayers === 4) gameData.state = "Ready to Start 4P"; // Should not happen if game not started and player leaves from 4
            else if (numHumanPlayers === 3) gameData.state = "Ready to Start 3P or Wait";
            else gameData.state = "Waiting for Players to Join";
        }
        io.emit("gameState", gameData); // Broadcast the updated state
    } else {
        console.log(`[${SERVER_VERSION} DISCONNECT] Unidentified socket (ID: ${disconnectingSocketId}) disconnected (was not a registered player).`);
    }
  });
});

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => { res.send(`Sluff Game Server (${SERVER_VERSION}) is Running!`); });
server.listen(PORT, () => { console.log(`Sluff Game Server (${SERVER_VERSION}) running on http://localhost:${PORT}`); });

