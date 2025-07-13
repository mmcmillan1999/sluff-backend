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
// backend/db/createTables.js

const createDbTables = async (pool) => {
    try {
        await pool.query(`
            DO $$ BEGIN
                CREATE TYPE user_role_enum AS ENUM ('player', 'admin');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        // FIX: Added 'wash_payout' to the list of valid transaction types.
        await pool.query(`
            DO $$ BEGIN
                CREATE TYPE transaction_type_enum AS ENUM (
                    'buy_in', 
                    'win_payout', 
                    'forfeit_loss', 
                    'forfeit_payout',
                    'wash_payout', 
                    'free_token_mercy',
                    'admin_adjustment'
                );
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                washes INTEGER DEFAULT 0,
                is_admin BOOLEAN DEFAULT FALSE
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_history (
                game_id SERIAL PRIMARY KEY,
                table_id VARCHAR(50),
                theme VARCHAR(50),
                player_count INTEGER,
                start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                end_time TIMESTAMP WITH TIME ZONE,
                outcome TEXT
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                game_id INTEGER REFERENCES game_history(game_id) ON DELETE SET NULL,
                transaction_type transaction_type_enum NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                description TEXT,
                transaction_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("✅ Tables checked/created successfully.");
    } catch (err) {
        console.error("Error creating database tables:", err);
        throw err;
    }
};

module.exports = createDbTables;