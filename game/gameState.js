// backend/game/gameState.js

const Table = require('./Table'); // Import the new Table class
const { SERVER_VERSION, TABLE_COSTS } = require('./constants');

let tables = {};

const THEMES = [
    { id: 'fort-creek', name: 'Fort Creek', count: 10 },
    { id: 'shirecliff-road', name: 'ShireCliff Road', count: 10 },
    { id: 'dans-deck', name: "Dan's Deck", count: 10 },
];

/**
 * Creates instances of the Table class for each defined theme.
 * This is the factory that builds our game world.
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
            
            // Create a new instance of our Table class
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
 * It calls the getStateForClient method on each table instance.
 */
function getLobbyState() {
    const groupedByTheme = THEMES.map(theme => {
        const themeTables = Object.values(tables)
            .filter(tableInstance => tableInstance.theme === theme.id)
            .map(tableInstance => {
                const clientState = tableInstance.getStateForClient(); // Get the serializable state
                const activePlayers = Object.values(clientState.players).filter(p => !p.isSpectator);
                return {
                    tableId: clientState.tableId,
                    tableName: clientState.tableName,
                    state: clientState.state,
                    playerCount: activePlayers.length,
                    playerNames: activePlayers.map(p => p.playerName)
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