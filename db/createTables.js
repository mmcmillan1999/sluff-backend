// backend/db/createTables.js

const createDbTables = async (pool) => {
    try {
        // This command creates the type if it doesn't exist at all.
        await pool.query(`
            DO $$ BEGIN
                CREATE TYPE transaction_type_enum AS ENUM (
                    'buy_in', 
                    'win_payout', 
                    'forfeit_loss', 
                    'forfeit_payout',
                    'admin_adjustment',
                    'free_token_mercy'
                );
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        // FIX: These commands will run every time, ensuring any missing values are added
        // to an already existing ENUM type without causing an error. This patches the live DB.
        await pool.query("ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'wash_payout'");

        // You could add more here in the future if needed, e.g.:
        // await pool.query("ALTER TYPE transaction_type_enum ADD VALUE IF NOT EXISTS 'another_future_type'");

        await pool.query(`
            DO $$ BEGIN
                CREATE TYPE user_role_enum AS ENUM ('player', 'admin');
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
        console.error("Error during table creation/modification:", err);
        throw err;
    }
};

module.exports = createDbTables;