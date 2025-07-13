// backend/db/transactionManager.js

const createGameRecord = async (pool, table) => {
    const playerNames = Object.values(table.players).map(p => p.playerName).join(', ');
    const query = `
        INSERT INTO game_history (table_name, players, theme)
        VALUES ($1, $2, $3)
        RETURNING id;
    `;
    const values = [table.tableName, playerNames, table.theme];
    try {
        const res = await pool.query(query, values);
        console.log(`Game record created with ID: ${res.rows[0].id}`);
        return res.rows[0].id;
    } catch (err) {
        console.error("Error creating game record:", err);
        throw err;
    }
};

const updateGameRecordOutcome = async (pool, gameId, outcome) => {
    const query = `
        UPDATE game_history
        SET outcome = $1, completed_at = NOW()
        WHERE id = $2;
    `;
    try {
        await pool.query(query, [outcome, gameId]);
        console.log(`Game record ${gameId} updated with outcome.`);
    } catch (err) {
        console.error("Error updating game record outcome:", err);
        throw err;
    }
};

const postTransaction = async (pool, { userId, gameId, type, amount, description }) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertTransactionQuery = `
            INSERT INTO transactions(user_id, game_id, type, amount, description)
            VALUES($1, $2, $3, $4, $5);
        `;
        await client.query(insertTransactionQuery, [userId, gameId, type, amount, description]);
        const updateUserTokensQuery = `
            UPDATE users SET tokens = tokens + $1 WHERE user_id = $2;
        `;
        await client.query(updateUserTokensQuery, [amount, userId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in postTransaction, transaction rolled back:", err);
        throw err;
    } finally {
        client.release();
    }
};

// --- MODIFICATION: Added new function ---
/**
 * Handles the entire atomic transaction for starting a game.
 * 1. Checks balances for all players.
 * 2. If all balances are sufficient, posts a 'buy_in' transaction for each player.
 * @param {object} pool - The database connection pool.
 * @param {Array<string>} playerIds - An array of the three active player userIds.
 * @param {number} gameId - The ID for the current game from the game_history table.
 * @throws {Error} If any player has insufficient tokens.
 */
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

/**
 * Posts a transaction to award the winnings to the victor.
 * @param {object} pool The database connection pool.
 * @param {string} winnerId The user ID of the winning player.
 * @param {number} potSize The total amount of tokens to award.
 * @param {number} gameId The ID of the game record.
 */
const awardWinnings = async (pool, winnerId, potSize, gameId) => {
    if (!winnerId || potSize <= 0) {
        console.log("No winner or empty pot, skipping payout transaction.");
        return;
    }
    await postTransaction(pool, {
        userId: winnerId,
        gameId: gameId,
        type: 'win_payout',
        amount: potSize,
        description: `Winnings for game #${gameId}`
    });
    console.log(`✅ Payout of ${potSize} tokens successful for user ${winnerId} in game ${gameId}`);
};


module.exports = {
    createGameRecord,
    updateGameRecordOutcome,
    postTransaction,
    handleGameStartTransaction,
    awardWinnings
};