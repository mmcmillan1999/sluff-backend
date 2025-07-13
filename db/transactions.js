const TransactionManager = require('../transactionManager');

/**
 * Handles the database transaction for starting a new game.
 * This includes verifying player token balances, deducting tokens,
 * and logging each transaction. The entire operation is atomic.
 *
 * @param {Array<string>} playerIds - An array of the three active player IDs.
 * @param {object} pool - The PostgreSQL connection pool.
 * @returns {Promise<{success: boolean}>} - Resolves with success status.
 * @throws {Error} - Throws an error if any player has insufficient tokens,
 * or if there is a database error.
 */
const handleGameStartTransaction = async (playerIds, pool) => {
    if (playerIds.length !== 3) {
        throw new Error("Game start transaction requires exactly 3 players.");
    }

    const transactionManager = new TransactionManager(pool);
    const client = await transactionManager.begin();

    try {
        // Step 1: Verify all players have sufficient tokens
        const selectPromises = playerIds.map(id =>
            client.query('SELECT tokens FROM users WHERE user_id = $1', [id])
        );
        const results = await Promise.all(selectPromises);

        for (let i = 0; i < results.length; i++) {
            if (results[i].rows.length === 0 || results[i].rows[0].tokens < 1) {
                const insufficientPlayerId = playerIds[i];
                throw new Error(`Player ${insufficientPlayerId} has insufficient tokens.`);
            }
        }

        // Step 2: Deduct tokens and log transactions for each player
        const updatePromises = playerIds.map(id =>
            client.query('UPDATE users SET tokens = tokens - 1 WHERE user_id = $1 RETURNING tokens', [id])
        );
        await Promise.all(updatePromises);

        const logPromises = playerIds.map(id =>
            client.query(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                [id, -1, 'game_entry', `Token deducted for starting a new game.`]
            )
        );
        await Promise.all(logPromises);

        // If all operations succeed, commit the transaction
        await transactionManager.commit();
        console.log(`✅ Game start transaction successful for players: ${playerIds.join(', ')}`);
        return { success: true };

    } catch (error) {
        // If any error occurs, roll back the entire transaction
        await transactionManager.rollback();
        console.error("❌ Game start transaction failed. Rolling back changes.", error.message);
        throw error; // Re-throw the error to be handled by the caller
    }
};

module.exports = {
    handleGameStartTransaction
};