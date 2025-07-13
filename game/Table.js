// backend/game/Table.js

const { SERVER_VERSION, TABLE_COSTS, BID_HIERARCHY, PLACEHOLDER_ID, deck, SUITS, BID_MULTIPLIERS } = require('./constants');
const gameLogic = require('./logic');
const transactionManager = require('../db/transactionManager');
const { shuffle } = require('../utils/shuffle');

class Table {
    constructor(tableId, theme, tableName, io, pool, emitLobbyUpdateCallback) {
        this.io = io;
        this.pool = pool;
        this.emitLobbyUpdateCallback = emitLobbyUpdateCallback;
        this.tableId = tableId;
        this.tableName = tableName;
        this.theme = theme;
        this.serverVersion = SERVER_VERSION;
        this.state = "Waiting for Players";
        this.players = {};
        this.playerOrderActive = [];
        this.scores = {};
        this.gameStarted = false;
        this.gameId = null;
        this.playerMode = null;
        this.dealer = null;
        this.internalTimers = {};
        this._initializeNewRoundState();
    }
    
    // =================================================================
    // PUBLIC: Forfeit & Timeout Logic
    // =================================================================

    startForfeitTimer(requestingUserId, targetPlayerName) {
        if (!this.players[requestingUserId] || this.internalTimers.forfeit) return;
        const targetPlayer = Object.values(this.players).find(p => p.playerName === targetPlayerName);
        if (!targetPlayer || !targetPlayer.disconnected) {
            return this.io.to(this.players[requestingUserId].socketId).emit("error", { message: "Cannot start timer: Player is not disconnected." });
        }
        console.log(`[${this.tableId}] Forfeit timer started for ${targetPlayerName} by ${this.players[requestingUserId].playerName}.`);
        this.forfeiture.targetPlayerName = targetPlayerName;
        this.forfeiture.timeLeft = 120;
        this.internalTimers.forfeit = setInterval(() => {
            if (!this.forfeiture.targetPlayerName) return this._clearForfeitTimer();
            this.forfeiture.timeLeft -= 1;
            if (this.forfeiture.timeLeft <= 0) {
                this._resolveForfeit(targetPlayerName, "timeout");
            } else {
                this._emitUpdate();
            }
        }, 1000);
        this._emitUpdate();
    }

    forfeitGame(userId) {
        const playerName = this.players[userId]?.playerName;
        if (!playerName || !this.gameStarted) return;
        this._resolveForfeit(playerName, "voluntary forfeit");
    }

    // =================================================================
    // PUBLIC: Player & Connection Management
    // =================================================================

    async joinTable(user, socketId) {
        const { id, username } = user;
        const isPlayerAlreadyInGame = !!this.players[id];
        if (!isPlayerAlreadyInGame) {
            const tableCost = TABLE_COSTS[this.theme] || 0;
            try {
                const tokenResult = await this.pool.query("SELECT SUM(amount) as tokens FROM transactions WHERE user_id = $1", [id]);
                const userTokens = parseFloat(tokenResult.rows[0]?.tokens || 0);
                if (userTokens < tableCost) {
                    return this.io.to(socketId).emit("error", { message: `You need ${tableCost} tokens to join. You have ${userTokens.toFixed(2)}.` });
                }
            } catch (err) {
                return this.io.to(socketId).emit("error", { message: "A server error occurred trying to join the table." });
            }
        }
        if (this.gameStarted && !isPlayerAlreadyInGame) {
            return this.io.to(socketId).emit("error", { message: "Game has already started." });
        }
        const activePlayersBeforeJoin = Object.values(this.players).filter(p => !p.isSpectator && !p.disconnected).length;
        const canTakeSeat = activePlayersBeforeJoin < 4 && !this.gameStarted;
        this.players[id] = { userId: id, playerName: username, socketId: socketId, isSpectator: this.players[id]?.isSpectator ?? !canTakeSeat, disconnected: false };
        if (!this.scores[username]) { this.scores[username] = 120; }
        this._recalculateActivePlayerOrder();
        const activePlayersAfterJoin = this.playerOrderActive.length;
        if (activePlayersAfterJoin >= 3 && !this.gameStarted) { this.state = "Ready to Start"; }
        else if (activePlayersAfterJoin < 3 && !this.gameStarted) { this.state = "Waiting for Players"; }
        await this._syncPlayerTokens(Object.keys(this.players));
        this.io.to(socketId).emit("joinedTable", { tableId: this.tableId, gameState: this.getStateForClient() });
        this._emitUpdate();
        this.emitLobbyUpdateCallback();
    }

