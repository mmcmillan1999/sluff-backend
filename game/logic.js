// backend/game/logic.js

const { RANKS_ORDER, BID_MULTIPLIERS, PLACEHOLDER_ID, CARD_POINT_VALUES, TABLE_COSTS } = require('./constants');
const transactionManager = require('../db/transactionManager');

// =================================================================
// PURE UTILITY FUNCTIONS
// =================================================================

const getSuit = (cardStr) => (cardStr ? cardStr.slice(-1) : null);
const getRank = (cardStr) => (cardStr ? cardStr.slice(0, -1) : null);

const calculateCardPoints = (cardsArray) => {
    if (!cardsArray || cardsArray.length === 0) return 0;
    return cardsArray.reduce((sum, cardString) => sum + (CARD_POINT_VALUES[getRank(cardString)] || 0), 0);
};

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


// =================================================================
// PURE CALCULATION FUNCTIONS (Called by Table Class)
// =================================================================

function calculateForfeitPayout(table, forfeitingPlayerName) {
    const remainingPlayers = Object.values(table.players).filter(p => 
        !p.isSpectator && 
        p.playerName !== forfeitingPlayerName
    );

    if (remainingPlayers.length === 0) return {};

    const tableBuyIn = TABLE_COSTS[table.theme] || 0;
    const forfeitedPot = tableBuyIn;
    const totalScoreOfRemaining = remainingPlayers.reduce((sum, player) => sum + (table.scores[player.playerName] || 0), 0);
    
    const payoutDetails = {};
    if (totalScoreOfRemaining > 0) {
        remainingPlayers.forEach(player => {
            const playerScore = table.scores[player.playerName] || 0;
            const proportion = playerScore / totalScoreOfRemaining;
            const shareOfPot = forfeitedPot * proportion;
            
            payoutDetails[player.playerName] = {
                totalGain: tableBuyIn + shareOfPot,
                buyInReturned: tableBuyIn,
                forfeitShare: shareOfPot,
            };
        });
    } else {
        const evenShare = forfeitedPot / remainingPlayers.length;
        remainingPlayers.forEach(player => {
            payoutDetails[player.playerName] = {
                totalGain: tableBuyIn + evenShare,
                buyInReturned: tableBuyIn,
                forfeitShare: evenShare,
            };
        });
    }

    return payoutDetails;
}

function calculateDrawSplitPayout(table) {
    const tableBuyIn = TABLE_COSTS[table.theme] || 0;
    const playersInOrder = Object.values(table.players)
        .filter(p => !p.isSpectator)
        .map(p => ({ name: p.playerName, score: table.scores[p.playerName] || 0, userId: p.userId }))
        .sort((a, b) => a.score - b.score);

    if (playersInOrder.length !== 3) {
        return { wash: true, players: playersInOrder };
    }

    const [lowest, ...others] = playersInOrder;
    const [p1, p2] = others.sort((a,b) => b.score - a.score);

    const lowestRecoveryPercentage = Math.max(0, lowest.score) / 120;
    const lowestRecoveryAmount = tableBuyIn * lowestRecoveryPercentage;
    const remainingPot = tableBuyIn - lowestRecoveryAmount;
    
    const totalScoreOfSplitters = p1.score + p2.score;
    let p1Share = 0;
    let p2Share = 0;

    if (totalScoreOfSplitters > 0) {
        p1Share = remainingPot * (p1.score / totalScoreOfSplitters);
        p2Share = remainingPot * (p2.score / totalScoreOfSplitters);
    } else {
        p1Share = remainingPot / 2;
        p2Share = remainingPot / 2;
    }

    const payouts = {
        [lowest.name]: { userId: lowest.userId, totalReturn: lowestRecoveryAmount },
        [p1.name]: { userId: p1.userId, totalReturn: tableBuyIn + p1Share },
        [p2.name]: { userId: p2.userId, totalReturn: tableBuyIn + p2Share },
    };

    return { wash: false, payouts };
}

