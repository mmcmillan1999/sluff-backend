// --- Backend/server.js (INCREMENTAL BUILD - STEP 3 - Add submitName and disconnect logic) ---
require("dotenv").config(); 
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

console.log("INCREMENTAL SERVER (Step 3): Initializing Socket.IO Server...");

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['polling', 'websocket']
});

console.log("INCREMENTAL SERVER (Step 3): Socket.IO Server initialized.");

io.engine.on("connection_error", (err) => {
  console.error("!!!! [SOCKET.IO ENGINE EVENT] Connection Error !!!!");
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
console.log("INCREMENTAL SERVER (Step 3): Global constants defined.");

let gameData = {
  state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
  playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
  widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null, 
  biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
  trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [], 
  trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, 
  trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
};
console.log("INCREMENTAL SERVER (Step 3): Initial gameData structure defined.");

function getPlayerNameById(socketId) {
    return gameData.players[socketId]; 
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
    Object.values(gameData.players).forEach(pName => {
        if(pName) gameData.capturedTricks[pName] = [];
    });
    gameData.roundSummary = null;
    console.log("[SERVER INCREMENTAL Step 3] New round state initialized.");
}

function resetFullGameData() {
    console.log("[SERVER INCREMENTAL Step 3] Performing full game data reset.");
    gameData = {
        state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
        playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
        widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null,
        biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null,
        trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null
    };
}
console.log("INCREMENTAL SERVER (Step 3): Game reset functions defined.");

app.get("/", (req, res) => {
  res.send("Incremental Sluff Socket.IO Backend (Step 3) is Running!");
});

io.on("connection", (socket) => {
  console.log(`!!!! [SERVER INCREMENTAL (Step 3) CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData); 

  socket.emit("messageFromServer", { // Kept for basic hello
    greeting: "Hello from Server (Step 3)!", socketId: socket.id
  });

  socket.on("clientTestEvent", (data) => { // Kept for testing emits
    console.log(`[SERVER (Step 3) clientTestEvent] from ${socket.id}:`, data);
    socket.emit("serverTestResponse", { message: "Server (Step 3) got test!", originalData: data });
  });

  // --- ADDED: submitName from full game logic ---
  socket.on("submitName", (name) => {
    console.log(`[SERVER (Step 3) SUBMITNAME] ID: ${socket.id} Name: "${name}". Players: ${Object.keys(gameData.players).length}, Started: ${gameData.gameStarted}`);
    if (gameData.players[socket.id] === name) { // Player already submitted this name
        socket.emit("playerJoined", { playerId: socket.id, name }); 
        io.emit("gameState", gameData); // Send current state
        return;
    }
    if (Object.values(gameData.players).includes(name)) {
        return socket.emit("error", "Name already taken.");
    }
    // For now, let's simplify the 4-player limit check for easier testing of 1-2 players.
    // We'll add the full player limit logic back later.
    // if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) {
    //     return socket.emit("error", "Room full.");
    // }
    // if (gameData.gameStarted && !gameData.players[socket.id] && Object.keys(gameData.players).length >=4) {
    //     return socket.emit("error", "Game in progress and full.");
    // }

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) {
        gameData.playerSocketIds.push(socket.id);
    }
    if(gameData.scores[name] === undefined) {
        gameData.scores[name] = 120; // Default score from rules
    }
    console.log(`[SERVER (Step 3) SUBMITNAME] ${name} (${socket.id}) joined. Total players: ${Object.keys(gameData.players).length}.`);
    socket.emit("playerJoined", { playerId: socket.id, name }); // Let this client know its ID
    io.emit("gameState", gameData); // Update all clients with new player list, scores etc.
    
    // Simplified ready check for now, will use full 3 or 4 player logic later
    const numPlayers = Object.keys(gameData.players).length;
    if (!gameData.gameStarted && numPlayers >= 1 && numPlayers <=4) { // Let's say 1-4 can be "Ready to Start" for testing this step
      // gameData.state = "Ready to Start"; // We'll manage this more carefully later
      // For now, just ensure gameData is emitted
    }
    // We will add the specific 3 or 4 player check from your rules later
    // if (!gameData.gameStarted && Object.keys(gameData.players).length === 4) { // Original 4-player check
    //   gameData.state = "Ready to Start";
    //   io.emit("gameState", gameData);
    // }
  });
  // --- END OF submitName ---

  socket.on("resetGame", () => { 
    console.log("[SERVER (Step 3) RESETGAME] Full game reset requested.");
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });

  // --- ADDED: Full disconnect logic from full game ---
  socket.on("disconnect", (reason) => {
    const pName = gameData.players[socket.id];
    console.log(`[SERVER (Step 3) DISCONNECT] ${pName || socket.id} disconnected. Reason: ${reason}`);
    if (pName) {
        delete gameData.players[socket.id];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== socket.id);
        // Remove player from active order if they were in it
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        
        // Simplified game reset on disconnect if critical number not met
        // We will refine this later to match full game rules (e.g., pause vs reset)
        const numPlayers = Object.keys(gameData.players).length;
        if (gameData.gameStarted && numPlayers < 3) { // Assuming min 3 for a game to continue
            console.log("[SERVER (Step 3) DISCONNECT] Game was in progress, not enough players to continue. Resetting.");
            resetFullGameData(); // Full reset for simplicity in this step
        } else if (!gameData.gameStarted && gameData.state === "Ready to Start" && numPlayers < 3) { // If was ready but now not enough
            gameData.state = "Waiting for Players to Join";
        }
        
        if (Object.keys(gameData.players).length === 0 && gameData.gameStarted) {
            console.log("[SERVER (Step 3) DISCONNECT] Last player left. Resetting game data.");
            resetFullGameData(); 
        }
        io.emit("gameState", gameData); // Update all clients
    }
  });
  // --- END OF disconnect ---
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incremental Backend Server (Step 3) running on http://localhost:${PORT}`);
});