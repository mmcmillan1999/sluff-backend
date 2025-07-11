// backend/game/logic.js

const {
    RANKS_ORDER,
    BID_MULTIPLIERS,
    PLACEHOLDER_ID,
    CARD_POINT_VALUES,
    TABLE_COSTS
} = require('./constants');
const transactionManager = require('../db/transactionManager');

// --- UTILITY HELPERS ---

const getSuit = (cardStr) => (cardStr ? cardStr.slice(-1) : null);
const getRank = (cardStr) => (cardStr ? cardStr.slice(0, -1) : null);

const calculateCardPoints = (cardsArray) => {
    if (!cardsArray || cardsArray.length === 0) return 0;
    return cardsArray.reduce((sum, cardString) => sum + (CARD_POINT_VALUES[getRank(cardString)] || 0), 0);
};

// --- CORE LOGIC FUNCTIONS ---

function calculateForfeitPayout(table, forfeitingPlayerName) {
    const remainingPlayers = Object.values(table.players).filter(p => 
        !p.isSpectator && 
        p.playerName !== forfeitingPlayerName
    );

    if (remainingPlayers.length === 0) return {};

    const tableBuyIn = TABLE_COSTS[table.theme] || 0;
    const totalPayout = tableBuyIn * remainingPlayers.length;
    const forfeitShare = tableBuyIn / remainingPlayers.length;

    const payoutDetails = {};
    remainingPlayers.forEach(player => {
        payoutDetails[player.playerName] = {
            totalGain: Math.round((tableBuyIn + forfeitShare) * 100) / 100,
        };
    });

    return payoutDetails;
}


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

async function calculateRoundScores(table, io, pool) {
    if (!table || !table.bidWinnerInfo) return;

    const { bidWinnerInfo, playerOrderActive, playerMode, scores, capturedTricks, widowDiscardsForFrogBidder, originalDealtWidow, insurance, theme, gameId } = table;
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
            else if (playerMode === 4) { const dealer = Object.values(table.players).find(p => p.userId === table.dealer); if (dealer) { scores[dealer.playerName] += exchangeValue; totalPointsLost += exchangeValue; } }
            scores[bidWinnerName] -= totalPointsLost;
            roundMessage = `${bidWinnerName} failed. Loses ${totalPointsLost} points.`;
        }
    }

    // --- THIS IS THE FIX: Re-adding the hindsight calculation ---
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
    
    let isGameOver = Object.values(scores).filter(s => typeof s === 'number').some(score => score <= 0);
    let gameWinnerName = null;
    
    if (isGameOver) {
        const finalPlayerScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID && !key.includes('undefined'));
        if (finalPlayerScores.length > 0) {
            gameWinnerName = finalPlayerScores.sort((a,b) => b[1] - a[1])[0][0];
        }
        const outcomeMessage = `Game Over! Winner: ${gameWinnerName}`;
        roundMessage += ` ${outcomeMessage}.`;
        
        try {
            const tableCost = TABLE_COSTS[theme] || 0;
            const totalPot = tableCost * playerOrderActive.length;

            const winnerPlayer = Object.values(table.players).find(p => p.playerName === gameWinnerName);
            const losers = Object.values(table.players).filter(p => p.playerName !== gameWinnerName && !p.isSpectator);
            
            if (winnerPlayer) {
                await transactionManager.postTransaction(pool, {
                    userId: winnerPlayer.userId, gameId: gameId, type: 'win_payout',
                    amount: totalPot, description: `Won game ${gameId} on table ${table.tableName}`
                });
            }

            const statPromises = [];
            if(winnerPlayer) {
                statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [winnerPlayer.userId]));
            }
            losers.forEach(loser => {
                statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [loser.userId]));
            });
            await Promise.all(statPromises);
            
            await transactionManager.updateGameRecordOutcome(pool, gameId, outcomeMessage);

            Object.values(table.players).forEach(p => {
                const playerSocket = io.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit("requestUserSync");
            });

        } catch(err) {
            console.error("Database error during game over update:", err);
        }
    }

    table.roundSummary = {
        message: roundMessage, finalScores: { ...scores }, isGameOver,
        gameWinner: gameWinnerName, dealerOfRoundId: table.dealer, widowForReveal,
        insuranceDealWasMade: insurance.dealExecuted, 
        insuranceDetails: insurance.dealExecuted ? insurance.executedDetails : null,
        insuranceHindsight: insuranceHindsight, // <-- Now correctly included
        allTricks: table.capturedTricks
    };
    
    table.state = isGameOver ? "Game Over" : "Awaiting Next Round Trigger";
    io.to(table.tableId).emit("gameState", table);
}


function prepareNextRound(table, io, helpers) {
    if (!table || !table.gameStarted) return;
    const { getPlayerNameByUserId, initializeNewRoundState } = helpers;

    const allPlayerIds = Object.keys(table.players).filter(pId => !table.players[pId].isSpectator && !table.players[pId].disconnected).map(pId => Number(pId));
    if (allPlayerIds.length < 3) {
        helpers.resetTable(table.tableId);
        return;
    };
    
    const lastDealerId = table.dealer;
    const allPlayerUserIdsInOrder = Object.values(table.players)
        .filter(p => allPlayerIds.includes(p.userId))
        .map(p => p.userId);
    const lastDealerIndex = allPlayerUserIdsInOrder.indexOf(lastDealerId);
    const nextDealerIndex = (lastDealerIndex + 1) % allPlayerUserIdsInOrder.length;
    table.dealer = allPlayerUserIdsInOrder[nextDealerIndex];
    
    const currentDealerIndex = allPlayerUserIdsInOrder.indexOf(table.dealer);
    table.playerOrderActive = [];
    const numPlayers = allPlayerUserIdsInOrder.length;
    for (let i = 1; i <= numPlayers; i++) {
        const playerIndex = (currentDealerIndex + i) % numPlayers;
        const playerId = allPlayerUserIdsInOrder[playerIndex];
        if (table.playerMode === 4 && playerId === table.dealer) continue;
        table.playerOrderActive.push(getPlayerNameByUserId(playerId, table));
    }

    initializeNewRoundState(table);
    table.state = "Dealing Pending";
    io.to(table.tableId).emit("gameState", table);
}


function resolveBiddingFinal(table, io, helpers) {
    if (!table.currentHighestBidDetails) {
        table.state = "AllPassWidowReveal";
        io.to(table.tableId).emit("gameState", table);
        setTimeout(() => {
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
    getSuit,
    getRank,
    calculateForfeitPayout,
};
