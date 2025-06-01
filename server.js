// --- Backend/server.js (INCREMENTAL BUILD - STEP 1) ---
require("dotenv").config(); // Added from full version
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

console.log("INCREMENTAL SERVER (Step 1): Initializing Socket.IO Server...");

const io = new Server(server, {
  cors: {
    // Changed to use env var like full version
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket'] // Keeping both, polling as a fallback
});

console.log("INCREMENTAL SERVER (Step 1): Socket.IO Server initialized.");

io.engine.on("connection_error", (err) => {
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("!!!! [SOCKET.IO ENGINE EVENT] Connection Error !!!!");
  console.error(`!!!!    Error Code: ${err.code}`);
  console.error(`!!!!    Error Message: ${err.message}`);
  if (err.context) {
    console.error(`!!!!    Error Context:`, err.context);
  }
  if (err.req) {
    console.error(`!!!!    Request Details: Method=${err.req.method}, URL=${err.req.url}, Origin=${err.req.headers?.origin}`);
  } else {
    console.error(`!!!!    Request object (err.req) was undefined for this engine error.`);
  }
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
});

// Added from full version
app.use(cors({ 
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*", 
    credentials: true 
}));
app.use(express.json()); // Added from full version

// Global constants from full version
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"]; 
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];
console.log("INCREMENTAL SERVER (Step 1): Global constants defined.");

// Initial gameData structure from full version (mostly empty/default)
let gameData = {
  state: "Waiting for Players to Join", // Initial state
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
console.log("INCREMENTAL SERVER (Step 1): Initial gameData structure defined.");

// Simple utility function from full version
function getPlayerNameById(socketId) {
    // This will be more useful once gameData.players is populated
    return gameData.players[socketId]; 
}

// Game reset functions (defined, but not yet fully integrated into complex game logic flows)
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
    // Ensure capturedTricks is initialized for any players that might exist in gameData.players
    // Though at this stage, gameData.players will be empty until submitName is integrated.
    Object.values(gameData.players).forEach(pName => {
        if(pName) gameData.capturedTricks[pName] = [];
    });
    gameData.roundSummary = null;
    console.log("[SERVER INCREMENTAL Step 1] New round state initialized (called by initializeNewRoundState).");
}

function resetFullGameData() {
    console.log("[SERVER INCREMENTAL Step 1] Performing full game data reset (called by resetFullGameData).");
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
    // After a full reset, initializeNewRoundState isn't strictly necessary as gameData is fresh,
    // but calling it ensures consistency if its logic evolves.
    // initializeNewRoundState(); // Optional: can be called if desired, but resetFullGameData redefines everything.
}
console.log("INCREMENTAL SERVER (Step 1): Game reset functions defined.");
// End of added game reset functions

app.get("/", (req, res) => {
  console.log(`[HTTP GET /] Request received for root path from ${req.ip}`);
  res.send("Incremental Sluff Socket.IO Backend (Step 1) is Running!");
});

io.on("connection", (socket) => {
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log("!!!! [SERVER INCREMENTAL (Step 1) CONNECT] NEW SOCKET.IO CONNECTION ESTABLISHED !!!!");
  console.log(`!!!!    Socket ID: ${socket.id}`);
  console.log(`!!!!    Transport: ${socket.conn.transport.name}`);
  console.log(`!!!!    Remote Address (from handshake): ${socket.handshake.address}`);
  console.log(`!!!!    Client IP (from X-Forwarded-For): ${socket.handshake.headers['x-forwarded-for'] || 'N/A'}`); // Useful if behind proxy
  console.log(`!!!!    Origin Header: ${socket.handshake.headers.origin}`);
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  // Emit current gameData (which is mostly initial/empty at this stage)
  // The client (App.js) expects 'gameState' to receive an object with a 'state' property (and others).
  socket.emit("gameState", gameData); 

  // Kept from simplified version for basic communication test
  socket.emit("messageFromServer", {
    greeting: "Hello from the Incremental Server (Step 1)!",
    socketId: socket.id
  });

  // Kept from simplified version for basic event roundtrip test
  socket.on("clientTestEvent", (data) => {
    console.log(`[SERVER INCREMENTAL (Step 1)] Received 'clientTestEvent' from ${socket.id} with data:`, data);
    socket.emit("serverTestResponse", {
      message: "Server (Step 1) received your test event!",
      originalData: data
    });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[SERVER INCREMENTAL (Step 1) DISCONNECT] Socket disconnected: ${socket.id}. Reason: ${reason}`);
    // Minimal disconnect logic for now - just log
    const pName = getPlayerNameById(socket.id); // Will likely be undefined at this step
    if (pName) {
        console.log(`Player ${pName} associated with ${socket.id} disconnected.`);
        // In later steps, we'll add the full disconnect logic that modifies gameData
    }
  });

  // Basic handler for resetGame to test the resetFullGameData function
  socket.on("resetGame", () => { 
    console.log("[SERVER INCREMENTAL (Step 1) RESETGAME] Full game reset requested by client. Calling resetFullGameData().");
    resetFullGameData(); // Call the function
    io.emit("gameState", gameData); // Emit the reset state to all clients
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incremental Backend Server (Step 1) running on http://localhost:${PORT}`);
  const clientOrigin = process.env.CLIENT_ORIGIN;
  console.log("CORS configured for origins: ", clientOrigin ? clientOrigin.split(",") : "*");
  console.log("Ensure your .env file is correctly loaded if using CLIENT_ORIGIN.");
});