const assert = require('assert');
const { Pool } = require('pg');
require('dotenv').config(); // To load the DATABASE_URL from your .env file

// User credentials for the test
const TEST_USER_EMAIL = 'matthewgmcmillan@icloud.com';
const TEST_USER_PASSWORD = 'Ew**2012';
const SERVER_URL = 'https://sluff-backend.onrender.com';

// Setup database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function testChatHistoryIsMostRecent() {
    console.log('Running Test: API should return the most recent chat messages...');
    
    // Step 1: Login to get a JWT token
    let token;
    try {
        const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
        });
        const loginData = await loginRes.json();
        token = loginData.token;
    } catch (error) {
        throw new Error('Could not log in test user. Ensure the server is running and the user exists.');
    }

    // Step 2: Fetch chat history from the API
    let apiChatData;
    try {
        const chatRes = await fetch(`${SERVER_URL}/api/chat`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        apiChatData = await chatRes.json();
    } catch (error) {
        throw new Error('Could not fetch chat history from the API.');
    }

    // Step 3: Fetch the ground truth directly from the database
    let dbChatData;
    try {
        const dbQuery = `
            SELECT id, username, message 
            FROM lobby_chat_messages 
            ORDER BY created_at DESC 
            LIMIT 50;
        `;
        const { rows } = await pool.query(dbQuery);
        dbChatData = rows.reverse(); // Reverse to get chronological order (oldest to newest)
    } catch (error) {
        throw new Error('Could not query the database directly for chat messages.');
    }
    
    // Step 4: The Assertion and Detailed Failure Report
    try {
        // We will compare the arrays of message IDs to ensure they are identical in content and order.
        const apiMessageIds = apiChatData.map(msg => msg.id);
        const dbMessageIds = dbChatData.map(msg => msg.id);

        assert.deepStrictEqual(apiMessageIds, dbMessageIds, 'The message history from the API does not match the database.');

    } catch (error) {
        // This block runs ONLY if the assertion fails.
        console.error('\n--- TEST FAILED ---');
        console.error('Reason:', error.message);
        
        // Helper function to format the message list for easy reading
        const formatMessages = (messages) => {
            return messages.slice(-10).map(m => `  ID ${m.id}: "${m.message}"`).join('\n');
        };

        console.log('\nLast 10 Messages Returned by API (Oldest First):');
        console.log(formatMessages(apiChatData));
        
        console.log('\nLast 10 Messages Expected from Database (Newest First, then reversed):');
        console.log(formatMessages(dbChatData));

        // Re-throw the error so the test process exits with a failure code.
        throw error;
    }
}

async function run() {
    try {
        await testChatHistoryIsMostRecent();
        console.log('\n\u2713 All API tests passed! The chat history bug has been fixed.');
    } catch (error) {
        // The detailed error is already printed inside the test function.
        // We just need to ensure the script exits correctly.
        process.exit(1);
    } finally {
        await pool.end();
    }
}

run();