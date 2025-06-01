// --- Backend/server.js (INCREMENTAL BUILD - STEP 1.2 - Re-add express.json) ---
require("dotenv").config(); 
const http = require("http");
const { Server } = require("socket.io");
const express = require("express"); // express was already here
const cors = require("cors");

const app = express();
const server = http.createServer(app);

console.log("INCREMENTAL SERVER (Step 1.2): Initializing Socket.IO Server...");

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

console.log("INCREMENTAL SERVER (Step 1.2): Socket.IO Server initialized.");
console.log("INCREMENTAL SERVER (Step 1.2): CLIENT_ORIGIN from env is: ", process.env.CLIENT_ORIGIN); 

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

app.use(cors({ 
    origin: "*", 
    credentials: true 
}));
app.use(express.json()); // RE-ADDED THIS LINE

app.get("/", (req, res) => {
  console.log(`[HTTP GET /] Request received for root path from ${req.ip}`);
  res.send("Incremental Sluff Socket.IO Backend (Step 1.2) is Running!");
});

io.on("connection", (socket) => {
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log("!!!! [SERVER INCREMENTAL (Step 1.2) CONNECT] NEW SOCKET.IO CONNECTION ESTABLISHED !!!!");
  console.log(`!!!!    Socket ID: ${socket.id}`);
  console.log(`!!!!    Transport: ${socket.conn.transport.name}`);
  // ... (rest of the connection logs) ...
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  // Emit current gameData (which is mostly initial/empty at this stage)
  // For now, let's just emit a simple object. We'll add gameData back soon.
  socket.emit("gameState", { state: "Connected to Step 1.2 Server" }); 

  socket.emit("messageFromServer", {
    greeting: "Hello from the Incremental Server (Step 1.2)!",
    socketId: socket.id
  });

  socket.on("clientTestEvent", (data) => {
    console.log(`[SERVER INCREMENTAL (Step 1.2)] Received 'clientTestEvent' from ${socket.id} with data:`, data);
    socket.emit("serverTestResponse", {
      message: "Server (Step 1.2) received your test event!",
      originalData: data
    });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[SERVER INCREMENTAL (Step 1.2) DISCONNECT] Socket disconnected: ${socket.id}. Reason: ${reason}`);
  });

  // Minimal resetGame handler for testing later if needed
  socket.on("resetGame", () => { 
    console.log("[SERVER INCREMENTAL (Step 1.2) RESETGAME] Reset request received.");
    // resetFullGameData(); // We'll add gameData and this function back next
    io.emit("gameState", { state: "Game Reset on Step 1.2 (placeholder)" });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Incremental Backend Server (Step 1.2) running on http://localhost:${PORT}`);
  console.log("INCREMENTAL SERVER (Step 1.2) CORS origin is hardcoded to '*' ");
});