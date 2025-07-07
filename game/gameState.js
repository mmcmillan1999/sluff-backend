// backend/game/gameState.js

const { SERVER_VERSION } = require('./constants');

let tables = {};
const NUM_TABLES = 30; // Explicitly set the total number of tables

function getInitialInsuranceState() {
    return {
        isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0,
        defenderOffers: {}, dealExecuted: false, executedDetails: null
    };
}

// This function now uses simple math to determine the name and theme
function getInitialGameData(tableId) {
    const tableNum = parseInt(tableId.split('-')[1], 10);
    let themeId, themeName, name;

    if (tableNum <= 10) {
        themeId = 'fort-creek';
        themeName = 'Fort Creek';
        name = `${themeName} ${tableNum}`;
    } else if (tableNum <= 20) {
        themeId = 'shirecliff-road';
        themeName = 'ShireCliff Road';
        name = `${themeName} ${tableNum - 10}`;
    } else {
        themeId = 'dans-deck';
        themeName = "Dan's Deck";
        name = `${themeName} ${tableNum - 20}`;
    }

    return {
        tableId: tableId, tableName: name, theme: themeId, state: "Waiting for Players",
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
    // A simple, direct loop from 1 to 30
    for (let i = 1; i <= NUM_TABLES; i++) {
        const tableId = `table-${i}`;
        tables[tableId] = getInitialGameData(tableId);
    }
    console.log(`${NUM_TABLES} in-memory game tables initialized.`);
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

// --- FIX: Corrected resetTable to preserve players ---
function resetTable(tableId, emitters) {
    const { emitTableUpdate, emitLobbyUpdate } = emitters;
    const table = tables[tableId];
    if (!table) return;

    const originalPlayers = { ...table.players };
    
    // Get a fresh table structure but keep the original theme
    const freshTable = getInitialGameData(tableId);
    tables[tableId] = freshTable;

    // Re-add the players and reset their scores
    const activePlayerNames = [];
    for (const userId in originalPlayers) {
        const playerInfo = originalPlayers[userId];
        
        tables[tableId].players[userId] = { 
            ...playerInfo, 
            isSpectator: false, // Ensure re-seated players are not spectators
            disconnected: playerInfo.disconnected 
        };
        tables[tableId].scores[playerInfo.playerName] = 120;

        if (!playerInfo.isSpectator) {
            activePlayerNames.push(playerInfo.playerName);
        }
    }

    tables[tableId].playerOrderActive = activePlayerNames;
    tables[tableId].gameStarted = true; // Keep game "locked" so new players can't take seats
    tables[tableId].playerMode = activePlayerNames.length;

    if (activePlayerNames.length >= 3) {
        tables[tableId].state = "Ready to Start";
    } else {
        tables[tableId].state = "Waiting for Players";
    }

    emitTableUpdate(tableId);
    emitLobbyUpdate();
}

function getTableById(tableId) { return tables[tableId]; }
function getAllTables() { return tables; }

function getLobbyState() {
    const lobbyTables = Object.fromEntries(
        Object.values(tables).map(table => {
            const allPlayers = Object.values(table.players);
            const activePlayers = allPlayers.filter(p => !p.isSpectator);
            return [
                table.tableId,
                {
                    tableId: table.tableId,
                    tableName: table.tableName,
                    state: table.state,
                    playerCount: activePlayers.length,
                }
            ];
        })
    );

    const lobbyData = {
        tables: lobbyTables,
        serverVersion: SERVER_VERSION
    };
    return lobbyData;
}

module.exports = {
    initializeGameTables, initializeNewRoundState, resetTable,
    getTableById, getAllTables, getLobbyState,
};
