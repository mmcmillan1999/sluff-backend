// --- START FILE: Backend/ai_tools.js ---

/**
 * This module contains functions that can be called by the AI assistant.
 * These functions provide read-only access to live application data.
 * IMPORTANT: Avoid any functions here that modify data unless you have
 * extremely robust security and confirmation checks in place.
 */

// We need the global 'state' to access in-memory table data.
const state = require('./game/gameState');

/**
 * Retrieves the complete, real-time game state for a specific table ID.
 * @param {object} args - The arguments for the function.
 * @param {string} args.tableId - The ID of the table to look up (e.g., "table-1").
 * @returns {Promise<object>} The full state of the requested table.
 */
async function getTableState({ tableId }) {
  const table = state.getTableById(tableId);
  if (!table) {
    return { error: `Table with ID '${tableId}' not found.` };
  }
  // The getStateForClient() method already prepares a clean object for us.
  return table.getStateForClient();
}

/**
 * Retrieves a user's profile, stats, and current token balance from the database.
 * @param {object} args - The arguments for the function.
 * @param {object} pool - The PostgreSQL connection pool.
 * @param {string} args.username - The username of the player to look up.
 * @returns {Promise<object>} The user's combined profile and token data.
 */
async function getUserByUsername({ username }, pool) {
  if (!pool) return { error: "Database connection not available." };
  
  try {
    const query = `
      SELECT 
        u.id, u.username, u.email, u.wins, u.losses, u.washes, u.is_admin,
        COALESCE(SUM(t.amount), 0) as tokens
      FROM users u
      LEFT JOIN transactions t ON u.id = t.user_id
      WHERE u.username = $1
      GROUP BY u.id;
    `;
    const { rows } = await pool.query(query, [username]);

    if (rows.length === 0) {
      return { error: `User with username '${username}' not found.` };
    }
    
    // Ensure tokens are formatted consistently
    rows[0].tokens = parseFloat(rows[0].tokens).toFixed(2);
    return rows[0];

  } catch (err) {
    console.error(`[AI Tool Error] Failed to get user ${username}:`, err);
    return { error: "A database error occurred." };
  }
}

// Export the functions so our switchboard can use them.
module.exports = {
  getTableState,
  getUserByUsername,
};
// --- END FILE: Backend/ai_tools.js ---