    async leaveTable(userId) {
        if (!this.players[userId]) return;
        const playerInfo = this.players[userId];
        const safeLeaveStates = ["Waiting for Players", "Ready to Start", "Game Over"];
        if (safeLeaveStates.includes(this.state) || playerInfo.isSpectator) { delete this.players[userId]; }
        else if (this.gameId && this.gameStarted) { this.disconnectPlayer(userId); }
        else { delete this.players[userId]; }
        this._recalculateActivePlayerOrder();
        await this._syncPlayerTokens(Object.keys(this.players));
        this._emitUpdate();
        this.emitLobbyUpdateCallback();
    }
    
    disconnectPlayer(userId) {
        const player = this.players[userId];
        if (!player) return;
        if (!this.gameStarted || player.isSpectator) {
            delete this.players[userId];
            this._recalculateActivePlayerOrder();
        } else {
            console.log(`[${this.tableId}] Player ${player.playerName} has disconnected.`);
            player.disconnected = true;
        }
        this._emitUpdate();
        this.emitLobbyUpdateCallback();
    }
    
    reconnectPlayer(userId, newSocketId) {
        if (!this.players[userId] || !this.players[userId].disconnected) return;
        console.log(`[${this.tableId}] Reconnecting user ${this.players[userId].playerName}.`);
        this.players[userId].disconnected = false;
        this.players[userId].socketId = newSocketId;
        this.io.to(newSocketId).join(this.tableId);
        if (this.forfeiture.targetPlayerName === this.players[userId].playerName) {
            this._clearForfeitTimer();
            console.log(`[${this.tableId}] Cleared timeout for reconnected player ${this.players[userId].playerName}.`);
        }
        this._emitUpdate();
        this.emitLobbyUpdateCallback();
    }

    // =================================================================
    // PUBLIC: Game Flow Management
    // =================================================================

    async startGame(requestingUserId) {
        if (this.gameStarted) return;
        if (!this.players[requestingUserId] || this.players[requestingUserId].isSpectator) return;
        const activePlayers = Object.values(this.players).filter(p => !p.isSpectator && !p.disconnected);
        if (activePlayers.length < 3) { return this.io.to(this.players[requestingUserId].socketId).emit("error", { message: "Need at least 3 players to start." }); }
        this.playerMode = activePlayers.length;
        const activePlayerIds = activePlayers.map(p => p.userId);
        try {
            this.gameId = await transactionManager.createGameRecord(this.pool, this);
            await transactionManager.handleGameStartTransaction(this.pool, activePlayerIds, this.gameId);
            this.gameStarted = true;
            activePlayers.forEach(p => { if (this.scores[p.playerName] === undefined) this.scores[p.playerName] = 120; });
            if (this.playerMode === 3 && this.scores[PLACEHOLDER_ID] === undefined) { this.scores[PLACEHOLDER_ID] = 120; }
            const shuffledPlayerIds = shuffle([...activePlayerIds]);
            this.dealer = shuffledPlayerIds[0];
            this._recalculateActivePlayerOrder();
            this._initializeNewRoundState();
            this.state = "Dealing Pending";
            await this._syncPlayerTokens(activePlayerIds);
            this._emitUpdate();
            this.emitLobbyUpdateCallback();
        } catch (err) {
            const insufficientFundsMatch = err.message.match(/(.+) has insufficient tokens/);
            if (insufficientFundsMatch) {
                const brokePlayerName = insufficientFundsMatch[1];
                const brokePlayer = Object.values(this.players).find(p => p.playerName === brokePlayerName);
                if (brokePlayer) {
                    delete this.players[brokePlayer.userId];
                    this._recalculateActivePlayerOrder();
                    this.playerMode = this.playerOrderActive.length;
                    this.state = this.playerMode >= 3 ? "Ready to Start" : "Waiting for Players";
                    this.gameId = null; 
                    this.io.to(this.tableId).emit("gameStartFailed", { message: err.message, kickedPlayer: brokePlayerName });
                    this._emitUpdate();
                    this.emitLobbyUpdateCallback();
                }
            } else {
                this.io.to(this.players[requestingUserId].socketId).emit("error", { message: err.message || "A server error occurred during buy-in." });
                this.gameStarted = false; 
                this.playerMode = null;
                this.gameId = null;
            }
        }
    }
    
