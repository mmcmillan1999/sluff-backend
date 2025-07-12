// This function creates the necessary database tables if they do not already exist.

const createTables = async (pool) => {
    try {
        // Create the 'users' table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                tokens DECIMAL(10, 2) DEFAULT 10.00,
                is_admin BOOLEAN DEFAULT FALSE
            );
        `);

        // Create the 'game_history' table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                game_id SERIAL PRIMARY KEY,
                table_id VARCHAR(255),
                theme VARCHAR(50),
                player_count INTEGER,
                outcome VARCHAR(255),
                game_started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                game_ended_at TIMESTAMP WITH TIME ZONE
            );
        `);

        // Create the 'transactions' table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(user_id),
                game_id INTEGER REFERENCES game_history(game_id),
                amount DECIMAL(10, 2) NOT NULL,
                transaction_type VARCHAR(50),
                transaction_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("✅ Tables checked/created successfully.");
    } catch (err) {
        console.error("❌ Error creating tables:", err);
        // Re-throw the error to be caught by the server startup logic
        throw err;
    }
};

module.exports = createTables;
