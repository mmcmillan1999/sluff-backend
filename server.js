// --- Backend/server.js (INCREMENTAL BUILD - STEP 2 - Add gameData, constants, reset fns) ---
require("dotenv").config(); 
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

console.log("INCREMENTAL SERVER (Step 2): Initializing Socket.IO Server...");

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

console.log("INCREMENTAL SERVER (Step 2): Socket.IO Server initialized.");

io.engine.on("connection_error", (err) => {
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("!!!! [SOCKET.IO ENGINE EVENT] Connection Error !!!!");
  // ... (rest of engine error logging)
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
});

app.use(cors({ 
    origin: "*", 
    credentials: true 
}));
app.use(express.json()); 

// --- ADDED FROM FULL VERSION (like original problematic Step 1) ---
const SUITS = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const RANKS_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"]; 
const CARD_POINT_VALUES = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9":0, "8":0, "7":0, "6":0 };
const BID_HIERARCHY = ["Pass", "Frog", "Solo", "Heart Solo"];
console.log("INCREMENTAL SERVER (Step 2): Global constants defined.");

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
console.log("INCREMENTAL SERVER (Step 2): Initial gameData structure defined.");

function getPlayerNameById(socketId) {
    return gameData.players[socketId]; 
}

function initializeNewRoundState() {
    gameData.hands = {};
    gameData.widow = []; 
    // ... (rest of initializeNewRoundState from your full code, or my original Step 1 example)
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
    Object.values(gameData.players).forEach(pName => {
        if(pName) gameData.capturedTricks[pName] = [];
    });
    gameData.roundSummary = null;
    console.log("[SERVER INCREMENTAL Step 2] New round state initialized (called by initializeNewRoundState).");
}

function resetFullGameData() {
    console.log("[SERVER INCREMENTAL Step 2] Performing full game data reset (called by resetFullGameData).");
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
    // initializeNewRoundState(); // Optional here
}
console.log("INCREMENTAL SERVER (Step 2): Game reset functions defined.");
// --- END OF ADDED SECTIONS ---

app.get("/", (req, res) => {
  console.log(`[HTTP GET /] Request received for root path from ${req.ip}`);
  res.send("Incremental Sluff Socket.IO Backend (Step 2) is Running!");
});

io.on("connection", (socket) => {
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log("!!!! [SERVER INCREMENTAL (Step 2) CONNECT] NEW SOCKET.IO CONNECTION ESTABLISHED !!!!");
  console.log(`!!!!    Socket ID: ${socket.id}`);
  console.log(`!!!!    Transport: ${socket.conn.transport.name}`);
  // ... (rest of connection logs)
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  socket.emit("gameState", gameData); // Now emitting the actual gameData object

  socket.emit("messageFromServer", {
    greeting: "Hello from the Incremental Server (Step 2)!",
    socketId: socket.id
  });

  socket.on("clientTestEvent", (data) => {
    console.log(`[SERVER INCREMENTAL (Step 2)] Received 'clientTestEvent' from ${socket.id} with data:`, data);
    socket.emit("serverTestResponse", {
      message: "Server (Step 2) received your test event!",
      originalData: data
    });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[SERVER INCREMENTAL (Step 2) DISCONNECT] Socket disconnected: ${socket.id}. Reason: ${reason}`);
    // We'll add full disconnect logic later
  });

  socket.on("resetGame", () => { 
    console.log("[SERVER INCREMENTAL (Step 2) RESETGAME] Full game reset requested. Calling resetFullGameData().");
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incremental Backend Server (Step 2) running on http://localhost:${PORT}`);
  console.log("INCREMENTAL SERVER (Step 2) CORS origin is hardcoded to '*' ");
});