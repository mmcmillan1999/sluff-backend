const gameLogic = require('./logic');
const { RANKS_ORDER } = require('./constants');
const { getLegalMoves } = require('./legalMoves'); // --- MODIFIED: Import the new logic ---

// Helper function to get the rank value of a card for sorting.
const getRankValue = (card) => RANKS_ORDER.indexOf(gameLogic.getRank(card));

class BotPlayer {
    constructor(userId, name, table) {
        this.userId = userId;
        this.playerName = name;
        this.table = table;
    }

    makeBid() {
        // Simple strategy: always pass
        this.table.placeBid(this.userId, 'Pass');
    }

    chooseTrump() {
        // Default to Clubs
        this.table.chooseTrump(this.userId, 'C');
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

        // --- MODIFICATION: The entire card selection logic is now refactored ---

        // 1. Get all legal moves first. This prevents the bot from ever getting stuck.
        const isLeading = this.table.currentTrickCards.length === 0;
        const legalPlays = getLegalMoves(
            hand,
            isLeading,
            this.table.leadSuitCurrentTrick,
            this.table.trumpSuit,
            this.table.trumpBroken
        );

        // If for some reason there are no legal plays, exit to prevent a crash.
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