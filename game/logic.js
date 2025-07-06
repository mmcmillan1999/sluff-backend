// backend/game/logic.js (v8.0.0 - Major Refactor)

const {
    RANKS_ORDER,
    BID_MULTIPLIERS,
    PLACEHOLDER_ID,
    CARD_POINT_VALUES
} = require('./constants');

// --- UTILITY HELPERS (Moved from server.js) ---

const getSuit = (cardStr) => (cardStr ? cardStr.slice(-1) : null);
const getRank = (cardStr) => (cardStr ? cardStr.slice(0, -1) : null);

const calculateCardPoints = (cardsArray) => {
    if (!cardsArray || cardsArray.length === 0) return 0;
    return cardsArray.reduce((sum, cardString) => sum + (CARD_POINT_VALUES[getRank(cardString)] || 0), 0);
};

// --- CORE LOGIC FUNCTIONS ---

/**
 * Determines the winner of a completed trick based on lead suit and trump.
 * @param {Array} trickCards - Array of cards played in the trick.
 * @param {string} leadSuit - The suit that was led.
 * @param {string} trumpSuit - The current trump suit.
 * @returns {object} The winning play object { userId, playerName, card }.
 */
function determineTrickWinner(trickCards, leadSuit, trumpSuit) {
    let highestTrumpPlay = null;
    let highestLeadSuitPlay = null;

    for (const play of trickCards) {
        const cardSuit = getSuit(play.card);
        const cardRankIndex = RANKS_ORDER.indexOf(getRank(play.card));

        if (cardSuit === trumpSuit) {
            if (!highestTrumpPlay || cardRankIndex > RANKS_ORDER.indexOf(getRank(highestTrumpPlay.card))) {
                highestTrumpPlay = play;
            }
        } else if (cardSuit === leadSuit) {
            if (!highestLeadSuitPlay || cardRankIndex > RANKS_ORDER.indexOf(getRank(highestLeadSuitPlay.card))) {
                highestLeadSuitPlay = play;
            }
        }
    }
    return highestTrumpPlay || highestLeadSuitPlay;
}


/**
 * Transitions the game state to the main "Playing Phase" after bidding is complete.
 * @param {object} table - The game table state object.
 * @param {object} io - The Socket.IO server instance for emitting events.
 */
function transitionToPlayingPhase(table, io) {
    table.state = "Playing Phase";
    table.tricksPlayedCount = 0;
    table.trumpBroken = false;
    table.currentTrickCards = [];
    table.leadSuitCurrentTrick = null;
    table.lastCompletedTrick = null;
    table.trickLeaderName = table.bidWinnerInfo.playerName;
    table.trickTurnPlayerName = table.bidWinnerInfo.playerName;

    if (table.playerMode === 3) {
        table.insurance.isActive = true;
        const multiplier = BID_MULTIPLIERS[table.bidWinnerInfo.bid];
        table.insurance.bidMultiplier = multiplier;
        table.insurance.bidderPlayerName = table.bidWinnerInfo.playerName;
        table.insurance.bidderRequirement = 120 * multiplier;
        const defenders = table.playerOrderActive.filter(pName => pName !== table.bidWinnerInfo.playerName);
        defenders.forEach(defName => {
            table.insurance.defenderOffers[defName] = -60 * multiplier;
        });
    }
    io.to(table.tableId).emit("gameState", table);
}

/**
 * Calculates scores at the end of a round, creates the round summary, and sets the state for the next round.
 * @param {object} table - The game table state object.
 * @param {object} io - The Socket.IO server instance for emitting events.
 * @param {function} getPlayerNameByUserId - Helper to get player name from ID.
 */
