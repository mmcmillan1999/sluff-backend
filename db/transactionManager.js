// backend/db/transactionManager.js

const createGameRecord = async (pool, table) => {
    const query = `
        INSERT INTO game_history (table_id, theme, player_count, outcome)
        VALUES ($1, $2, $3, $4)
        RETURNING game_id;
    `;
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

const postTransaction = async (pool, { userId, gameId, type, amount, description }) => {
    // This function remains unchanged as it was already correct.
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
        // FIX: Changed user_id to id to match the 'users' table schema
        const balanceQuery = `SELECT id, tokens FROM users WHERE id = ANY($1::int[]) FOR UPDATE;`;
        const balanceResult = await client.query(balanceQuery, [playerIds]);
        
        if (balanceResult.rows.length !== 3) {
            throw new Error("Could not find all players for transaction.");
        }

        for (const player of balanceResult.rows) {
            if (parseFloat(player.tokens) < 1.00) { 
                throw new Error(`Player with ID ${player.id} has insufficient tokens.`);
            }
        }

        // Step 2: Deduct tokens and log transactions for each player
        const cost = -1.00;
        const description = `Table buy-in for game #${gameId}`;

        const transactionPromises = playerIds.map(userId => {
            // The 'transactions' table correctly uses 'user_id', so this is unchanged.
            const insertQuery = `INSERT INTO transactions(user_id, game_id, transaction_type, amount, description) VALUES($1, $2, 'buy_in', $3, $4);`;
            // FIX: Changed user_id to id for the 'users' table update
            const updateQuery = `UPDATE users SET tokens = tokens + $1 WHERE id = $2;`;
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
        throw error;
    } finally {
        client.release();
    }
};

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
    postTransaction,
    updateGameRecordOutcome,
    handleGameStartTransaction,
    awardWinnings
};