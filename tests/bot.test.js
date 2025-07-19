const assert = require('assert');
const BotPlayer = require('../game/BotPlayer');

// Mock the table object the bot needs to interact with
class MockTable {
    constructor(hand) {
        this.hands = { 'TestBot': hand };
        this.currentHighestBidDetails = null; // Start with no bids
    }
    // Mock the placeBid function to just record the bid
    placeBid(userId, bid) {
        this.lastBid = bid;
    }
}

function runBotTests() {
    console.log('Running BotPlayer.js tests...');
    let testCounter = 1;
    const pass = (testName) => console.log(`  \u2713 Test ${testCounter++}: ${testName}`);

    // Test: Bot should bid Heart Solo
    let hand1 = ['AH', 'KH', 'QH', 'JH', '10H', 'AS', 'KS', 'QS', 'JS', '10S', '6C']; // High points, 5 hearts
    let mockTable1 = new MockTable(hand1);
    let bot1 = new BotPlayer(-1, 'TestBot', mockTable1);
    bot1.makeBid();
    assert.strictEqual(mockTable1.lastBid, 'Heart Solo');
    pass('Correctly bids Heart Solo.');

    // Test: Bot should bid Solo
    let hand2 = ['AC', 'KC', 'QC', 'JC', '10C', 'AD', 'KD', 'QD', 'JD', '10D', '6H']; // High points, 5 clubs
    let mockTable2 = new MockTable(hand2);
    let bot2 = new BotPlayer(-1, 'TestBot', mockTable2);
    bot2.makeBid();
    assert.strictEqual(mockTable2.lastBid, 'Solo');
    pass('Correctly bids Solo.');
    
    // Test: Bot should bid Frog
    // --- FIX: Constructed a hand that is unambiguously a Frog bid. ---
    // Has 4 hearts and 31 points. Does not meet the criteria for Solo or Heart Solo.
    let hand3 = ['AH', 'KH', 'QH', 'JH', 'AC', '6D', '7D', '8C', '9C', '6S', '7S'];
    let mockTable3 = new MockTable(hand3);
    let bot3 = new BotPlayer(-1, 'TestBot', mockTable3);
    bot3.makeBid();
    assert.strictEqual(mockTable3.lastBid, 'Frog');
    pass('Correctly bids Frog.');
    
    // Test: Bot should Pass
    let hand4 = ['6H', '7H', '8H', '9H', '6D', '7D', '8D', '9D', '6C', '7C', '8C']; // 0 points
    let mockTable4 = new MockTable(hand4);
    let bot4 = new BotPlayer(-1, 'TestBot', mockTable4);
    bot4.makeBid();
    assert.strictEqual(mockTable4.lastBid, 'Pass');
    pass('Correctly passes with a weak hand.');

    console.log('  \u2713 All BotPlayer.js tests passed!');
}

runBotTests();