function calculateRoundScores(table, io, getPlayerNameByUserId) {
    if (!table || !table.bidWinnerInfo) return;

    const { bidWinnerInfo, playerOrderActive, playerMode, scores, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow, insurance } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const bidType = bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    
    let bidderTotalCardPoints = 0;
    let defendersTotalCardPoints = 0;

    playerOrderActive.forEach(pName => {
        const capturedCards = (capturedTricks[pName] || []).flat();
        const playerTrickPoints = calculateCardPoints(capturedCards);
        if (pName === bidWinnerName) {
            bidderTotalCardPoints += playerTrickPoints;
        } else {
            defendersTotalCardPoints += playerTrickPoints;
        }
    });
    
    let widowPoints = 0;
    let widowForReveal = [...originalDealtWidow];
    if (bidType === "Frog") {
        widowPoints = calculateCardPoints(widowDiscardsForFrogBidder);
        widowForReveal = [...widowDiscardsForFrogBidder];
        bidderTotalCardPoints += widowPoints;
    } else if (bidType === "Solo") {
        widowPoints = calculateCardPoints(originalDealtWidow);
        bidderTotalCardPoints += widowPoints;
    } else if (bidType === "Heart Solo") {
        widowPoints = calculateCardPoints(originalDealtWidow);
        if (table.trickLeaderName === bidWinnerName) {
            bidderTotalCardPoints += widowPoints;
        } else {
            defendersTotalCardPoints += widowPoints;
        }
    }

    let roundMessage = "";
    let insuranceHindsight = null;

    if (insurance.dealExecuted) {
        const agreement = insurance.executedDetails.agreement;
        scores[agreement.bidderPlayerName] += agreement.bidderRequirement;
        for (const defenderName in agreement.defenderOffers) {
            scores[defenderName] -= agreement.defenderOffers[defenderName];
        }
        roundMessage = `Insurance deal executed. Points exchanged based on agreement.`;
    } else {
        const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
        const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
        if (scoreDifferenceFrom60 === 0) { roundMessage = `${bidWinnerName} scored exactly 60. No points exchanged.`; } 
        else if (bidderTotalCardPoints > 60) {
            let totalPointsGained = 0;
            playerOrderActive.forEach(pName => { if (pName !== bidWinnerName) { scores[pName] -= exchangeValue; totalPointsGained += exchangeValue; } });
            scores[bidWinnerName] += totalPointsGained;
            roundMessage = `${bidWinnerName} succeeded! Gains ${totalPointsGained} points.`;
        } else {
            let totalPointsLost = 0;
            const activeOpponents = playerOrderActive.filter(pName => pName !== bidWinnerName);
            activeOpponents.forEach(oppName => { scores[oppName] += exchangeValue; totalPointsLost += exchangeValue; });
            if (playerMode === 3) { scores[PLACEHOLDER_ID] += exchangeValue; totalPointsLost += exchangeValue; }
            else if (playerMode === 4) { const dealerName = getPlayerNameByUserId(table.dealer, table); if (dealerName && !playerOrderActive.includes(dealerName)) { scores[dealerName] += exchangeValue; totalPointsLost += exchangeValue; } }
            scores[bidWinnerName] -= totalPointsLost;
            roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLost} points.`;
        }
    }
    
    if (playerMode === 3) {
        insuranceHindsight = {};
        const defenders = playerOrderActive.filter(p => p !== bidWinnerName);
        
        const outcomeFromCards = {};
        const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
        const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
        if (scoreDifferenceFrom60 > 0) {
            outcomeFromCards[bidWinnerName] = exchangeValue * 2;
            defenders.forEach(def => outcomeFromCards[def] = -exchangeValue);
        } else if (scoreDifferenceFrom60 < 0) {
            outcomeFromCards[bidWinnerName] = -(exchangeValue * 2);
            defenders.forEach(def => outcomeFromCards[def] = exchangeValue);
        } else {
             playerOrderActive.forEach(p => outcomeFromCards[p] = 0);
        }

        const potentialOutcomeFromDeal = {};
        const sumOfFinalOffers = Object.values(insurance.defenderOffers).reduce((sum, offer) => sum + offer, 0);
        potentialOutcomeFromDeal[bidWinnerName] = sumOfFinalOffers;
        const costPerDefenderForced = Math.round(insurance.bidderRequirement / defenders.length);
        defenders.forEach(def => {
            potentialOutcomeFromDeal[def] = -costPerDefenderForced;
        });

        const actualOutcomeFromDeal = {};
        if (insurance.dealExecuted) {
            const agreement = insurance.executedDetails.agreement;
            actualOutcomeFromDeal[agreement.bidderPlayerName] = agreement.bidderRequirement;
            for (const defName in agreement.defenderOffers) {
                actualOutcomeFromDeal[defName] = -agreement.defenderOffers[defName];
           }
        }

        playerOrderActive.forEach(pName => {
            let actualPoints, potentialPoints;
            if (insurance.dealExecuted) {
                actualPoints = actualOutcomeFromDeal[pName];
                potentialPoints = outcomeFromCards[pName];
            } else {
                actualPoints = outcomeFromCards[pName];
                potentialPoints = potentialOutcomeFromDeal[pName];
            }
            
            insuranceHindsight[pName] = {
                actualPoints: actualPoints || 0,
                actualReason: insurance.dealExecuted ? "Insurance Deal" : "Card Outcome",
                potentialPoints: potentialPoints || 0,
                potentialReason: insurance.dealExecuted ? "Played it Out" : "Taken Insurance Deal",
                hindsightValue: (actualPoints || 0) - (potentialPoints || 0)
            };
        });
    }

    let isGameOver = false;
    let gameWinner = null;
    if(Object.values(scores).filter(s => typeof s === 'number').some(score => score <= 0)) {
        isGameOver = true;
        const finalPlayerScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID);
        if (finalPlayerScores.length > 0) {
            gameWinner = finalPlayerScores.sort((a,b) => b[1] - a[1])[0][0];
        }
        roundMessage += ` GAME OVER! Winner: ${gameWinner}.`;
    }

    table.roundSummary = {
        message: roundMessage,
        bidWinnerName,
        bidderCardPoints: bidderTotalCardPoints,
        defenderCardPoints: defendersTotalCardPoints,
        finalScores: { ...scores },
        isGameOver,
        gameWinner,
        dealerOfRoundId: table.dealer,
        widowForReveal,
        insuranceDealWasMade: insurance.dealExecuted,
        insuranceDetails: insurance.dealExecuted ? insurance.executedDetails : null,
        insuranceHindsight: insuranceHindsight,
        allTricks: table.capturedTricks
    };
    
    table.state = isGameOver ? "Game Over" : "Awaiting Next Round Trigger";
    io.to(table.tableId).emit("gameState", table);
}

/**
 * Sets up the table for the next round of play.
 * @param {object} table - The game table state object.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} helpers - An object containing helper functions like { resetTable, getPlayerNameByUserId, initializeNewRoundState, shuffle }.
 */
function prepareNextRound(table, io, helpers) {
    if (!table || !table.gameStarted) return;
    const { resetTable, getPlayerNameByUserId, initializeNewRoundState, shuffle } = helpers;

    const allPlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator && !table.players[pId].disconnected).map(Number);
    if (allPlayerIds.length < 3) return resetTable(table.tableId);
    
    const lastDealerId = table.dealer;
    const lastDealerIndex = allPlayerIds.indexOf(lastDealerId);
    const nextDealerIndex = (lastDealerIndex + 1) % allPlayerIds.length;
    table.dealer = allPlayerIds[nextDealerIndex];
    
    const currentDealerIndex = allPlayerIds.indexOf(table.dealer);
    table.playerOrderActive = [];
    const numPlayers = allPlayerIds.length;
    for (let i = 1; i <= numPlayers; i++) {
        const playerIndex = (currentDealerIndex + i) % numPlayers;
        const playerId = allPlayerIds[playerIndex];
        if (table.playerMode === 4 && playerId === table.dealer) continue;
        table.playerOrderActive.push(getPlayerNameByUserId(playerId, table));
    }

    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    io.to(table.tableId).emit("gameState", table);
}

/**
 * Resolves the bidding phase, determining the winner and transitioning to the next state.
 * @param {object} table - The game table state object.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} helpers - An object of helper functions.
 */
function resolveBiddingFinal(table, io, helpers) {
    if (!table.currentHighestBidDetails) {
        table.state = "AllPassWidowReveal";
        io.to(table.tableId).emit("gameState", table);
        setTimeout(() => {
            // Re-fetch table from tables object in case it was reset
            const currentTable = helpers.getTableById(table.tableId); 
            if(currentTable && currentTable.state === "AllPassWidowReveal"){
                prepareNextRound(currentTable, io, helpers);
            }
        }, 5000);
        return;
    }

    table.bidWinnerInfo = { ...table.currentHighestBidDetails };
    const bid = table.bidWinnerInfo.bid;

    if (bid === "Frog") { 
        table.trumpSuit = "H"; 
        table.state = "Frog Widow Exchange";
        table.revealedWidowForFrog = [...table.widow];
        const bidderHand = table.hands[table.bidWinnerInfo.playerName];
        table.hands[table.bidWinnerInfo.playerName] = [...bidderHand, ...table.widow];
    } 
    else if (bid === "Heart Solo") { 
        table.trumpSuit = "H"; 
        transitionToPlayingPhase(table, io);
    } 
    else if (bid === "Solo") { 
        table.state = "Trump Selection";
    }

    io.to(table.tableId).emit("gameState", table);
    table.originalFrogBidderId = null;
    table.soloBidMadeAfterFrog = false;
}

/**
 * Specifically handles the logic for a "Frog Upgrade" scenario in bidding.
 * @param {object} table - The game table state object.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} helpers - An object of helper functions.
 */
function checkForFrogUpgrade(table, io, helpers) {
    if (table.soloBidMadeAfterFrog) {
        table.state = "Awaiting Frog Upgrade Decision";
        table.biddingTurnPlayerName = helpers.getPlayerNameByUserId(table.originalFrogBidderId, table);
    } else {
        resolveBiddingFinal(table, io, helpers);
    }
    io.to(table.tableId).emit("gameState", table);
}


module.exports = {
    determineTrickWinner,
    transitionToPlayingPhase,
    calculateRoundScores,
    prepareNextRound,
    resolveBiddingFinal,
    checkForFrogUpgrade,
    getSuit, // Exporting helpers that might be needed elsewhere
    getRank,
};
