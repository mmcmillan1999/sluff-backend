// --- Backend/server.js (INCREMENTAL BUILD - STEP 1.1 - dotenv and CORS only) ---
require("dotenv").config(); // ADDED
const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

console.log("SIMPLIFIED SERVER (Step 1.1): Initializing Socket.IO Server...");

const io = new Server(server, {
  cors: {
    // MODIFIED to use process.env
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

console.log("SIMPLIFIED SERVER (Step 1.1): Socket.IO Server initialized.");
console.log("SIMPLIFIED SERVER (Step 1.1): CLIENT_ORIGIN from env is: ", process.env.CLIENT_ORIGIN); // Log what it sees

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

// MODIFIED to use process.env
app.use(cors({ 
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*", 
    credentials: true 
}));
// app.use(express.json()); // Keep this out for now, add it in next micro-step

app.get("/", (req, res) => {
  console.log(`[HTTP GET /] Request received for root path from ${req.ip}`);
  res.send("Simplified Sluff Socket.IO Backend (Step 1.1) is Running!");
});

io.on("connection", (socket) => {
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.log("!!!! [SERVER SIMPLIFIED (Step 1.1) CONNECT] NEW SOCKET.IO CONNECTION ESTABLISHED !!!!");
  console.log(`!!!!    Socket ID: ${socket.id}`);
  console.log(`!!!!    Transport: ${socket.conn.transport.name}`);
  console.log(`!!!!    Remote Address (from handshake): ${socket.handshake.address}`);
  console.log(`!!!!    Client IP (from X-Forwarded-For if behind proxy like ngrok): ${socket.handshake.headers['x-forwarded-for'] || 'N/A'}`);
  console.log(`!!!!    Origin Header: ${socket.handshake.headers.origin}`);
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  socket.emit("messageFromServer", {
    greeting: "Hello from the Simplified Server (Step 1.1)!",
    socketId: socket.id
  });

  socket.on("clientTestEvent", (data) => {
    console.log(`[SERVER SIMPLIFIED (Step 1.1)] Received 'clientTestEvent' from ${socket.id} with data:`, data);
    socket.emit("serverTestResponse", {
      message: "Server (Step 1.1) received your test event!",
      originalData: data
    });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[SERVER SIMPLIFIED (Step 1.1) DISCONNECT] Socket disconnected: ${socket.id}. Reason: ${reason}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Simplified Backend Server (Step 1.1) running on http://localhost:${PORT}`);
  console.log("SIMPLIFIED SERVER (Step 1.1) Final check: CLIENT_ORIGIN for CORS is: ", process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*");
});