const gameLogic = require('./logic');
const { RANKS_ORDER } = require('./constants');

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

        // 1. Determine the set of legally playable cards.
        const leadSuit = this.table.leadSuitCurrentTrick;
        let legalPlays = hand;
        if (leadSuit) {
            const cardsInLeadSuit = hand.filter(c => gameLogic.getSuit(c) === leadSuit);
            if (cardsInLeadSuit.length > 0) {
                legalPlays = cardsInLeadSuit;
            }
        }

        // 2. Sort legal cards from lowest rank to highest.
        legalPlays.sort((a, b) => getRankValue(a) - getRankValue(b));

        // 3. Apply playing strategy.
        let cardToPlay;
        if (this.table.currentTrickCards.length === 0) {
            // LOGIC A: I am leading the trick. Play my highest card.
            cardToPlay = legalPlays[legalPlays.length - 1];
        } else {
            // LOGIC B: I am not leading.
            const currentWinningPlay = gameLogic.determineTrickWinner(this.table.currentTrickCards, leadSuit, this.table.trumpSuit);
            
            // Find which of my legal cards can win the trick.
            const winningPlays = legalPlays.filter(myCard => {
                const potentialTrick = [...this.table.currentTrickCards, { card: myCard, userId: this.userId }];
                const winner = gameLogic.determineTrickWinner(potentialTrick, leadSuit, this.table.trumpSuit);
                return winner.userId === this.userId;
            });

            if (winningPlays.length > 0) {
                // I can win! Play the highest card I can win with.
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