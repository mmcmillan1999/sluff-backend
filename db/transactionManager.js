// backend/db/transactionManager.js

/**
 * Creates a new record in the game_history table.
 * This should be called once when a new game officially starts.
 * @param {object} pool - The PostgreSQL connection pool.
 * @param {object} table - The in-memory table object from gameState.
 * @returns {Promise<number>} The game_id of the newly created game record.
 */
const createGameRecord = async (pool, table) => {
    const query = `
        INSERT INTO game_history (table_id, theme, player_count, outcome)
        VALUES ($1, $2, $3, $4)
        RETURNING game_id;
    `;
    // The initial outcome is 'In Progress'
    const values = [table.tableId, table.theme, table.playerMode, 'In Progress'];
    try {
        const result = await pool.query(query, values);
        console.log(`[DB] Created game_id: ${result.rows[0].game_id} for table ${table.tableId}`);
        return result.rows[0].game_id;
    } catch (err) {
        console.error('Error creating game record in database:', err);
        throw err;
    }
};

/**
 * Posts a single financial transaction to the transactions ledger.
 * @param {object} pool - The PostgreSQL connection pool.
 * @param {number} userId - The ID of the user for the transaction.
 * @param {number} gameId - The ID of the game this transaction is related to.
 * @param {string} type - The type of transaction (e.g., 'buy_in', 'win_payout').
 * @param {number} amount - The transaction amount (negative for debit, positive for credit).
 * @param {string} description - A brief description of the transaction.
 * @returns {Promise<object>} The newly created transaction record.
 */
const postTransaction = async (pool, { userId, gameId, type, amount, description }) => {
    const query = `
        INSERT INTO transactions (user_id, game_id, transaction_type, amount, description)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
    `;
    const values = [userId, gameId, type, amount, description];
    try {
        const result = await pool.query(query, values);
        console.log(`[DB] Posted transaction_id: ${result.rows[0].transaction_id} for user_id: ${userId}, type: ${type}, amount: ${amount}`);
        return result.rows[0];
    } catch (err) {
        console.error(`Error posting transaction for user ${userId}:`, err);
        throw err;
    }
};

/**
 * Updates a game record when the game has concluded.
 * @param {object} pool - The PostgreSQL connection pool.
 * @param {number} gameId - The ID of the game to update.
 * @param {string} outcome - The final outcome message of the game.
 */
const updateGameRecordOutcome = async (pool, gameId, outcome) => {
    const query = `
        UPDATE game_history
        SET outcome = $1, end_time = NOW()
        WHERE game_id = $2;
    `;
    try {
        await pool.query(query, [outcome, gameId]);
        console.log(`[DB] Finalized game_id: ${gameId} with outcome: "${outcome}"`);
    } catch (err) {
        console.error(`Error updating game record outcome for game_id ${gameId}:`, err);
    }
};

const handleGameStartTransaction = async (pool, playerIds, gameId) => {
    if (playerIds.length !== 3) {
        throw new Error("Game start transaction requires exactly 3 players.");
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Step 1: Verify all players have sufficient tokens
        const balanceQuery = `SELECT user_id, tokens FROM users WHERE user_id = ANY($1::int[]) FOR UPDATE;`;
        const balanceResult = await client.query(balanceQuery, [playerIds]);

        if (balanceResult.rows.length !== 3) {
            throw new Error("Could not find all players for transaction.");
        }

        for (const player of balanceResult.rows) {
            if (parseFloat(player.tokens) < 1.00) { // Assuming a cost of 1 token
                throw new Error(`Player ${player.user_id} has insufficient tokens.`);
            }
        }

        // Step 2: Deduct tokens and log transactions for each player
        const cost = -1.00;
        const description = `Table buy-in for game #${gameId}`;

        const transactionPromises = playerIds.map(userId => {
            const insertQuery = `INSERT INTO transactions(user_id, game_id, type, amount, description) VALUES($1, $2, 'buy_in', $3, $4);`;
            const updateQuery = `UPDATE users SET tokens = tokens + $1 WHERE user_id = $2;`;
            return Promise.all([
                client.query(insertQuery, [userId, gameId, cost, description]),
                client.query(updateQuery, [cost, userId])
            ]);
        });

        await Promise.all(transactionPromises);

        await client.query('COMMIT');
        console.log(`✅ Game start buy-in transaction successful for game ${gameId}`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("❌ Game start transaction failed and was rolled back:", error.message);
        throw error; // Re-throw the error to be handled by the server
    } finally {
        client.release();
    }
};


module.exports = {
    createGameRecord,
    postTransaction,
    updateGameRecordOutcome,
    handleGameStartTransaction,
};