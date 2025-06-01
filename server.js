// --- Backend/server.js (INCREMENTAL BUILD - STEP 4.0 - Server-Side Ready/Start Logic) ---
require("dotenv").config(); 
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const SERVER_VERSION = "vS4.0"; // Server version
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
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Global constants defined.`);

let gameData = {
  state: "Waiting for Players to Join", players: {}, playerSocketIds: [],
  playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
  widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null, 
  biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
  trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [], 
  trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, 
  trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null,
};
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Initial gameData structure defined.`);

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
        trumpBroken: false, trickLeaderName: null, capturedTricks: {}, roundSummary: null
    };
}
console.log(`INCREMENTAL SERVER (${SERVER_VERSION}): Game reset functions defined.`);

// Helper function for shuffling
function shuffle(array) {
  let currentIndex = array.length,  randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

app.get("/", (req, res) => {
  res.send(`Incremental Sluff Socket.IO Backend (${SERVER_VERSION}) is Running!`);
});

io.on("connection", (socket) => {
  console.log(`!!!! [${SERVER_VERSION} CONNECT] ID: ${socket.id}, Transport: ${socket.conn.transport.name}`);
  socket.emit("gameState", gameData); 

  socket.emit("messageFromServer", { 
    greeting: `Hello from Server (${SERVER_VERSION})!`, socketId: socket.id
  });

  socket.on("clientTestEvent", (data) => { 
    console.log(`[${SERVER_VERSION} clientTestEvent] from ${socket.id}:`, data);
    socket.emit("serverTestResponse", { message: `Server (${SERVER_VERSION}) got test!`, originalData: data });
  });

  socket.on("submitName", (name) => {
    console.log(`[${SERVER_VERSION} SUBMITNAME] ID: ${socket.id} Name: "${name}". Current Players: ${Object.keys(gameData.players).length}, Game Started: ${gameData.gameStarted}`);
    if (gameData.players[socket.id] === name) {
        socket.emit("playerJoined", { playerId: socket.id, name });
        io.emit("gameState", gameData);
        return;
    }
    if (Object.values(gameData.players).includes(name)) {
        return socket.emit("error", "Name already taken.");
    }
    
    if (Object.keys(gameData.players).length >= 4 && !gameData.players[socket.id]) {
        return socket.emit("error", "Room full (4 players max).");
    }
    if (gameData.gameStarted && !gameData.players[socket.id] && Object.keys(gameData.players).length >=4) {
         return socket.emit("error", "Game in progress and full.");
    }

    gameData.players[socket.id] = name;
    if (!gameData.playerSocketIds.includes(socket.id)) {
        gameData.playerSocketIds.push(socket.id);
    }
    if(gameData.scores[name] === undefined) {
        gameData.scores[name] = 120; 
    }
    console.log(`[${SERVER_VERSION} SUBMITNAME] ${name} (${socket.id}) joined. Total players: ${Object.keys(gameData.players).length}.`);
    socket.emit("playerJoined", { playerId: socket.id, name });
    
    const numPlayers = Object.keys(gameData.players).length;
    // --- UNCOMMENTED AND MODIFIED FOR 4 PLAYERS ---
    if (!gameData.gameStarted && numPlayers === 4) { 
      gameData.state = "Ready to Start";
      console.log(`[${SERVER_VERSION} SUBMITNAME] 4 players joined. Game state changed to 'Ready to Start'.`);
    } else if (!gameData.gameStarted && numPlayers < 4) { // Ensure it's this if not enough
        gameData.state = "Waiting for Players to Join";
    }
    io.emit("gameState", gameData); 
  });

  socket.on("startGame", () => {
    const playerName = getPlayerNameById(socket.id);
    console.log(`[${SERVER_VERSION} STARTGAME] Request from ${playerName || 'Unknown Player'} (${socket.id}). Current state: ${gameData.state}`);

    if (gameData.state !== "Ready to Start") {
        return socket.emit("error", "Game not ready to start. Need 4 players and 'Ready to Start' state.");
    }
    if (Object.keys(gameData.players).length !== 4) { 
        return socket.emit("error", "Need exactly 4 players to start this game configuration.");
    }
    
    gameData.gameStarted = true;
    gameData.playerSocketIds = shuffle([...gameData.playerSocketIds]); 
    
    const dealerSocketId = gameData.playerSocketIds[0];
    gameData.dealer = gameData.players[dealerSocketId];
    
    gameData.playerOrderActive = [];
    for (let i = 1; i <= 3; i++) {
        const activePlayerSocketId = gameData.playerSocketIds[i % gameData.playerSocketIds.length]; 
        gameData.playerOrderActive.push(gameData.players[activePlayerSocketId]);
    }

    initializeNewRoundState(); 
    gameData.state = "Dealing Pending"; 
    
    console.log(`[${SERVER_VERSION} STARTGAME] Game started!`);
    console.log(`   Table Order (Dealer first): ${gameData.playerSocketIds.map(id => gameData.players[id]).join(', ')}`);
    console.log(`   Dealer: ${gameData.dealer}`);
    console.log(`   Active Players for Round: ${gameData.playerOrderActive.join(', ')}`);
    io.emit("gameState", gameData);
  });

  socket.on("resetGame", () => { 
    console.log(`[${SERVER_VERSION} RESETGAME] Full game reset requested.`);
    resetFullGameData(); 
    io.emit("gameState", gameData); 
  });

  socket.on("disconnect", (reason) => {
    const pName = gameData.players[socket.id];
    console.log(`[${SERVER_VERSION} DISCONNECT] ${pName || socket.id} disconnected. Reason: ${reason}`);
    if (pName) {
        delete gameData.players[socket.id];
        gameData.playerSocketIds = gameData.playerSocketIds.filter(id => id !== socket.id);
        gameData.playerOrderActive = gameData.playerOrderActive.filter(name => name !== pName);
        
        const numPlayers = Object.keys(gameData.players).length;
        if (gameData.gameStarted && numPlayers < 4) { // If game started and drops below 4
            console.log(`[${SERVER_VERSION} DISCONNECT] Game was in progress, <4 players. Resetting.`);
            resetFullGameData(); 
        } else if (!gameData.gameStarted && gameData.state === "Ready to Start" && numPlayers < 4) { 
            gameData.state = "Waiting for Players to Join";
        } else if (!gameData.gameStarted && numPlayers < 4) {
            gameData.state = "Waiting for Players to Join"; // General fallback if not started
        }
        
        if (Object.keys(gameData.players).length === 0 && gameData.gameStarted) {
            console.log(`[${SERVER_VERSION} DISCONNECT] Last player left a started game. Resetting.`);
            resetFullGameData(); 
        }
        io.emit("gameState", gameData); 
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incremental Backend Server (${SERVER_VERSION}) running on http://localhost:${PORT}`);
});