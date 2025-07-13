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
    } else if (bidType === "Solo" || bidType === "Heart Solo") {
        widowPoints = calculateCardPoints(originalDealtWidow);
        if (bidType === "Heart Solo" && table.trickLeaderName !== bidWinnerName) {
            defendersTotalCardPoints += widowPoints;
        } else {
            bidderTotalCardPoints += widowPoints;
        }
    }

    if (insurance.dealExecuted) {
        const agreement = insurance.executedDetails.agreement;
        scores[agreement.bidderPlayerName] += agreement.bidderRequirement;
        for (const defenderName in agreement.defenderOffers) {
            scores[defenderName] -= agreement.defenderOffers[defenderName];
        }
    } else {
        const scoreDifferenceFrom60 = bidderTotalCardPoints - 60;
        const exchangeValue = Math.abs(scoreDifferenceFrom60) * currentBidMultiplier;
        if (scoreDifferenceFrom60 > 0) {
            let totalPointsGained = 0;
            playerOrderActive.forEach(pName => { if (pName !== bidWinnerName) { scores[pName] -= exchangeValue; totalPointsGained += exchangeValue; } });
            scores[bidWinnerName] += totalPointsGained;
        } else if (scoreDifferenceFrom60 < 0) {
            let totalPointsLost = 0;
            const activeOpponents = playerOrderActive.filter(pName => pName !== bidWinnerName);
            activeOpponents.forEach(oppName => { scores[oppName] += exchangeValue; totalPointsLost += exchangeValue; });
            if (playerMode === 3) { scores[PLACEHOLDER_ID] += exchangeValue; totalPointsLost += exchangeValue; }
            else if (playerMode === 4) { const dealer = Object.values(table.players).find(p => p.userId === table.dealer); if (dealer) { scores[dealer.playerName] += exchangeValue; totalPointsLost += exchangeValue; } }
            scores[bidWinnerName] -= totalPointsLost;
        }
    }
    
    let isGameOver = Object.values(scores).filter(s => typeof s === 'number').some(score => score <= 0);
    let gameWinnerName = null;
    let outcomeMessage = `Round Complete.`;
    
    if (isGameOver) {
        try {
            const tableCost = TABLE_COSTS[theme] || 0;
            const transactionPromises = [];
            const statPromises = [];

            const finalPlayerScores = playerOrderActive
                .map(pName => ({ name: pName, score: scores[pName], userId: Object.values(table.players).find(p=>p.playerName === pName).userId }))
                .sort((a, b) => b.score - a.score);

            if (finalPlayerScores.length === 3) {
                const [p1, p2, p3] = finalPlayerScores;

                if (p1.score > p2.score && p2.score > p3.score) {
                    gameWinnerName = p1.name;
                    outcomeMessage = `${p1.name} wins, ${p2.name} washes, ${p3.name} loses.`;
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 2, description: `Win and Payout from ${p3.name}` }));
                    statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [p1.userId]));
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p2.userId, gameId, type: 'wash_payout', amount: tableCost, description: `Wash - Buy-in returned` }));
                    statPromises.push(pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [p2.userId]));
                    statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [p3.userId]));
                }
                else if (p1.score === p2.score && p2.score > p3.score) {
                    gameWinnerName = `${p1.name} & ${p2.name}`;
                    outcomeMessage = `${p1.name} & ${p2.name} tie for first, splitting ${p3.name}'s buy-in.`;
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 1.5, description: `Win (tie) - Split payout from ${p3.name}` }));
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p2.userId, gameId, type: 'win_payout', amount: tableCost * 1.5, description: `Win (tie) - Split payout from ${p3.name}` }));
                    statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = ANY($1::int[])", [[p1.userId, p2.userId]]));
                    statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [p3.userId]));
                }
                else if (p1.score > p2.score && p2.score === p3.score) {
                    gameWinnerName = p1.name;
                    outcomeMessage = `${p1.name} wins. ${p2.name} & ${p3.name} tie for last.`;
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: p1.userId, gameId, type: 'win_payout', amount: tableCost * 3, description: `Win - Collects full pot` }));
                    statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [p1.userId]));
                    statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = ANY($1::int[])", [[p2.userId, p3.userId]]));
                }
                else {
                    gameWinnerName = "3-Way Tie";
                    outcomeMessage = `A 3-way tie results in a wash.`;
                    finalPlayerScores.forEach(p => {
                        transactionPromises.push(transactionManager.postTransaction(pool, { userId: p.userId, gameId, type: 'wash_payout', amount: tableCost, description: `3-Way Tie - Buy-in returned` }));
                        statPromises.push(pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [p.userId]));
                    });
                }
            } else {
                const fallbackScores = Object.entries(scores).filter(([key]) => key !== PLACEHOLDER_ID).sort((a,b) => b[1] - a[1]);
                if(fallbackScores.length > 0) gameWinnerName = fallbackScores[0][0];
                outcomeMessage = `Game Over! Winner: ${gameWinnerName}`;
                const winnerPlayer = Object.values(table.players).find(p => p.playerName === gameWinnerName);
                if (winnerPlayer) {
                    const totalPot = tableCost * playerOrderActive.length;
                    transactionPromises.push(transactionManager.postTransaction(pool, { userId: winnerPlayer.userId, gameId: gameId, type: 'win_payout', amount: totalPot, description: `Won game ${gameId}`}));
                    statPromises.push(pool.query("UPDATE users SET wins = wins + 1 WHERE id = $1", [winnerPlayer.userId]));
                    const losers = Object.values(table.players).filter(p => p.playerName !== gameWinnerName && !p.isSpectator);
                    losers.forEach(loser => statPromises.push(pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [loser.userId])));
                }
            }
            
            await Promise.all(transactionPromises);
            await Promise.all(statPromises);
            
            await transactionManager.updateGameRecordOutcome(pool, gameId, `Game Over - ${outcomeMessage}`);
            Object.values(table.players).forEach(p => io.sockets.sockets.get(p.socketId)?.emit("requestUserSync"));
        } catch(err) {
            console.error("Database error during game over update:", err);
        }
    }

    const playerIds = Object.keys(table.players).map(id => Number(id));
    const playerTokens = {};
    if (playerIds.length > 0) {
        const tokenQuery = `SELECT user_id, SUM(amount) as tokens FROM transactions WHERE user_id = ANY($1::int[]) GROUP BY user_id;`;
        const tokenResult = await pool.query(tokenQuery, [playerIds]);
        const userIdToNameMap = Object.values(table.players).reduce((acc, player) => { acc[player.userId] = player.playerName; return acc; }, {});
        tokenResult.rows.forEach(row => {
            const playerName = userIdToNameMap[row.user_id];
            if (playerName) playerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2);
        });
    }

    table.roundSummary = {
        message: isGameOver ? `Game Over! ${outcomeMessage}` : outcomeMessage,
        finalScores: { ...scores }, isGameOver, gameWinner: gameWinnerName,
        dealerOfRoundId: table.dealer, widowForReveal, allTricks: table.capturedTricks,
        playerTokens: playerTokens
    };
    table.playerTokens = playerTokens;
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
    const allPlayerUserIdsInOrder = Object.values(table.players).filter(p => allPlayerIds.includes(p.userId)).map(p => p.userId);
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
    calculateDrawSplitPayout,
};