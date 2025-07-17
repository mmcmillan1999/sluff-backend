// backend/game/gameState.js

const Table = require('./Table'); // Import the new Table class
const { SERVER_VERSION, TABLE_COSTS } = require('./constants');

let tables = {};

// --- MODIFICATION: Reordered the themes to place Miss Paul's Academy last ---
const THEMES = [
    { id: 'fort-creek', name: 'Fort Creek', count: 10 },
    { id: 'shirecliff-road', name: 'ShireCliff Road', count: 10 },
    { id: 'dans-deck', name: "Dan's Deck", count: 10 },
    { id: 'miss-pauls-academy', name: "Miss Paul's Academy", count: 10 },
];

/**
 * Creates instances of the Table class for each defined theme.
 * @param {object} io - The main socket.io server instance.
 * @param {object} pool - The PostgreSQL connection pool.
 */
function initializeGameTables(io, pool) {
    let tableCounter = 1;

    const emitLobbyUpdate = () => {
        io.emit("lobbyState", getLobbyState());
    };

    THEMES.forEach(theme => {
        for (let i = 0; i < theme.count; i++) {
            const tableId = `table-${tableCounter}`;
            const tableNumber = i + 1;
            const tableName = `${theme.name} #${tableNumber}`;
            
            tables[tableId] = new Table(tableId, theme.id, tableName, io, pool, emitLobbyUpdate);
            tableCounter++;
        }
    });
    console.log(`${tableCounter - 1} in-memory game tables initialized using Table class.`);
}

function getTableById(tableId) {
    return tables[tableId];
}

function getAllTables() {
    return tables;
}

/**
 * Gathers the state of all tables for the main lobby view.
 */
function getLobbyState() {
    const groupedByTheme = THEMES.map(theme => {
        const themeTables = Object.values(tables)
            .filter(tableInstance => tableInstance.theme === theme.id)
            .map(tableInstance => {
                const clientState = tableInstance.getStateForClient();
                const activePlayers = Object.values(clientState.players).filter(p => !p.isSpectator);
                return {
                    tableId: clientState.tableId,
                    tableName: clientState.tableName,
                    state: clientState.state,
                    playerCount: activePlayers.length,
                    players: activePlayers.map(p => ({ userId: p.userId, playerName: p.playerName }))
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
    initializeGameTables,
    getTableById,
    getAllTables,
    getLobbyState,
};