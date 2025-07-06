// backend/game/state.js (v8.0.0 - Major Refactor)

const { SERVER_VERSION, NUM_TABLES } = require('./constants');

// This is the single source of truth for all game table states.
let tables = {};

const TABLE_NAMES = {
    "table-1": "Fort Creek",
    "table-2": "ShireCliff Road",
    "table-3": "Table 3",
};

// --- State Initialization and Resetting ---

function getInitialInsuranceState() {
    return {
        isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0,
        defenderOffers: {}, dealExecuted: false, executedDetails: null
    };
}

function getInitialGameData(tableId) {
    const tableName = TABLE_NAMES[tableId] || `Table ${tableId.split('-')[1]}`;
    return {
        tableId: tableId, tableName: tableName, state: "Waiting for Players", players: {},
        playerOrderActive: [], dealer: null, hands: {}, widow: [], originalDealtWidow: [],
        widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [], currentHighestBidDetails: null,
        biddingTurnPlayerName: null, bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false,
        trumpSuit: null, bidWinnerInfo: null, gameStarted: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
        trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [],
        lastCompletedTrick: null, playersWhoPassedThisRound: [], playerMode: null,
        serverVersion: SERVER_VERSION, insurance: getInitialInsuranceState(),
    };
}

function initializeGameTables() {
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log("In-memory game tables initialized.");
}

function initializeNewRoundState(table) {
    Object.assign(table, {
        hands: {}, widow: [], originalDealtWidow: [], widowDiscardsForFrogBidder: [], bidsThisRound: [],
        currentHighestBidDetails: null, trumpSuit: null, bidWinnerInfo: null, biddingTurnPlayerName: null,
        bidsMadeCount: 0, originalFrogBidderId: null, soloBidMadeAfterFrog: false, currentTrickCards: [],
        trickTurnPlayerName: null, tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false,
        trickLeaderName: null, capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [],
        lastCompletedTrick: null, playersWhoPassedThisRound: [], insurance: getInitialInsuranceState(),
    });
    table.playerOrderActive.forEach(pName => {
        if (pName && table.scores[pName] !== undefined) {
            table.capturedTricks[pName] = [];
        }
    });
}

function resetTable(tableId, emitters) {
    const { emitTableUpdate, emitLobbyUpdate } = emitters;
    const table = tables[tableId];
    if (!table) return;
    const originalPlayers = { ...table.players };
    tables[tableId] = getInitialGameData(tableId);
    const activePlayerNames = [];
    for (const userId in originalPlayers) {
        const playerInfo = originalPlayers[userId];
        tables[tableId].players[userId] = { ...playerInfo, isSpectator: false, disconnected: playerInfo.disconnected };
        tables[tableId].scores[playerInfo.playerName] = 120;
        if (!playerInfo.isSpectator) {
            activePlayerNames.push(playerInfo.playerName);
        }
    }
    tables[tableId].playerOrderActive = activePlayerNames;
    tables[tableId].gameStarted = true;
    tables[tableId].playerMode = activePlayerNames.length;
    if (activePlayerNames.length >= 3) {
        tables[tableId].state = "Ready to Start";
    } else {
        tables[tableId].state = "Waiting for Players";
    }
    emitTableUpdate(tableId);
    emitLobbyUpdate();
}

// --- State Accessors and Getters ---

function getTableById(tableId) { return tables[tableId]; }
function getAllTables() { return tables; }

function getLobbyState() {
    const lobbyData = {
        // --- MODIFICATION: Wrap tables in a 'tables' property ---
        tables: Object.fromEntries(
            Object.entries(tables).map(([tableId, table]) => {
                const allPlayers = Object.values(table.players);
                const activePlayers = allPlayers.filter(p => !p.isSpectator);
                return [
                    tableId,
                    {
                        tableId: table.tableId,
                        tableName: table.tableName,
                        state: table.state,
                        players: activePlayers.map(p => ({
                            userId: p.userId, playerName: p.playerName, disconnected: p.disconnected
                        })),
                        playerCount: activePlayers.length,
                        spectatorCount: allPlayers.length - activePlayers.length,
                    }
                ];
            })
        ),
        // --- MODIFICATION: Add the server version to the payload ---
        serverVersion: SERVER_VERSION
    };
    return lobbyData;
}

module.exports = {
    initializeGameTables, initializeNewRoundState, resetTable,
    getTableById, getAllTables, getLobbyState,
};
