// backend/game/legalMoves.js

const { getSuit } = require('./logic');

/**
 * Determines the set of legally playable cards from a player's hand based on the current game state.
 * @param {string[]} hand - The player's current hand of cards.
 * @param {boolean} isLeading - True if the player is leading the trick.
 * @param {string|null} leadSuit - The suit of the first card played in the trick (null if leading).
 * @param {string} trumpSuit - The current trump suit.
 * @param {boolean} trumpBroken - True if trump has been played in a previous trick.
 * @returns {string[]} An array of card strings representing the legal moves.
 */
function getLegalMoves(hand, isLeading, leadSuit, trumpSuit, trumpBroken) {
    if (isLeading) {
        // --- Lead-Out Condition ---
        const hasNonTrumpCards = hand.some(card => getSuit(card) !== trumpSuit);
        if (!trumpBroken && hasNonTrumpCards) {
            // Trump is not broken and player has other suits, so only non-trump cards are legal.
            return hand.filter(card => getSuit(card) !== trumpSuit);
        } else {
            // Trump is broken, OR the player only has trump cards. Any card is legal.
            return [...hand];
        }
    } else {
        // --- Non-Lead-Out (Following) Condition ---
        // 1. Do I have the suit that was led?
        const cardsInLeadSuit = hand.filter(card => getSuit(card) === leadSuit);
        if (cardsInLeadSuit.length > 0) {
            // Yes - I must follow suit.
            return cardsInLeadSuit;
        }

        // 2. No lead suit. Do I have trump?
        const trumpCards = hand.filter(card => getSuit(card) === trumpSuit);
        if (trumpCards.length > 0) {
            // Yes - Trump must be played.
            return trumpCards;
        }

        // 3. No lead suit and no trump. Any card can be played (sluff).
        return [...hand];
    }
}

module.exports = { getLegalMoves };