    dealCards(requestingUserId) {
        if (this.state !== "Dealing Pending" || requestingUserId !== this.dealer) return;
        const shuffledDeck = shuffle([...deck]);
        this.playerOrderActive.forEach((pName, i) => { this.hands[pName] = shuffledDeck.slice(i * 11, (i + 1) * 11); });
        this.widow = shuffledDeck.slice(11 * this.playerOrderActive.length);
        this.originalDealtWidow = [...this.widow];
        this.state = "Bidding Phase";
        this.biddingTurnPlayerName = this.playerOrderActive[0];
        this._emitUpdate();
    }

    placeBid(userId, bid) {
        const player = this.players[userId];
        if (!player || player.playerName !== this.biddingTurnPlayerName) return;
        if (this.state === "Awaiting Frog Upgrade Decision") {
            if (userId !== this.originalFrogBidderId || (bid !== "Heart Solo" && bid !== "Pass")) return;
            if (bid === "Heart Solo") { this.currentHighestBidDetails = { userId, playerName: player.playerName, bid: "Heart Solo" }; }
            this.biddingTurnPlayerName = null;
            this._resolveBiddingFinal();
            return;
        }
        if (this.state !== "Bidding Phase" || !BID_HIERARCHY.includes(bid) || this.playersWhoPassedThisRound.includes(player.playerName)) return;
        const currentHighestBidIndex = this.currentHighestBidDetails ? BID_HIERARCHY.indexOf(this.currentHighestBidDetails.bid) : -1;
        if (bid !== "Pass" && BID_HIERARCHY.indexOf(bid) <= currentHighestBidIndex) return;
        if (bid !== "Pass") {
            this.currentHighestBidDetails = { userId, playerName: player.playerName, bid };
            if (bid === "Frog" && !this.originalFrogBidderId) this.originalFrogBidderId = userId;
            if (bid === "Solo" && this.originalFrogBidderId && userId !== this.originalFrogBidderId) this.soloBidMadeAfterFrog = true;
        } else { this.playersWhoPassedThisRound.push(player.playerName); }
        const activeBiddersRemaining = this.playerOrderActive.filter(name => !this.playersWhoPassedThisRound.includes(name));
        if ((this.currentHighestBidDetails && activeBiddersRemaining.length <= 1) || this.playersWhoPassedThisRound.length === this.playerOrderActive.length) {
            this.biddingTurnPlayerName = null;
            this._checkForFrogUpgrade();
        } else {
            let currentBidderIndex = this.playerOrderActive.indexOf(player.playerName);
            let nextBidderName = null;
            for (let i = 1; i < this.playerOrderActive.length; i++) {
                let potentialNextBidder = this.playerOrderActive[(currentBidderIndex + i) % this.playerOrderActive.length];
                if (!this.playersWhoPassedThisRound.includes(potentialNextBidder)) { nextBidderName = potentialNextBidder; break; }
            }
            if (nextBidderName) { this.biddingTurnPlayerName = nextBidderName; } else { this._checkForFrogUpgrade(); }
        }
        this._emitUpdate();
    }
    
    chooseTrump(userId, suit) {
        if (this.state !== "Trump Selection" || this.bidWinnerInfo?.userId !== userId || !["S", "C", "D"].includes(suit)) {
            return;
        }
        this.trumpSuit = suit;
        this._transitionToPlayingPhase();
    }

    submitFrogDiscards(userId, discards) {
        const player = this.players[userId];
        if (!player || this.state !== "Frog Widow Exchange" || this.bidWinnerInfo?.userId !== userId || !Array.isArray(discards) || discards.length !== 3) {
            return;
        }
        const currentHand = this.hands[player.playerName];
        if (!discards.every(card => currentHand.includes(card))) {
            return this.io.to(player.socketId).emit("error", { message: "Invalid discard selection." });
        }
        this.widowDiscardsForFrogBidder = discards;
        this.hands[player.playerName] = currentHand.filter(card => !discards.includes(card));
        this._transitionToPlayingPhase();
    }

