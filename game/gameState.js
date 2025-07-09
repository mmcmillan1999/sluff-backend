// backend/game/gameState.js

const { SERVER_VERSION, TABLE_COSTS } = require('./constants');

let tables = {};

const THEMES = [
    { id: 'fort-creek', name: 'Fort Creek', count: 10 },
    { id: 'shirecliff-road', name: 'ShireCliff Road', count: 10 },
    { id: 'dans-deck', name: "Dan's Deck", count: 10 },
];

function getInitialInsuranceState() {
    return {
        isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0,
        defenderOffers: {}, dealExecuted: false, executedDetails: null
    };
}

function getInitialGameData(tableId, theme) {
    const themeIndex = THEMES.findIndex(t => t.id === theme.id);
    const baseCount = themeIndex > 0 ? THEMES.slice(0, themeIndex).reduce((acc, t) => acc + t.count, 0) : 0;
    const tableNumber = parseInt(tableId.split('-')[1], 10) - baseCount;
    const tableName = `${theme.name} ${tableNumber}`;

    return {
        tableId: tableId, tableName: tableName, theme: theme.id, state: "Waiting for Players",
        players: {}, playerOrderActive: [], dealer: null, hands: {}, widow: [],
        originalDealtWidow: [], widowDiscardsForFrogBidder: [], scores: {}, bidsThisRound: [],
        currentHighestBidDetails: null, biddingTurnPlayerName: null, bidsMadeCount: 0,
        originalFrogBidderId: null, soloBidMadeAfterFrog: false, trumpSuit: null,
        bidWinnerInfo: null, gameStarted: false, currentTrickCards: [], trickTurnPlayerName: null,
        tricksPlayedCount: 0, leadSuitCurrentTrick: null, trumpBroken: false, trickLeaderName: null,
        capturedTricks: {}, roundSummary: null, revealedWidowForFrog: [], lastCompletedTrick: null,
        playersWhoPassedThisRound: [], playerMode: null, serverVersion: SERVER_VERSION,
        insurance: getInitialInsuranceState(),
    };
}

function initializeGameTables() {
    let tableCounter = 1;
    THEMES.forEach(theme => {
        for (let i = 0; i < theme.count; i++) {
            const tableId = `table-${tableCounter}`;
            tables[tableId] = getInitialGameData(tableId, theme);
            tableCounter++;
        }
    });
    console.log(`${tableCounter - 1} in-memory game tables initialized.`);
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
    const themeId = table.theme;
    const theme = THEMES.find(t => t.id === themeId) || { id: 'default', name: 'Default' };
    
    tables[tableId] = getInitialGameData(tableId, theme);

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
    tables[tableId].state = activePlayerNames.length >= 3 ? "Ready to Start" : "Waiting for Players";

    emitTableUpdate(tableId);
    emitLobbyUpdate();
}

function getTableById(tableId) { return tables[tableId]; }
function getAllTables() { return tables; }

function getLobbyState() {
    const groupedByTheme = THEMES.map(theme => {
        const themeTables = Object.values(tables)
            .filter(table => table.theme === theme.id)
            .map(table => {
                const allPlayers = Object.values(table.players);
                const activePlayers = allPlayers.filter(p => !p.isSpectator);
                // --- MODIFICATION: Add playerNames to the returned object ---
                return {
                    tableId: table.tableId,
                    tableName: table.tableName,
                    state: table.state,
                    playerCount: activePlayers.length,
                    playerNames: activePlayers.map(p => p.playerName) // Add this line
                };
            });
        return { ...theme, cost: TABLE_COSTS[theme.id] || 0, tables: themeTables };
    });

    const lobbyData = {
        themes: groupedByTheme,
        serverVersion: SERVER_VERSION
    };
    return lobbyData;
}

module.exports = {
    initializeGameTables, initializeNewRoundState, resetTable,
    getTableById, getAllTables, getLobbyState,
};
