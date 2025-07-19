const assert = require('assert');
const { getLegalMoves } = require('../game/legalMoves');

function runLegalMovesTests() {
    console.log('Running legalMoves.js tests...');
    let testCounter = 1;
    const pass = (testName) => console.log(`  \u2713 Test ${testCounter++}: ${testName}`);

    // Scenario 1: Must Follow Suit
    let hand = ['7D', '8D', '9S', '10C'];
    let legal = getLegalMoves(hand, false, 'D', 'H', true);
    assert.deepStrictEqual(legal.sort(), ['7D', '8D'].sort());
    pass('Must follow suit.');

    // Scenario 2: Cannot Follow, Must Play Trump
    hand = ['7S', '8C', '9S', 'JH'];
    legal = getLegalMoves(hand, false, 'D', 'H', true);
    assert.deepStrictEqual(legal, ['JH']);
    pass('Must play trump.');

    // Scenario 3: Cannot Follow or Trump, Can Sluff Anything
    hand = ['7S', '8C', '9S', 'JC'];
    legal = getLegalMoves(hand, false, 'D', 'H', true);
    assert.deepStrictEqual(legal.sort(), hand.sort());
    pass('Can sluff any card.');

    // Scenario 4: Leading, Trump Not Broken, Has Other Suits
    hand = ['7D', '8H', '9S'];
    legal = getLegalMoves(hand, true, null, 'H', false);
    assert.deepStrictEqual(legal.sort(), ['7D', '9S'].sort());
    pass('Cannot lead trump if not broken.');

    // Scenario 5: Leading, Trump Not Broken, Only Has Trump
    hand = ['7H', '8H', '9H'];
    legal = getLegalMoves(hand, true, null, 'H', false);
    assert.deepStrictEqual(legal.sort(), hand.sort());
    pass('Can lead trump if it is the only suit.');

    // Scenario 6: Leading, Trump Is Broken
    hand = ['7D', '8H', '9S'];
    legal = getLegalMoves(hand, true, null, 'H', true);
    assert.deepStrictEqual(legal.sort(), hand.sort());
    pass('Can lead any card once trump is broken.');

    console.log('  \u2713 All legalMoves.js tests passed!');
}

runLegalMovesTests();