    playCard(userId, card) {
        const player = this.players[userId];
        if (!player || this.state !== "Playing Phase" || player.playerName !== this.trickTurnPlayerName) return;
        const hand = this.hands[player.playerName];
        if (!hand || !hand.includes(card)) return;
        const isLeading = this.currentTrickCards.length === 0;
        const playedSuit = gameLogic.getSuit(card);
        if (isLeading) {
            if (playedSuit === this.trumpSuit && !this.trumpBroken && !hand.every(c => gameLogic.getSuit(c) === this.trumpSuit)) { return this.io.to(player.socketId).emit("error", { message: "Cannot lead trump until it is broken." }); }
        } else {
            const leadCardSuit = this.leadSuitCurrentTrick;
            const hasLeadSuit = hand.some(c => gameLogic.getSuit(c) === leadCardSuit);
            if (hasLeadSuit && playedSuit !== leadCardSuit) { return this.io.to(player.socketId).emit("error", { message: `Must follow suit (${SUITS[leadCardSuit]}).` }); }
            if (!hasLeadSuit && hand.some(c => gameLogic.getSuit(c) === this.trumpSuit) && playedSuit !== this.trumpSuit) { return this.io.to(player.socketId).emit("error", { message: "You must play trump if you cannot follow suit." }); }
        }
        this.hands[player.playerName] = hand.filter(c => c !== card);
        this.currentTrickCards.push({ userId, playerName: player.playerName, card });
        if (isLeading) this.leadSuitCurrentTrick = playedSuit;
        if (playedSuit === this.trumpSuit) this.trumpBroken = true;
        const expectedCardsInTrick = this.playerOrderActive.length;
        if (this.currentTrickCards.length === expectedCardsInTrick) { this._resolveTrick(); }
        else {
            const currentTurnPlayerIndex = this.playerOrderActive.indexOf(player.playerName);
            this.trickTurnPlayerName = this.playerOrderActive[(currentTurnPlayerIndex + 1) % expectedCardsInTrick];
            this._emitUpdate();
        }
    }

    requestNextRound(requestingUserId) {
        if (this.state === "Awaiting Next Round Trigger" && requestingUserId === this.roundSummary?.dealerOfRoundId) { this._advanceRound(); }
    }

    async reset() {
        console.log(`[${this.tableId}] Game is being reset.`);
        this._clearAllTimers();
        const originalPlayers = { ...this.players };
        Object.assign(this, new Table(this.tableId, this.theme, this.tableName, this.io, this.pool, this.emitLobbyUpdateCallback));
        const playerIdsToKeep = [];
        for (const userId in originalPlayers) {
            const playerInfo = originalPlayers[userId];
            if (!playerInfo.disconnected) {
                this.players[userId] = { ...playerInfo, isSpectator: false, socketId: playerInfo.socketId };
                this.scores[playerInfo.playerName] = 120;
                if (!playerInfo.isSpectator) { playerIdsToKeep.push(parseInt(userId, 10)); }
            }
        }
        this._recalculateActivePlayerOrder();
        this.playerMode = this.playerOrderActive.length;
        this.state = this.playerMode >= 3 ? "Ready to Start" : "Waiting for Players";
        await this._syncPlayerTokens(playerIdsToKeep);
        this._emitUpdate();
        this.emitLobbyUpdateCallback();
    }
    
