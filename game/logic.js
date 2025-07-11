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
    const totalPayout = tableBuyIn * remainingPlayers.length; // All remaining players get their buy-in back
    const forfeitShare = tableBuyIn / remainingPlayers.length; // The forfeited buy-in is split evenly

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

// --- MODIFICATION: This is the final refactored function ---
async function calculateRoundScores(table, io, pool) { // Removed getPlayerNameByUserId from args
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
    
    // NOTE: Insurance score calculation remains in-memory as it doesn't involve tokens, only game points.
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
            
            // --- NEW DB LOGIC ---
            // Post transaction for the winner
            if (winnerPlayer) {
                await transactionManager.postTransaction(pool, {
                    userId: winnerPlayer.userId, gameId: gameId, type: 'win_payout',
                    amount: totalPot, description: `Won game ${gameId} on table ${table.tableName}`
                });
            }

            // Update stats for all players
            const statPromises = [];
            if(winnerPlayer) {
                statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [winnerPlayer.userId]));
            }
            losers.forEach(loser => {
                statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [loser.userId]));
            });
            await Promise.all(statPromises);
            
            // Finalize the game history record
            await transactionManager.updateGameRecordOutcome(pool, gameId, outcomeMessage);

            // Notify all players to sync their updated stats and balances
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
        insuranceDealWasMade: insurance.dealExecuted, insuranceDetails: insurance.dealExecuted ? insurance.executedDetails : null,
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
        // Not enough players to continue, treat as a wash
        // In a more advanced implementation, you might refund buy-ins here.
        // For now, we reset the table.
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