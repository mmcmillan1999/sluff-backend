// backend/db/transactionManager.js

// --- MODIFICATION: Import TABLE_COSTS to look up buy-in amounts ---
const { TABLE_COSTS } = require('../game/constants');

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

// --- MODIFICATION: Updated function to accept the 'table' object and use its theme ---
const handleGameStartTransaction = async (pool, table, playerIds, gameId) => {
    // Look up the cost dynamically based on the table's theme, default to 1 if not found
    const cost = -(TABLE_COSTS[table.theme] || 1);
    const description = `Table buy-in for game #${gameId}`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const balanceQuery = `
            SELECT user_id, SUM(amount) as current_tokens 
            FROM transactions 
            WHERE user_id = ANY($1::int[]) 
            GROUP BY user_id;
        `;
        const balanceResult = await client.query(balanceQuery, [playerIds]);
        
        const playerBalances = balanceResult.rows.reduce((acc, row) => {
            acc[row.user_id] = parseFloat(row.current_tokens);
            return acc;
        }, {});

        for (const userId of playerIds) {
            const balance = playerBalances[userId] || 0;
            if (balance < Math.abs(cost)) {
                const userRes = await client.query('SELECT username FROM users WHERE id = $1', [userId]);
                const username = userRes.rows[0]?.username || `Player ID ${userId}`;
                throw new Error(`${username} has insufficient tokens. Needs ${Math.abs(cost)}, but has ${balance.toFixed(2)}.`);
            }
        }

        const transactionPromises = playerIds.map(userId => {
            const insertQuery = `
                INSERT INTO transactions(user_id, game_id, transaction_type, amount, description) 
                VALUES($1, $2, 'buy_in', $3, $4);
            `;
            return client.query(insertQuery, [userId, gameId, cost, description]);
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