    updateInsuranceSetting(userId, settingType, value) {
        const player = this.players[userId];
        if (!player || !this.insurance.isActive || this.insurance.dealExecuted) return;
        const multiplier = this.insurance.bidMultiplier;
        const parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) return;
        if (settingType === 'bidderRequirement' && player.playerName === this.insurance.bidderPlayerName) {
            const minReq = -120 * multiplier; const maxReq = 120 * multiplier;
            if (parsedValue >= minReq && parsedValue <= maxReq) this.insurance.bidderRequirement = parsedValue;
        } else if (settingType === 'defenderOffer' && this.insurance.defenderOffers.hasOwnProperty(player.playerName)) {
            const minOffer = -60 * multiplier; const maxOffer = 60 * multiplier;
            if (parsedValue >= minOffer && parsedValue <= maxOffer) this.insurance.defenderOffers[player.playerName] = parsedValue;
        }
        const { bidderRequirement, defenderOffers } = this.insurance;
        if (bidderRequirement <= Object.values(defenderOffers || {}).reduce((sum, offer) => sum + (offer || 0), 0)) {
            this.insurance.dealExecuted = true;
            this.insurance.executedDetails = { agreement: { bidderPlayerName: this.insurance.bidderPlayerName, bidderRequirement, defenderOffers: { ...defenderOffers } } };
        }
        this._emitUpdate();
    }

    requestDraw(userId) {
        const player = this.players[userId];
        if (!player || this.drawRequest.isActive || this.state !== 'Playing Phase') return;
        this.drawRequest.isActive = true;
        this.drawRequest.initiator = player.playerName;
        this.drawRequest.votes = {};
        const activePlayers = Object.values(this.players).filter(p => !p.isSpectator);
        activePlayers.forEach(p => {
            this.drawRequest.votes[p.playerName] = (p.playerName === player.playerName) ? 'wash' : null;
        });
        this.drawRequest.timer = 30;
        this.internalTimers.draw = setInterval(() => {
            if (!this.drawRequest.isActive) return clearInterval(this.internalTimers.draw);
            this.drawRequest.timer -= 1;
            if (this.drawRequest.timer <= 0) {
                clearInterval(this.internalTimers.draw);
                this.drawRequest.isActive = false;
                this.io.to(this.tableId).emit("notification", { message: "Draw request timed out. Game resumes." });
                this._emitUpdate();
            } else {
                this._emitUpdate();
            }
        }, 1000);
        this._emitUpdate();
    }

    async submitDrawVote(userId, vote) {
        const player = this.players[userId];
        if (!player || !this.drawRequest.isActive || !['wash', 'split', 'no'].includes(vote) || this.drawRequest.votes[player.playerName] !== null) return;
        
        this.drawRequest.votes[player.playerName] = vote;
    
        if (vote === 'no') {
            clearInterval(this.internalTimers.draw);
            this.drawRequest.isActive = false;
            this.io.to(this.tableId).emit("notification", { message: `${player.playerName} vetoed the draw. Game resumes.` });
            this._emitUpdate();
            return;
        }
    
        const allVotes = Object.values(this.drawRequest.votes);
        if (!allVotes.every(v => v !== null)) {
            this._emitUpdate(); // Just update the votes, don't resolve yet
            return;
        }

        // --- All votes are in, resolve the draw ---
        clearInterval(this.internalTimers.draw);
        this.drawRequest.isActive = false;
        
        try {
            const voteCounts = allVotes.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
            const tableCost = TABLE_COSTS[this.theme] || 0;
            const activePlayers = Object.values(this.players).filter(p => !p.isSpectator);
            let outcomeMessage = "Draw resolved.";
            const transactionPromises = [];
    
            if (voteCounts.wash === activePlayers.length) {
                outcomeMessage = "All players agreed to a wash. All buy-ins returned.";
                activePlayers.forEach(p => {
                    transactionPromises.push(transactionManager.postTransaction(this.pool, { userId: p.userId, gameId: this.gameId, type: 'wash_payout', amount: tableCost, description: `Draw Outcome: Wash` }));
                });
            } else if (voteCounts.wash > 0 && voteCounts.split > 0) {
                outcomeMessage = "A split was agreed upon. Payouts calculated by score.";
                const payoutResult = gameLogic.calculateDrawSplitPayout(this);
                if (payoutResult && payoutResult.payouts) {
                    for (const playerName in payoutResult.payouts) {
                        const pData = payoutResult.payouts[playerName];
                        transactionPromises.push(transactionManager.postTransaction(this.pool, { userId: pData.userId, gameId: this.gameId, type: 'win_payout', amount: pData.totalReturn, description: `Draw Outcome: Split` }));
                    }
                }
            } else { // Default to wash if there's no clear majority or only split votes etc.
                outcomeMessage = "The draw resulted in a wash. All buy-ins returned.";
                activePlayers.forEach(p => {
                    transactionPromises.push(transactionManager.postTransaction(this.pool, { userId: p.userId, gameId: this.gameId, type: 'wash_payout', amount: tableCost, description: `Draw Outcome: Wash (Default)` }));
                });
            }
            
            await Promise.all(transactionPromises);
            await transactionManager.updateGameRecordOutcome(this.pool, this.gameId, outcomeMessage);
    
            this.state = "Game Over";
            this.roundSummary = { message: outcomeMessage, isGameOver: true, finalScores: this.scores };
            this._emitUpdate();
            this.emitLobbyUpdateCallback();

            // Automatically reset the table after showing the summary
            this.internalTimers.drawReset = setTimeout(() => this.reset(), 10000);

        } catch (error) {
            console.error(`[${this.tableId}] Error resolving draw vote:`, error);
            this.io.to(this.tableId).emit("notification", { message: `A server error occurred resolving the draw. Resuming game.` });
            this.drawRequest = this._getInitialDrawRequestState(); // Reset the draw state
            this._emitUpdate();
        }
    }

    // =================================================================
    // INTERNAL: Game Flow and State Transitions (_prefix)
    // =================================================================

    _clearForfeitTimer() {
        if (this.internalTimers.forfeit) {
            clearInterval(this.internalTimers.forfeit);
            delete this.internalTimers.forfeit;
        }
        this.forfeiture = this._getInitialForfeitureState();
    }

    async _resolveForfeit(forfeitingPlayerName, reason) {
        if (this.state === "Game Over" || !this.gameId) return;
        console.log(`[${this.tableId}] Resolving forfeit for ${forfeitingPlayerName}. Reason: ${reason}`);
        this._clearAllTimers();
        try {
            const forfeitingPlayer = Object.values(this.players).find(p => p.playerName === forfeitingPlayerName);
            const remainingPlayers = Object.values(this.players).filter(p => !p.isSpectator && p.playerName !== forfeitingPlayerName);
            const tokenChanges = gameLogic.calculateForfeitPayout(this, forfeitingPlayerName);
            const transactionPromises = [];
            if (forfeitingPlayer) {
                transactionPromises.push(transactionManager.postTransaction(this.pool, {
                    userId: forfeitingPlayer.userId, gameId: this.gameId, type: 'forfeit_loss',
                    amount: 0, description: `Forfeited game on table ${this.tableName}`
                }));
            }
            remainingPlayers.forEach(player => {
                const payoutInfo = tokenChanges[player.playerName];
                if (payoutInfo && payoutInfo.totalGain > 0) {
                    transactionPromises.push(transactionManager.postTransaction(this.pool, {
                        userId: player.userId, gameId: this.gameId, type: 'forfeit_payout',
                        amount: payoutInfo.totalGain, description: `Payout from ${forfeitingPlayerName}'s forfeit`
                    }));
                }
            });
            await Promise.all(transactionPromises);
            const statUpdatePromises = [];
            if (forfeitingPlayer) {
                statUpdatePromises.push(this.pool.query("UPDATE users SET losses = losses + 1 WHERE id = $1", [forfeitingPlayer.userId]));
            }
            remainingPlayers.forEach(player => {
                statUpdatePromises.push(this.pool.query("UPDATE users SET washes = washes + 1 WHERE id = $1", [player.userId]));
            });
            await Promise.all(statUpdatePromises);
            const outcomeMessage = `${forfeitingPlayerName} has forfeited the game due to ${reason}.`;
            await transactionManager.updateGameRecordOutcome(this.pool, this.gameId, outcomeMessage);
            Object.values(this.players).forEach(p => this.io.sockets.sockets.get(p.socketId)?.emit("requestUserSync"));
            this.roundSummary = {
                message: `${outcomeMessage} The game has ended.`, isGameOver: true,
                gameWinner: `Payout to remaining players.`, finalScores: this.scores, payouts: tokenChanges,
            };
            this.state = "Game Over";
            this._emitUpdate();
            this.emitLobbyUpdateCallback();
        } catch (err) {
            console.error(`Database error during forfeit resolution for table ${this.tableId}:`, err);
        }
    }

    _resolveTrick() {
        const winnerInfo = gameLogic.determineTrickWinner(this.currentTrickCards, this.leadSuitCurrentTrick, this.trumpSuit);
        this.lastCompletedTrick = { cards: [...this.currentTrickCards], winnerName: winnerInfo.playerName };
        this.tricksPlayedCount++;
        this.trickLeaderName = winnerInfo.playerName;
        if (winnerInfo.playerName && !this.capturedTricks[winnerInfo.playerName]) { this.capturedTricks[winnerInfo.playerName] = []; }
        if (winnerInfo.playerName) { this.capturedTricks[winnerInfo.playerName].push(this.currentTrickCards.map(p => p.card)); }
        if (this.tricksPlayedCount === 11) { this._calculateRoundScores(); }
        else {
            this.state = "TrickCompleteLinger";
            this._emitUpdate();
            this.internalTimers.trickLinger = setTimeout(() => {
                if (this.state === "TrickCompleteLinger") {
                    this.currentTrickCards = [];
                    this.leadSuitCurrentTrick = null;
                    this.trickTurnPlayerName = winnerInfo.playerName;
                    this.state = "Playing Phase";
                    this._emitUpdate();
                }
            }, 1000);
        }
    }

    _resolveBiddingFinal() {
        if (!this.currentHighestBidDetails) {
            this.state = "AllPassWidowReveal";
            this._emitUpdate();
            this.internalTimers.allPass = setTimeout(() => {
                if (this.state === "AllPassWidowReveal") {
                    this._advanceRound();
                }
            }, 3000);
            return;
        }
        this.bidWinnerInfo = { ...this.currentHighestBidDetails };
        const bid = this.bidWinnerInfo.bid;
        if (bid === "Frog") { 
            this.trumpSuit = "H"; 
            this.state = "Frog Widow Exchange";
            this.revealedWidowForFrog = [...this.widow];
            const bidderHand = this.hands[this.bidWinnerInfo.playerName];
            this.hands[this.bidWinnerInfo.playerName] = [...bidderHand, ...this.widow];
        } else if (bid === "Heart Solo") { 
            this.trumpSuit = "H"; 
            this._transitionToPlayingPhase();
        } else if (bid === "Solo") { 
            this.state = "Trump Selection";
        }
        this._emitUpdate();
        this.originalFrogBidderId = null;
        this.soloBidMadeAfterFrog = false;
    }

    _checkForFrogUpgrade() {
        if (this.soloBidMadeAfterFrog && this.originalFrogBidderId) {
            this.state = "Awaiting Frog Upgrade Decision";
            this.biddingTurnPlayerName = this.players[this.originalFrogBidderId]?.playerName;
        } else { this._resolveBiddingFinal(); }
        this._emitUpdate();
    }
    
    _transitionToPlayingPhase() {
        this.state = "Playing Phase";
        this.tricksPlayedCount = 0;
        this.trumpBroken = false;
        this.currentTrickCards = [];
        this.leadSuitCurrentTrick = null;
        this.lastCompletedTrick = null;
        this.trickLeaderName = this.bidWinnerInfo.playerName;
        this.trickTurnPlayerName = this.bidWinnerInfo.playerName;
        if (this.playerMode === 3) {
            this.insurance.isActive = true;
            const multiplier = BID_MULTIPLIERS[this.bidWinnerInfo.bid];
            this.insurance.bidMultiplier = multiplier;
            this.insurance.bidderPlayerName = this.bidWinnerInfo.playerName;
            this.insurance.bidderRequirement = 120 * multiplier;
            const defenders = this.playerOrderActive.filter(pName => pName !== this.bidWinnerInfo.playerName);
            defenders.forEach(defName => { this.insurance.defenderOffers[defName] = -60 * multiplier; });
        }
        this._emitUpdate();
    }
    
    _advanceRound() {
        if (!this.gameStarted) return;
        const newDealerName = this.playerOrderActive.shift();
        this.playerOrderActive.push(newDealerName);
        const newDealer = Object.values(this.players).find(p => p.playerName === newDealerName);
        if (!newDealer) {
            console.error(`[${this.tableId}] FATAL: Could not find new dealer. Resetting table.`);
            this.reset();
            return;
        }
        this.dealer = newDealer.userId;
        this._initializeNewRoundState();
        this.state = "Dealing Pending";
        console.log(`[${this.tableId}] Round advanced. New dealer: ${newDealerName}. State: ${this.state}`);
        this._emitUpdate();
    }
    
    async _calculateRoundScores() {
        const roundData = gameLogic.calculateRoundScoreDetails(this);
        for(const playerName in roundData.pointChanges) { if(this.scores[playerName] !== undefined) { this.scores[playerName] += roundData.pointChanges[playerName]; } }
        let isGameOver = Object.values(this.scores).filter(s => typeof s === 'number').some(score => score <= 0);
        let gameWinnerName = null;
        let finalOutcomeMessage = roundData.roundMessage;
        if (isGameOver) {
            finalOutcomeMessage = "Game Over!";
            const gameOverResult = await gameLogic.handleGameOver(this, this.pool);
            gameWinnerName = gameOverResult.gameWinnerName;
            Object.values(this.players).forEach(p => { if (p.socketId && this.io.sockets.sockets.get(p.socketId)) { this.io.sockets.sockets.get(p.socketId).emit("requestUserSync"); } });
        }
        await this._syncPlayerTokens(Object.keys(this.players));
        this.roundSummary = { message: finalOutcomeMessage, finalScores: { ...this.scores }, isGameOver, gameWinner: gameWinnerName, dealerOfRoundId: this.dealer, widowForReveal: roundData.widowForReveal, insuranceDealWasMade: this.insurance.dealExecuted, insuranceDetails: this.insurance.dealExecuted ? this.insurance.executedDetails : null, insuranceHindsight: roundData.insuranceHindsight, allTricks: this.capturedTricks, playerTokens: this.playerTokens };
        this.state = isGameOver ? "Game Over" : "Awaiting Next Round Trigger";
        this._emitUpdate();
    }

    _recalculateActivePlayerOrder() {
        const activePlayers = Object.values(this.players).filter(p => !p.isSpectator && !p.disconnected);
        if (activePlayers.length === 0) { this.playerOrderActive = []; return; }
        if (this.gameStarted && this.dealer) {
            const playerUserIds = activePlayers.map(p => p.userId);
            let dealerIndex = playerUserIds.indexOf(this.dealer);
            if (dealerIndex === -1) { this.dealer = playerUserIds[0]; dealerIndex = 0; }
            const orderedNames = [];
            for (let i = 1; i <= playerUserIds.length; i++) { const playerId = playerUserIds[(dealerIndex + i) % playerUserIds.length]; orderedNames.push(this.players[playerId].playerName); }
            this.playerOrderActive = orderedNames;
        } else { this.playerOrderActive = activePlayers.map(p => p.playerName).sort(); }
    }

    getStateForClient() {
        return {
            tableId: this.tableId, tableName: this.tableName, theme: this.theme, state: this.state, players: this.players, playerOrderActive: this.playerOrderActive, dealer: this.dealer, hands: this.hands, widow: this.widow, originalDealtWidow: this.originalDealtWidow, scores: this.scores, currentHighestBidDetails: this.currentHighestBidDetails, biddingTurnPlayerName: this.biddingTurnPlayerName, bidWinnerInfo: this.bidWinnerInfo, gameStarted: this.gameStarted, trumpSuit: this.trumpSuit, currentTrickCards: this.currentTrickCards, trickTurnPlayerName: this.trickTurnPlayerName, tricksPlayedCount: this.tricksPlayedCount, leadSuitCurrentTrick: this.leadSuitCurrentTrick, trumpBroken: this.trumpBroken, trickLeaderName: this.trickLeaderName, capturedTricks: this.capturedTricks, roundSummary: this.roundSummary, lastCompletedTrick: this.lastCompletedTrick, playersWhoPassedThisRound: this.playersWhoPassedThisRound, playerMode: this.playerMode, serverVersion: this.serverVersion, insurance: this.insurance, forfeiture: this.forfeiture, playerTokens: this.playerTokens, drawRequest: this.drawRequest, originalFrogBidderId: this.originalFrogBidderId, soloBidMadeAfterFrog: this.soloBidMadeAfterFrog, revealedWidowForFrog: this.revealedWidowForFrog, widowDiscardsForFrogBidder: this.widowDiscardsForFrogBidder,
        };
    }
    
    _emitUpdate() { this.io.to(this.tableId).emit('gameState', this.getStateForClient()); }
    _clearAllTimers() { for (const timer in this.internalTimers) { clearTimeout(this.internalTimers[timer]); clearInterval(this.internalTimers[timer]); } this.internalTimers = {}; }
    _initializeNewRoundState() {
        this.hands = {}; this.widow = []; this.originalDealtWidow = []; this.biddingTurnPlayerName = null; this.currentHighestBidDetails = null; this.playersWhoPassedThisRound = []; this.bidWinnerInfo = null; this.trumpSuit = null; this.trumpBroken = false; this.originalFrogBidderId = null; this.soloBidMadeAfterFrog = false; this.revealedWidowForFrog = []; this.widowDiscardsForFrogBidder = []; this.trickTurnPlayerName = null; this.trickLeaderName = null; this.currentTrickCards = []; this.leadSuitCurrentTrick = null; this.lastCompletedTrick = null; this.tricksPlayedCount = 0; this.capturedTricks = {}; this.roundSummary = null; this.insurance = this._getInitialInsuranceState(); this.forfeiture = this._getInitialForfeitureState(); this.drawRequest = this._getInitialDrawRequestState();
        this.playerOrderActive.forEach(pName => { if (pName && this.scores[pName] !== undefined) { this.capturedTricks[pName] = []; } });
    }
    async _syncPlayerTokens(playerIds) {
        if (!playerIds || playerIds.length === 0) { this.playerTokens = {}; return; }
        try {
            const tokenQuery = `SELECT user_id, SUM(amount) as tokens FROM transactions WHERE user_id = ANY($1::int[]) GROUP BY user_id;`;
            const tokenResult = await this.pool.query(tokenQuery, [playerIds]);
            const newPlayerTokens = {};
            const userIdToNameMap = Object.values(this.players).reduce((acc, player) => { acc[player.userId] = player.playerName; return acc; }, {});
            tokenResult.rows.forEach(row => { const playerName = userIdToNameMap[row.user_id]; if (playerName) { newPlayerTokens[playerName] = parseFloat(row.tokens || 0).toFixed(2); } });
            this.playerTokens = newPlayerTokens;
        } catch (err) { console.error(`Error fetching tokens during sync for table ${this.tableId}:`, err); }
    }
    _getInitialInsuranceState() { return { isActive: false, bidMultiplier: null, bidderPlayerName: null, bidderRequirement: 0, defenderOffers: {}, dealExecuted: false, executedDetails: null }; }
    _getInitialForfeitureState() { return { targetPlayerName: null, timeLeft: null }; }
    _getInitialDrawRequestState() { return { isActive: false, initiator: null, votes: {}, timer: null }; }
}

module.exports = Table;