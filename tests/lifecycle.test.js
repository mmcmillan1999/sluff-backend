const assert = require('assert');
const fetch = require('node-fetch');
const io = require('socket.io-client');
require('dotenv').config();

const SERVER_URL = 'http://localhost:3000';
const TEST_USER_EMAIL = 'matthewgmcmillan@icloud.com';
const TEST_USER_PASSWORD = 'Ew**2012';

// Helper function to create a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runLifecycleTests() {
    console.log('Running lifecycle.js tests...');
    let testCounter = 1;
    const pass = (testName) => console.log(`  \u2713 Test ${testCounter++}: ${testName}`);
    
    let token;
    let user;
    let socket;

    // --- Login and Socket Connection ---
    try {
        const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
        });
        const loginData = await loginRes.json();
        token = loginData.token;
        user = loginData.user;
        assert.ok(token, 'Setup Failed: Could not log in.');
    } catch (e) {
        console.error('Setup Failed: Login failed.', e.message);
        process.exit(1);
    }
    
    // --- Test 1: Login triggers a chat message ---
    console.log('  Running Test 1: Login Chat Announcement...');
    try {
        const chatPromise = new Promise((resolve, reject) => {
            socket = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
            socket.on('new_lobby_message', (msg) => {
                if (msg.message.includes(`${user.username} has logged on`)) {
                    resolve(msg);
                }
            });
            setTimeout(() => reject(new Error('Test timed out. No login message received.')), 3000);
        });
        
        await chatPromise;
        pass('Login triggers a system chat message.');
        
    } catch (error) {
        // We expect this to fail right now.
        assert.fail('Test 1 FAILED (as expected): Login did not trigger a chat message.');
    }

    // --- Test 2: Logout triggers a chat message ---
    console.log('  Running Test 2: Logout Chat Announcement...');
    try {
        const logoutPromise = new Promise((resolve, reject) => {
            socket.on('new_lobby_message', (msg) => {
                 if (msg.message.includes(`${user.username} has logged out`)) {
                    resolve(msg);
                }
            });
            // Disconnecting the socket should trigger the logout message
            socket.disconnect();
            setTimeout(() => reject(new Error('Test timed out. No logout message received.')), 3000);
        });

        await logoutPromise;
        pass('Logout triggers a system chat message.');

    } catch (error) {
         // We expect this to fail right now.
        assert.fail('Test 2 FAILED (as expected): Logout did not trigger a chat message.');
    } finally {
        if(socket && socket.connected) socket.disconnect();
    }


    // --- Tests for inactivity timeouts are difficult to automate in a short script ---
    // --- They are better suited for manual testing or longer-running E2E test suites. ---
    // --- We will skip them for now to focus on what we can reliably test here. ---

    console.log('\n  Lifecycle tests complete. Failures are expected until features are implemented.');
}


runLifecycleTests().catch(err => {
    // This block catches the assertion failures and allows the script to finish gracefully.
    console.error(`\nTest Suite Failed: ${err.message}`);
    process.exit(1);
});