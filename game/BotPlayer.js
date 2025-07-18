const gameLogic = require('./logic');
const { RANKS_ORDER, BID_HIERARCHY } = require('./constants');
const { getLegalMoves } = require('./legalMoves');

// Helper function to get the rank value of a card for sorting.
const getRankValue = (card) => RANKS_ORDER.indexOf(gameLogic.getRank(card));

class BotPlayer {
    constructor(userId, name, table) {
        this.userId = userId;
        this.playerName = name;
        this.table = table;
    }

    /**
     * Analyzes a hand to determine its point value and suit distribution.
     * @param {string[]} hand - The array of card strings in the hand.
     * @returns {{points: number, suits: {H: number, S: number, C: number, D: number}}}
     */
    _analyzeHand(hand) {
        if (!hand || hand.length === 0) {
            return { points: 0, suits: { H: 0, S: 0, C: 0, D: 0 } };
        }
        const points = gameLogic.calculateCardPoints(hand);
        const suits = { H: 0, S: 0, C: 0, D: 0 };
        for (const card of hand) {
            suits[gameLogic.getSuit(card)]++;
        }
        return { points, suits };
    }

    makeBid() {
        const hand = this.table.hands[this.playerName] || [];
        const handStats = this._analyzeHand(hand);
        const { points, suits } = handStats;

        let potentialBid = "Pass";

        // Evaluate for Heart Solo (highest bid)
        if ((points > 30 && suits.H >= 5) || (points > 40 && suits.H >= 4)) {
            potentialBid = "Heart Solo";
        }
        // Evaluate for other Solos
        else if ((points > 30 && (suits.S >= 5 || suits.C >= 5 || suits.D >= 5)) ||
                 (points > 40 && (suits.S >= 4 || suits.C >= 4 || suits.D >= 4))) {
            potentialBid = "Solo";
        }
        // Evaluate for Frog
        else if ((points > 30 && suits.H >= 4) || (points > 40 && suits.H >= 3)) {
            potentialBid = "Frog";
        }

        // Check if the potential bid is higher than the current bid on the table
        const currentBidDetails = this.table.currentHighestBidDetails;
        const currentBidLevel = currentBidDetails ? BID_HIERARCHY.indexOf(currentBidDetails.bid) : -1;
        const potentialBidLevel = BID_HIERARCHY.indexOf(potentialBid);

        if (potentialBidLevel > currentBidLevel) {
            this.table.placeBid(this.userId, potentialBid);
        } else {
            this.table.placeBid(this.userId, "Pass");
        }
    }

    chooseTrump() {
        const hand = this.table.hands[this.playerName] || [];
        const handStats = this._analyzeHand(hand);
        
        // Find the strongest suit (non-Heart) to be trump
        let bestSuit = 'C';
        let maxCount = 0;
        for (const suit of ['S', 'C', 'D']) {
            if (handStats.suits[suit] > maxCount) {
                maxCount = handStats.suits[suit];
                bestSuit = suit;
            }
        }
        this.table.chooseTrump(this.userId, bestSuit);
    }

    submitFrogDiscards() {
        const hand = this.table.hands[this.playerName] || [];
        // A slightly smarter discard: get rid of the lowest ranking cards
        const sortedHand = [...hand].sort((a, b) => getRankValue(a) - getRankValue(b));
        const discards = sortedHand.slice(0, 3);
        this.table.submitFrogDiscards(this.userId, discards);
    }

    playCard() {
        const hand = this.table.hands[this.playerName];
        if (!hand || hand.length === 0) return;

        // 1. Get all legal moves first. This prevents the bot from ever getting stuck.
        const isLeading = this.table.currentTrickCards.length === 0;
        const legalPlays = getLegalMoves(
            hand,
            isLeading,
            this.table.leadSuitCurrentTrick,
            this.table.trumpSuit,
            this.table.trumpBroken
        );

        if (legalPlays.length === 0) {
            console.error(`[${this.table.tableId}] Bot ${this.playerName} has no legal moves from hand: ${hand.join(', ')}`);
            return;
        }

        // 2. Sort the legal cards from lowest rank to highest.
        legalPlays.sort((a, b) => getRankValue(a) - getRankValue(b));

        // 3. Apply the playing strategy you outlined.
        let cardToPlay;
        if (isLeading) {
            // LOGIC A: I am leading the trick. Play my highest legal card.
            cardToPlay = legalPlays[legalPlays.length - 1];
        } else {
            // LOGIC B: I am not leading.
            // Find which of my legal cards can win the trick.
            const winningPlays = legalPlays.filter(myCard => {
                const potentialTrick = [...this.table.currentTrickCards, { card: myCard, userId: this.userId }];
                const winner = gameLogic.determineTrickWinner(potentialTrick, this.table.leadSuitCurrentTrick, this.table.trumpSuit);
                return winner.userId === this.userId;
            });

            if (winningPlays.length > 0) {
                // I can win! Play the highest card I can win with.
                winningPlays.sort((a, b) => getRankValue(a) - getRankValue(b));
                cardToPlay = winningPlays[winningPlays.length - 1];
            } else {
                // I cannot win. Play my lowest legal card to save good cards.
                cardToPlay = legalPlays[0];
            }
        }
        
        // 4. Play the chosen card.
        this.table.playCard(this.userId, cardToPlay);
    }
}

module.exports = BotPlayer;