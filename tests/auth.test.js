const assert = require('assert');
const fetch = require('node-fetch'); // --- ADD THIS LINE ---

const SERVER_URL = 'http://localhost:3000';

async function runAuthTests() {
    console.log('Running auth.js API tests...');

    const uniqueUser = `testuser_${Date.now()}`;
    const uniqueEmail = `${uniqueUser}@test.com`;
    const password = 'password123';

    // Test 1: Successful Registration
    let res = await fetch(`${SERVER_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUser, email: uniqueEmail, password }),
    });
    assert.strictEqual(res.status, 201, 'Test 1 Failed: Successful registration should return 201.');
    console.log('  \u2713 Test 1 Passed: Successful registration.');

    // Test 2: Attempt to register with the same username
    res = await fetch(`${SERVER_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUser, email: `another_${uniqueEmail}`, password }),
    });
    assert.strictEqual(res.status, 500, 'Test 2 Failed: Duplicate username registration should return 500.');
    console.log('  \u2713 Test 2 Passed: Duplicate username correctly rejected.');
    
    // Test 3: Attempt to register with the same email
    res = await fetch(`${SERVER_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `another_${uniqueUser}`, email: uniqueEmail, password }),
    });
    assert.strictEqual(res.status, 500, 'Test 3 Failed: Duplicate email registration should return 500.');
    console.log('  \u2713 Test 3 Passed: Duplicate email correctly rejected.');

    console.log('  \u2713 All auth.js tests passed!');
}

runAuthTests().catch(err => {
    console.error('Auth test suite failed:', err.message);
    process.exit(1);
});