function calculateRoundScoreDetails(table) {
    const { bidWinnerInfo, playerOrderActive, playerMode, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow, insurance, players, bidderTotalCardPoints } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const bidType = bidWinnerInfo.bid;
    const currentBidMultiplier = BID_MULTIPLIERS[bidType];
    
    const activePlayerNames = playerOrderActive.map(id => players[id].playerName);
    
    let widowPoints = 0;
    let widowForReveal = [...originalDealtWidow];
    if (bidType === "Frog") {
        widowPoints = calculateCardPoints(widowDiscardsForFrogBidder);
        widowForReveal = [...widowDiscardsForFrogBidder];
    } else if (bidType === "Solo" || bidType === "Heart Solo") {
        widowPoints = calculateCardPoints(originalDealtWidow);
    }

    let roundMessage = "";
    const pointChanges = {};
    activePlayerNames.forEach(p => pointChanges[p] = 0);
    if(playerMode === 3) pointChanges[PLACEHOLDER_ID] = 0;

    if (insurance.dealExecuted) {
        const agreement = insurance.executedDetails.agreement;
        pointChanges[agreement.bidderPlayerName] += agreement.bidderRequirement;
        for (const defenderName in agreement.defenderOffers) {
            pointChanges[defenderName] -= agreement.defenderOffers[defenderName];
        }
        roundMessage = `Insurance deal executed. Points exchanged based on agreement.`;
    } else {
        const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
        const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
        if (scoreDifferenceFrom60 === 0) { 
            roundMessage = `${bidWinnerName} scored exactly 60. No points exchanged.`; 
        } else if (bidderTotalCardPoints > 60) {
            let totalPointsGained = 0;
            activePlayerNames.forEach(pName => { 
                if (pName !== bidWinnerName) { 
                    // --- BUG FIX: Each defender only loses the exchange value ---
                    pointChanges[pName] -= exchangeValue;
                    totalPointsGained += exchangeValue; 
                } 
            });
            pointChanges[bidWinnerName] += totalPointsGained;
            roundMessage = `${bidWinnerName} succeeded! Gains ${totalPointsGained} points.`;
        } else { // Bidder failed
            let totalPointsLost = 0;
            const activeOpponents = activePlayerNames.filter(pName => pName !== bidWinnerName);
            activeOpponents.forEach(oppName => { 
                pointChanges[oppName] += exchangeValue; 
                totalPointsLost += exchangeValue; 
            });
            if (playerMode === 3) { 
                pointChanges[PLACEHOLDER_ID] += exchangeValue; 
                totalPointsLost += exchangeValue; 
            }
            else if (playerMode === 4) { 
                const dealerName = table.players[table.dealer]?.playerName;
                if(dealerName && !activeOpponents.includes(dealerName) && dealerName !== bidWinnerName) {
                    pointChanges[dealerName] += exchangeValue; 
                    totalPointsLost += exchangeValue;
                }
            }
            pointChanges[bidWinnerName] -= totalPointsLost;
            roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLost} points.`;
        }
    }
    
    const insuranceHindsight = calculateInsuranceHindsight(table, bidderTotalCardPoints, currentBidMultiplier);

    const finalBidderPoints = bidderTotalCardPoints;
    const finalDefenderPoints = 120 - finalBidderPoints;

    return {
        pointChanges,
        roundMessage,
        widowForReveal,
        insuranceHindsight,
        finalBidderPoints,
        finalDefenderPoints,
        widowPointsValue: widowPoints,
        bidType
    };
}


async function handleGameOver(table, pool) {
    let gameWinnerName = "N/A";
    const { playerOrderActive, scores, theme, gameId, players } = table;
    try {
        const tableCost = TABLE_COSTS[theme] || 0;
        const transactionPromises = [];
        const statPromises = [];

        const finalPlayerScores = playerOrderActive
            .map(id => players[id])
            .filter(p => p && !p.isBot)
            .map(p => ({ name: p.playerName, score: scores[p.playerName], userId: p.userId }))
            .sort((a, b) => b.score - a.score);
        
        if (finalPlayerScores.length === 3) {
            const [p1, p2, p3] = finalPlayerScores;
            if (p1.score > p2.score && p2.score > p3.score) {
                gameWinnerName = p1.name;
                transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 2, description: `Win and Payout from ${p3.name}` }));
                statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [p1.userId]));
                transactionPromises.push(transactionManager.postTransaction(pool, { userId: p2.userId, gameId, type: 'wash_payout', amount: tableCost, description: `Wash - Buy-in returned` }));
                statPromises.push(pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [p2.userId]));
                statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [p3.userId]));
            }
            else if (p1.score === p2.score && p2.score > p3.score) {
                gameWinnerName = `${p1.name} & ${p2.name}`;
                transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 1.5, description: `Win (tie) - Split payout from ${p3.name}` }));
                transactionPromises.push(transactionManager.postTransaction(pool, { userId: p2.userId, gameId, type: 'win_payout', amount: tableCost * 1.5, description: `Win (tie) - Split payout from ${p3.name}` }));
                statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = ANY($1::int[])", [[p1.userId, p2.userId]]));
                statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [p3.userId]));
            }
            else if (p1.score > p2.score && p2.score === p3.score) {
                gameWinnerName = p1.name;
                transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 3, description: `Win - Collects full pot` }));
                statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [p1.userId]));
                statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = ANY($1::int[])", [[p2.userId, p3.userId]]));
            }
            else {
                gameWinnerName = "3-Way Tie";
                finalPlayerScores.forEach(p => {
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p.userId, gameId, type: 'wash_payout', amount: tableCost, description: `3-Way Tie - Buy-in returned` }));
                    statPromises.push(pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [p.userId]));
                });
            }
        }
        
        await Promise.all(transactionPromises);
        await Promise.all(statPromises);
        await transactionManager.updateGameRecordOutcome(pool, gameId, `Game Over! Winner: ${gameWinnerName}`);
        
    } catch(err) {
        console.error("Database error during game over update:", err);
    }
    return { gameWinnerName };
}

function calculateInsuranceHindsight(table, bidderTotalCardPoints, currentBidMultiplier) {
    if (table.playerMode !== 3) return null;
    const { playerOrderActive, bidWinnerInfo, insurance, players } = table;
    const bidWinnerName = bidWinnerInfo.playerName;
    const insuranceHindsight = {};
    const activePlayerNames = playerOrderActive.map(id => players[id].playerName);
    const defenders = activePlayerNames.filter(p => p !== bidWinnerName);
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
         activePlayerNames.forEach(p => outcomeFromCards[p] = 0);
    }
    const potentialOutcomeFromDeal = {};
    const sumOfFinalOffers = Object.values(insurance.defenderOffers).reduce((sum, offer) => sum + offer, 0);
    potentialOutcomeFromDeal[bidWinnerName] = sumOfFinalOffers;
    const costPerDefenderForced = Math.round(insurance.bidderRequirement / defenders.length);
    defenders.forEach(def => { potentialOutcomeFromDeal[def] = -costPerDefenderForced; });
    const actualOutcomeFromDeal = {};
    if (insurance.dealExecuted) {
        const agreement = insurance.executedDetails.agreement;
        actualOutcomeFromDeal[agreement.bidderPlayerName] = agreement.bidderRequirement;
        for (const defName in agreement.defenderOffers) {
            actualOutcomeFromDeal[defName] = -agreement.defenderOffers[defName];
       }
    }
    activePlayerNames.forEach(pName => {
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
    return insuranceHindsight;
}

module.exports = {
    getSuit,
    getRank,
    determineTrickWinner,
    calculateRoundScoreDetails,
    handleGameOver,
    calculateForfeitPayout,
    calculateDrawSplitPayout,
    calculateCardPoints
};