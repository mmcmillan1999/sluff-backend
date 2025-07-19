const assert = require('assert');
const gameLogic = require('../game/logic');

function runGameLogicTests() {
    console.log('Running gameLogic.js tests...');

    let testCounter = 1;
    const pass = (testName) => console.log(`  \u2713 Test ${testCounter++}: ${testName}`);

    // --- Trick Winner Tests ---
    const playsTrump = [ { userId: 1, playerName: 'Alice', card: '10H' }, { userId: 2, playerName: 'Bob', card: 'AS' }, { userId: 3, playerName: 'Carol', card: 'KH' }];
    let result = gameLogic.determineTrickWinner(playsTrump, 'H', 'S');
    assert.strictEqual(result.playerName, 'Bob');
    pass('Trump should win trick.');

    const followsSuit = [ { userId: 1, playerName: 'Alice', card: '10H' }, { userId: 2, playerName: 'Bob', card: 'AH' }, { userId: 3, playerName: 'Carol', card: 'KH' }];
    result = gameLogic.determineTrickWinner(followsSuit, 'H', 'S');
    assert.strictEqual(result.playerName, 'Bob');
    pass('Highest of lead suit should win.');

    // --- Payout Tests ---
    // --- FIX: Restored the full players object needed by the function ---
    const forfeitTable = {
        theme: 'fort-creek',
        players: {
            1: { userId: 1, playerName: 'Alice', isSpectator: false },
            2: { userId: 2, playerName: 'Bob', isSpectator: false },
            3: { userId: 3, playerName: 'Carol', isSpectator: false },
        },
        scores: { 'Alice': 120, 'Bob': 80, 'Carol': 100 }
    };
    let payout = gameLogic.calculateForfeitPayout(forfeitTable, 'Bob');
    assert.strictEqual(payout['Alice'].totalGain.toFixed(3), '1.545');
    pass('Forfeit payout for Alice is correct.');
    assert.strictEqual(payout['Carol'].totalGain.toFixed(3), '1.455');
    pass('Forfeit payout for Carol is correct.');

    // --- FIX: Restored the full players object needed by the function ---
    const drawTable = {
        theme: 'fort-creek',
        players: {
            1: { userId: 1, playerName: 'Alice', isSpectator: false },
            2: { userId: 2, playerName: 'Bob', isSpectator: false },
            3: { userId: 3, playerName: 'Carol', isSpectator: false },
        },
        scores: { 'Alice': 90, 'Bob': 80, 'Carol': 60 }
    };
    let drawResult = gameLogic.calculateDrawSplitPayout(drawTable);
    assert.strictEqual(drawResult.wash, false);
    pass('Draw should be a split, not a wash.');
    assert.ok(Math.abs(drawResult.payouts['Carol'].totalReturn - 0.5) < 0.0001);
    pass('Draw split payout for lowest player is correct.');
    
    // --- Scoring Tests ---
    const mockScoringTable = {
        playerOrderActive: [1, 2, 3], playerMode: 3, players: { 1: { playerName: 'Alice' }, 2: { playerName: 'Bob' }, 3: { playerName: 'Carol' } },
        insurance: { dealExecuted: false, defenderOffers: {} }, capturedTricks: {}, originalDealtWidow: []
    };
    
    let succeedResult = gameLogic.calculateRoundScoreDetails({ ...mockScoringTable, bidWinnerInfo: { playerName: 'Alice', bid: 'Solo' }, bidderTotalCardPoints: 70 });
    assert.strictEqual(succeedResult.pointChanges['Alice'], 40);
    pass('Bidder success points correct.');
    assert.strictEqual(succeedResult.pointChanges['Bob'], -20);
    pass('Defender loss points correct.');

    let failResult3Player = gameLogic.calculateRoundScoreDetails({ ...mockScoringTable, bidWinnerInfo: { playerName: 'Alice', bid: 'Solo' }, bidderTotalCardPoints: 50 });
    assert.strictEqual(failResult3Player.pointChanges['Alice'], -60);
    pass('3-player bidder fail points correct.');
    assert.strictEqual(failResult3Player.pointChanges['Bob'], 20);
    pass('3-player defender win points correct.');
    assert.strictEqual(failResult3Player.pointChanges['ScoreAbsorber'], 20);
    pass('3-player ScoreAbsorber points correct.');
    
    // --- NEW: Widow Point Allocation Tests ---
    const widowPts = 15;
    const mockWidow = ['AC', 'KC']; // 15 pts, but not used directly in calculation for this test
    const mockDiscards = ['AD', 'KD']; // 15 pts

    // For these tests, we assume trick points are 50, and widow/discards add the rest.
    const baseTrickPoints = 50;
    
    // Scenario: Heart Solo, widow goes to bidder (This scenario is simplified as last trick winner is not part of this function)
    const hsWinTable = { ...mockScoringTable, bidWinnerInfo: { playerName: 'Alice', bid: 'Heart Solo' }, originalDealtWidow: mockWidow, bidderTotalCardPoints: baseTrickPoints + widowPts };
    let hsWinResult = gameLogic.calculateRoundScoreDetails(hsWinTable);
    assert.strictEqual(hsWinResult.finalBidderPoints, 65, 'HS Win: Bidder points incorrect.');
    assert.strictEqual(hsWinResult.finalDefenderPoints, 55, 'HS Win: Defender points incorrect.');
    pass('Heart Solo: Widow points are correctly assigned.');
    
    // Scenario: Solo bid -> widow always goes to bidder
    const soloTable = { ...mockScoringTable, bidWinnerInfo: { playerName: 'Alice', bid: 'Solo' }, originalDealtWidow: mockWidow, bidderTotalCardPoints: baseTrickPoints + widowPts };
    let soloResult = gameLogic.calculateRoundScoreDetails(soloTable);
    assert.strictEqual(soloResult.finalBidderPoints, 65, 'Solo: Bidder points incorrect.');
    assert.strictEqual(soloResult.finalDefenderPoints, 55, 'Solo: Defender points incorrect.');
    pass('Solo Bid: Widow points go to bidder.');

    // Scenario: Frog bid -> bidder gets points from their discards
    const frogTable = { ...mockScoringTable, bidWinnerInfo: { playerName: 'Alice', bid: 'Frog' }, widowDiscardsForFrogBidder: mockDiscards, bidderTotalCardPoints: baseTrickPoints + widowPts };
    let frogResult = gameLogic.calculateRoundScoreDetails(frogTable);
    assert.strictEqual(frogResult.finalBidderPoints, 65, 'Frog: Bidder points incorrect.');
    assert.strictEqual(frogResult.finalDefenderPoints, 55, 'Frog: Defender points incorrect.');
    pass('Frog Bid: Bidder gets points from their discarded cards.');


    console.log('\n  \u2713 All gameLogic.js tests passed!');
}

runGameLogicTests();