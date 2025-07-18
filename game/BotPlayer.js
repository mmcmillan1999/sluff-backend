const gameLogic = require('./logic');

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
        const discards = hand.slice(0, 3);
        this.table.submitFrogDiscards(this.userId, discards);
    }

    playCard() {
        const hand = this.table.hands[this.playerName];
        if (!hand || hand.length === 0) return;
        const leadSuit = this.table.leadSuitCurrentTrick;
        let playable = hand;
        if (leadSuit) {
            const follow = hand.filter(c => gameLogic.getSuit(c) === leadSuit);
            if (follow.length > 0) playable = follow;
        }
        const card = playable[Math.floor(Math.random() * playable.length)];
        this.table.playCard(this.userId, card);
    }
}

module.exports = BotPlayer;