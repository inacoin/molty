// Molty Royale Agent - Clean Script
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.moltyroyale.com/api';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const DYNAMIC_POOL_FILE = path.join(__dirname, 'dynamic_accounts.json');

// Helper to load/save the dynamic account pool
function loadPool() {
    if (fs.existsSync(DYNAMIC_POOL_FILE)) {
        try {
            const data = fs.readFileSync(DYNAMIC_POOL_FILE, 'utf8');
            const parsed = JSON.parse(data);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            return [];
        }
    }
    return [];
}

const { sendMessage, sendDocument } = require('./telegram');

function saveToPool(account) {
    const pool = loadPool();
    const index = pool.findIndex(a => a.accountId === account.accountId);
    if (index !== -1) {
        pool[index] = { ...pool[index], ...account };
    } else {
        pool.push({
            accountId: account.accountId,
            accountName: account.accountName || account.name,
            apiKey: account.apiKey,
            ipAddress: account.ipAddress,
            createdAt: new Date().toISOString()
        });
    }
    fs.writeFileSync(DYNAMIC_POOL_FILE, JSON.stringify(pool, null, 2));

    // Send update to Telegram
    const message = `*New Account Created!*\n\n` +
        `*ID:* \`${account.accountId}\`\n` +
        `*Name:* \`${account.accountName || account.name}\`\n` +
        `*API Key:* \`${account.apiKey}\``;

    // 1. Send text details
    sendMessage(message).catch(err => console.error(`[Telegram] Background message error: ${err.message}`));

    // 2. Also send the updated pool file for backup
    sendDocument(
        DYNAMIC_POOL_FILE,
        `Database Update: Added ${account.accountName || account.name}`
    ).catch(err => console.error(`[Telegram] Background document error: ${err.message}`));
}

async function getAvailableAccount(molty, log) {
    const pool = loadPool();
    if (pool.length === 0) return null;

    log(`[Pool] Checking ${pool.length} accounts in rotation pool...`);
    for (const acc of pool) {
        const tempMolty = new MoltyClient(acc.apiKey, null, acc.ipAddress);
        const session = await tempMolty.findActiveSession(acc.accountName);
        if (!session) {
            log(`[Pool] Account ${acc.accountName} is FREE. Recycling...`);
            return acc;
        }
        log(`[Pool] Account ${acc.accountName} is still active in game: ${session.gameId}`);
    }
    return null;
}

// Configuration management
let config = {
    apiKey: null,
    accountId: null,
    accountName: 'Narto_' + Math.floor(Math.random() * 1000)
};

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        console.log(`[Config] Loaded existing account: ${config.accountName}`);
    }
}

// Ensure config is loaded immediately so internal helpers have access to Telegram keys
loadConfig();

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Helper to update manager's accounts.json if we create a new fallback account
function saveToAccountsFile(oldAccountId, newData) {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try {
            let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            if (!Array.isArray(accounts)) accounts = [accounts];

            // Don't replace! Just add the new one as a separate entry if it's not already there.
            const exists = accounts.some(acc => acc.accountId === newData.accountId);
            if (!exists) {
                accounts.push({
                    accountId: newData.accountId,
                    name: newData.name,
                    apiKey: newData.apiKey,
                    ipAddress: newData.ipAddress,
                    createdAt: new Date().toISOString()
                });
                fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
                return true;
            }
        } catch (e) {
            console.error(`[System] Error updating accounts.json: ${e.message}`);
        }
    }
    return false;
}

// Helper to generate a random public IP address
function generateRandomIP() {
    const isPrivate = (octets) => {
        const o1 = octets[0];
        const o2 = octets[1];
        if (o1 === 10) return true;
        if (o1 === 172 && (o2 >= 16 && o2 <= 31)) return true;
        if (o1 === 192 && o2 === 168) return true;
        if (o1 === 127) return true;
        if (o1 === 0) return true;
        if (o1 === 169 && o2 === 254) return true; // Link-local
        if (o1 === 100 && (o2 >= 64 && o2 <= 127)) return true; // Carrier-grade NAT
        if (o1 >= 224) return true; // Multicast/Reserved
        return false;
    };

    let octets;
    do {
        octets = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
    } while (isPrivate(octets));

    return octets.join('.');
}

// API Client
class MoltyClient {
    constructor(apiKey = null, logger = null, ipAddress = null) {
        this.logger = logger || ((msg) => console.log(msg));
        this.currentIP = ipAddress || generateRandomIP();
        this.currentUA = this.getRandomUA();
        this.client = axios.create({
            baseURL: BASE_URL,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        this.setupInterceptors();
        if (apiKey) this.setApiKey(apiKey);
    }

    getRandomUA() {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
        ];
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    setupInterceptors() {
        this.client.interceptors.request.use(config => {
            config.headers['X-Forwarded-For'] = this.currentIP;
            config.headers['X-Real-IP'] = this.currentIP;
            config.headers['X-Originating-IP'] = this.currentIP;
            config.headers['X-Client-IP'] = this.currentIP;
            config.headers['Client-IP'] = this.currentIP;
            config.headers['User-Agent'] = this.currentUA;
            return config;
        }, error => Promise.reject(error));
    }

    setApiKey(apiKey) {
        this.client.defaults.headers.common['X-API-Key'] = apiKey;
    }

    // Refresh IP for new requests (especially account creation)
    refreshIP() {
        const newIP = generateRandomIP();
        this.currentIP = newIP;
        this.currentUA = this.getRandomUA();
        this.logger(`[Network] Spoofing IP: ${newIP} | UA: ${this.currentUA.slice(0, 30)}...`);
        return newIP;
    }

    async createAccount(name) {
        try {
            const resp = await this.client.post('/accounts', { name });
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'createAccount');
        }
    }

    async getAccountHistory(limit = 50) {
        try {
            const resp = await this.client.get(`/accounts/history?limit=${limit}`);
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getAccountHistory');
        }
    }

    async getMe() {
        try {
            const resp = await this.client.get('/accounts/me');
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getMe');
        }
    }

    async getWaitingGames() {
        try {
            const resp = await this.client.get('/games?status=waiting');
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getWaitingGames');
        }
    }

    async createGame() {
        try {
            const resp = await this.client.post('/games', { hostName: "Molty" + "'s Arena" });
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'createGame');
        }
    }

    async registerAgent(gameId, agentName) {
        try {
            const resp = await this.client.post(`/games/${gameId}/agents/register`, { name: agentName });
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'registerAgent');
        }
    }

    async getAgentState(gameId, agentId) {
        try {
            const resp = await this.client.get(`/games/${gameId}/agents/${agentId}/state`);
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getAgentState');
        }
    }

    async getSpectatorState(gameId) {
        try {
            const resp = await this.client.get(`/games/${gameId}/state`);
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getSpectatorState');
        }
    }

    async getItems() {
        try {
            const resp = await this.client.get('/items');
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'getItems');
        }
    }

    async executeAction(gameId, agentId, action, thought = null) {
        try {
            const payload = { action };
            if (thought) payload.thought = thought;
            const resp = await this.client.post(`/games/${gameId}/agents/${agentId}/action`, payload);
            return resp.data;
        } catch (err) {
            return this.handleError(err, 'executeAction');
        }
    }

    async findActiveSession(agentName) {
        try {
            const statuses = ['waiting', 'running'];
            for (const status of statuses) {
                const gamesResp = await this.client.get(`/games?status=${status}`);
                if (gamesResp.data && gamesResp.data.success) {
                    const games = gamesResp.data.data;
                    for (const game of games) {
                        const specResp = await this.getSpectatorState(game.id);
                        if (specResp && specResp.success) {
                            const myAgent = specResp.data.agents.find(a => a.name === agentName);
                            if (myAgent && myAgent.isAlive) {
                                return { gameId: game.id, agentId: myAgent.id };
                            }
                        }
                    }
                }
            }
        } catch (err) {
            this.logger(`[Lobby] Warning: Could not scan active sessions: ${err.message}`);
        }
        return null;
    }

    handleError(err, context) {
        const msg = err.response?.data?.error?.message || err.message;
        const code = err.response?.data?.error?.code || (err.code || 'ERROR');

        // Detect low-level network/SSL errors
        const isNetworkError = !err.response && (
            err.code === 'ECONNRESET' ||
            err.code === 'ETIMEDOUT' ||
            err.code === 'ECONNREFUSED' ||
            msg.includes('SSL') ||
            msg.includes('decryption failed') ||
            msg.includes('bad record mac')
        );

        const errorCode = isNetworkError ? 'NETWORK_ERROR' : code;
        this.logger(`[API ERROR] ${context}: [${errorCode}] ${msg}`);
        return { success: false, error: { message: msg, code: errorCode } };
    }
}

// Main Logic (Autonomous Loop)
async function startBattle(accountConfig, logHandler = null) {
    const log = (...args) => {
        const message = args.join(' ');
        if (logHandler) {
            logHandler(message);
        } else {
            console.log(message);
        }
    };
    const logErr = (...args) => {
        const message = args.join(' ');
        if (logHandler) {
            logHandler(`[ERROR] ${message}`);
        } else {
            console.error(message);
        }
    };

    let currentAccount = { ...accountConfig };
    const molty = new MoltyClient(null, log, currentAccount.ipAddress);

    log(`\n=== Molty Royale Agent Starting: ${currentAccount.accountName || currentAccount.name} ===`);
    molty.setApiKey(currentAccount.apiKey);

    // 1. Proactive Resumption Check
    log("[Lobby] Checking for active sessions...");
    const session = await molty.findActiveSession(currentAccount.accountName || currentAccount.name);

    let gameId = null;
    let agentId = null;

    if (session) {
        gameId = session.gameId;
        agentId = session.agentId;
        log(`[Lobby] Found active session in game: ${gameId}. Resuming...`);
    } else {
        log("[Lobby] No active sessions found. Starting room discovery...");
    }

    // Outer loop for continuous autonomous play across multiple games
    while (true) {
        while (!agentId) {
            log("[Lobby] Looking for a game...");
            const gamesResp = await molty.getWaitingGames();
            let possibleGames = [];

            if (gamesResp && gamesResp.success && gamesResp.data.length > 0) {
                possibleGames = gamesResp.data.filter(g => g.entryType === 'free');
                log(`[Lobby] Found ${gamesResp.data.length} waiting games (${possibleGames.length} free).`);
            } else {
                log("[Lobby] No waiting games found. Creating a new one...");
                const newGame = await molty.createGame();
                if (newGame && newGame.success) {
                    possibleGames = [newGame.data];
                    log(`[Lobby] Game created: ${newGame.data.id}`);
                } else if (newGame?.error?.code === 'WAITING_GAME_EXISTS') {
                    const retryResp = await molty.getWaitingGames();
                    possibleGames = retryResp?.data || [];
                }
            }

            if (possibleGames.length === 0) {
                log("[Lobby] No games available to join. Retrying in 3s...");
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            // Try to join games in order
            for (const game of possibleGames) {
                log(`[Lobby] Attempting to join room: ${game.id} (${game.name || 'Unnamed'})`);
                const registration = await molty.registerAgent(game.id, currentAccount.accountName || currentAccount.name);

                if (registration && registration.success) {
                    agentId = registration.data.id;
                    gameId = game.id;
                    log(`[Lobby] Agent registered! Agent ID: ${agentId}`);
                    await new Promise(r => setTimeout(r, 500)); // Quick server sync
                    break; // Successfully joined!
                } else if (registration?.error?.code === 'ACCOUNT_ALREADY_IN_GAME') {
                    const msg = registration.error.message;
                    const match = msg.match(/Current game: ([a-f0-9-]+)/);
                    const existingGameId = match ? match[1] : null;

                    if (existingGameId) {
                        log(`[Lobby] Account already in game: ${existingGameId}. Attempting to resume...`);
                        const specState = await molty.getSpectatorState(existingGameId);
                        if (specState && specState.success) {
                            const myAgent = specState.data.agents.find(a => a.name === (currentAccount.accountName || currentAccount.name));
                            if (myAgent) {
                                if (myAgent.isAlive) {
                                    agentId = myAgent.id;
                                    gameId = existingGameId;
                                    log(`[Lobby] Resumed session! Agent ID: ${agentId}`);
                                    break;
                                } else {
                                    log(`[Lobby] Agent in ${existingGameId} is dead. Waiting 5s before room scan...`);
                                    await new Promise(r => setTimeout(r, 5000));
                                    break;
                                }
                            }
                        }
                    }
                    logErr("[Lobby] Could not resume. Retrying or moving on.");
                } else if (registration?.error?.code === 'MAX_AGENTS_REACHED') {
                    log(`[Lobby] Room ${game.id} is full. Trying next room...`);
                    continue;
                } else if (registration?.error?.code === 'TOO_MANY_AGENTS_PER_IP') {
                    log(`[Network] Hit IP limit. Rotating IP and retrying room scan...`);
                    molty.refreshIP();
                    break; // Break the room-join loop to re-scan with new IP (or just continues outer while (!agentId))
                } else if (registration?.error?.code === 'ONE_AGENT_PER_API_KEY') {
                    logErr("[Lobby] API Key already has an agent in this game. Resuming...");
                    const specState = await molty.getSpectatorState(game.id);
                    if (specState && specState.success) {
                        const myAgent = specState.data.agents.find(a => a.name === (currentAccount.accountName || currentAccount.name));
                        if (myAgent && myAgent.isAlive) {
                            agentId = myAgent.id;
                            gameId = game.id;
                            log(`[Lobby] Resumed session! Agent ID: ${agentId}`);
                            break;
                        }
                    }
                } else {
                    logErr(`[Lobby] Registration failed for ${game.id}: [${registration?.error?.code}] ${registration?.error?.message}`);
                }
            }

            if (!agentId) {
                const jitter = Math.floor(Math.random() * 2000);
                log(`[Lobby] Could not join any rooms. Retrying scan in ${2 + (jitter / 1000)}s...`);
                await new Promise(r => setTimeout(r, 2000 + jitter));
            }
        }

        // 2. Game Loop
        log("[Loop] Fetching item catalogue...");
        const itemsResp = await molty.getItems();
        const weaponCatalogue = {};
        if (itemsResp && itemsResp.success) {
            itemsResp.data.weapons.forEach(w => {
                weaponCatalogue[w.name.toLowerCase()] = w;
            });
        }

        log("[Loop] Starting autonomous game loop (one action per 60s)...");

        while (true) {
            try {
                const stateResp = await molty.getAgentState(gameId, agentId);
                if (!stateResp || !stateResp.success) {
                    if (stateResp?.error?.code === 'NETWORK_ERROR') {
                        const jitter = Math.floor(Math.random() * 2000); // 0-2s jitter
                        log(`[Loop] Network/SSL error fetching state. Retrying in ${2 + (jitter / 1000)}s...`);
                        await new Promise(r => setTimeout(r, 2000 + jitter));
                        continue;
                    }
                    if (stateResp?.error?.code === 'AGENT_NOT_FOUND') {
                        // ... logic for AGENT_NOT_FOUND ...
                        log("[Loop] Agent not found. Checking if room is still waiting...");
                        const specState = await molty.getSpectatorState(gameId);
                        if (specState && specState.success) {
                            if (specState.data.status === 'waiting') {
                                log(`[Loop] Room ${gameId} is still waiting. Attempting to re-join...`);
                                const reReg = await molty.registerAgent(gameId, currentAccount.accountName || currentAccount.name);
                                if (reReg && reReg.success) {
                                    agentId = reReg.data.id;
                                    log(`[Loop] Successfully re-joined! New Agent ID: ${agentId}`);
                                    continue;
                                }
                            }
                            // If room is running/live, maybe we are in it?
                            log("[Loop] Room is active. Attempting session recovery...");
                            const recovered = await molty.findActiveSession(currentAccount.accountName || currentAccount.name);
                            if (recovered) {
                                gameId = recovered.gameId;
                                agentId = recovered.agentId;
                                log(`[Loop] Recovered session in active game: ${gameId}.`);
                                continue;
                            }
                        }
                        log("[Loop] Could not re-join or game already started. Triggering new discovery...");
                        agentId = null;
                        break; // Break inner loop to trigger discovery
                    }
                    if (stateResp?.error?.code === 'GAME_NOT_FOUND') {
                        log("[Loop] Game not found (finished or deleted). Returning to lobby...");
                        agentId = null;
                        break;
                    }
                    log("[Loop] State unavailable. Retrying in 2s...");
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                const state = stateResp.data;
                const { self, currentRegion, gameStatus, visibleAgents, visibleMonsters, visibleItems } = state;

                if (gameStatus === 'finished') {
                    log("=== Game Finished ===");
                    agentId = null;
                    break;
                }

                if (gameStatus === 'waiting') {
                    log(`[Lobby] Still waiting... Agents: ${state.agentCount || '?'}. Sync in 3s...`);
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                if (!self.isAlive) {
                    log("=== Agent has died. Initiating account rotation... ===");

                    let nextAcc = await getAvailableAccount(molty, log);

                    if (!nextAcc) {
                        log("[Pool] No free accounts in pool. Creating NEW fallback account...");
                        molty.refreshIP();
                        const newName = 'IkiscreamBot_' + Math.floor(Math.random() * 9000 + 1000);
                        const result = await molty.createAccount(newName);

                        if (result && result.success) {
                            nextAcc = {
                                accountId: result.data.accountId,
                                accountName: result.data.name,
                                apiKey: result.data.apiKey,
                                ipAddress: molty.currentIP
                            };
                            saveToPool(nextAcc);
                            log(`[Pool] New account created and added to pool: ${nextAcc.accountName}`);
                        }
                    }

                    if (nextAcc) {
                        log(`[Rotation] Switching current session to: ${nextAcc.accountName}`);
                        currentAccount = {
                            ...currentAccount,
                            accountId: nextAcc.accountId,
                            accountName: nextAcc.accountName,
                            apiKey: nextAcc.apiKey,
                            ipAddress: nextAcc.ipAddress
                        };

                        // Update the active molty client for the next iteration
                        molty.setApiKey(currentAccount.apiKey);
                        molty.currentIP = currentAccount.ipAddress;
                        molty.currentUA = molty.getRandomUA();

                        agentId = null; // Force room discovery
                        gameId = null;
                        break; // Exit inner combat loop to restart discovery
                    } else {
                        logErr("[Rotation] Critical: Failed to find or create a new account. Waiting 10s...");
                        await new Promise(r => setTimeout(r, 10000));
                        break;
                    }
                }

                log(`\n--- Status: HP ${self.hp}/${self.maxHp} | EP ${self.ep}/${self.maxEp} | Kills ${self.kills} | Pos: ${currentRegion.name} ---`);
                if (self.equippedWeapon) {
                    log(`[Gear] Equipped: ${self.equippedWeapon.name} (+${self.equippedWeapon.atkBonus} ATK, Range ${self.equippedWeapon.range})`);
                } else {
                    log(`[Gear] No weapon equipped.`);
                }

                // Strategy Logic - AGGRESSIVE MODE
                let action = null;
                let thought = { reasoning: "Analyzing surroundings for targets.", plannedAction: "None" };

                // Weapon Priority Logic Helper
                const isBetterWeapon = (newWName) => {
                    const newW = weaponCatalogue[newWName.toLowerCase()];
                    if (!newW) return false;
                    if (!self.equippedWeapon) return true;
                    if (newW.atkBonus > self.equippedWeapon.atkBonus) return true;
                    if (newW.atkBonus === self.equippedWeapon.atkBonus && newW.range > self.equippedWeapon.range) return true;
                    return false;
                };

                const isBetterThan = (w1, w2) => {
                    const stats1 = weaponCatalogue[w1.name.toLowerCase()] || { atkBonus: 0, range: 1 };
                    const stats2 = weaponCatalogue[w2.name.toLowerCase()] || { atkBonus: 0, range: 1 };
                    if (stats1.atkBonus > stats2.atkBonus) return true;
                    if (stats1.atkBonus === stats2.atkBonus && stats1.range > stats2.range) return true;
                    return false;
                };

                const inventoryItems = self.inventory;
                const inventoryWeapons = inventoryItems.filter(i => i.category === 'weapon');

                // Detection for specific recovery items
                const energyDrink = inventoryItems.find(i => i.name.toLowerCase() === 'energy_drink');
                const medkit = inventoryItems.find(i => i.name.toLowerCase() === 'medkit');
                const bandage = inventoryItems.find(i => i.name.toLowerCase() === 'bandage');
                const food = inventoryItems.find(i => i.name.toLowerCase() === 'emergency_food');

                let bestInvWeapon = null;
                for (const w of inventoryWeapons) {
                    if (isBetterWeapon(w.name)) {
                        if (!bestInvWeapon || isBetterThan(w, bestInvWeapon)) {
                            bestInvWeapon = w;
                        }
                    }
                }

                // --- AGGRESSIVE PRIORITY STACK ---

                // 1. Equip better gear immediately
                if (bestInvWeapon) {
                    action = { type: 'equip', itemId: bestInvWeapon.id };
                    thought = { reasoning: `Found better weapon in inventory: ${bestInvWeapon.name}. Equipping for maximum damage.`, plannedAction: "Equip" };
                }
                // 2. High Priority: Energy Restoration (Critical for actions)
                else if (self.ep < 5 && energyDrink) {
                    action = { type: 'use_item', itemId: energyDrink.id };
                    thought = { reasoning: "EP below 5. Using energy_drink to stay active.", plannedAction: "Restore Energy" };
                }
                // 3. High Priority: Kill Agents (Players)
                else if (self.ep >= 2 && visibleAgents.length > 0) {
                    // Focus fire on the weakest target first
                    const target = visibleAgents.sort((a, b) => a.hp - b.hp)[0];
                    action = { type: 'attack', targetId: target.id, targetType: 'agent' };
                    thought = { reasoning: `Targeting agent ${target.name} (${target.hp} HP). Priority: Player Elimination.`, plannedAction: "Attack" };
                }
                // 4. Emergency Healing (Only if below 40% HP)
                else if (self.hp < self.maxHp * 0.4 && (medkit || bandage || food) && self.ep >= 1) {
                    const itemToUse = medkit || bandage || food;
                    action = { type: 'use_item', itemId: itemToUse.id };
                    thought = { reasoning: `HP below 40%. Using ${itemToUse.name} for tactical recovery.`, plannedAction: "Heal" };
                }
                // 5. Secondary Combat: Hunt Monsters
                else if (self.ep >= 2 && visibleMonsters.length > 0) {
                    const target = visibleMonsters[0];
                    action = { type: 'attack', targetId: target.id, targetType: 'monster' };
                    thought = { reasoning: `No agents nearby. Hunting ${target.name} for loot/stats.`, plannedAction: "Attack" };
                }
                // 5. Looting: Only pick up when clear of enemies
                else if (visibleItems.length > 0 && self.inventory.length < 10) {
                    const moltzItemIndex = visibleItems.findIndex(vi => vi.item.name === '$Moltz' || vi.item.name === 'Moltz');
                    const betterWeaponIndex = visibleItems.findIndex(vi => vi.item.category === 'weapon' && isBetterWeapon(vi.item.name));

                    if (moltzItemIndex !== -1) {
                        action = { type: 'pickup', itemId: visibleItems[moltzItemIndex].item.id };
                        thought = { reasoning: "Spotted Moltz currency. Collecting while clear.", plannedAction: "Pickup" };
                    } else if (betterWeaponIndex !== -1) {
                        action = { type: 'pickup', itemId: visibleItems[betterWeaponIndex].item.id };
                        thought = { reasoning: `Looting better gear: ${visibleItems[betterWeaponIndex].item.name}.`, plannedAction: "Pickup" };
                    } else if (visibleItems.some(vi => vi.item.category !== 'weapon')) {
                        const nonWeapon = visibleItems.find(vi => vi.item.category !== 'weapon');
                        action = { type: 'pickup', itemId: nonWeapon.item.id };
                        thought = { reasoning: "Cleaning up nearby loot.", plannedAction: "Pickup" };
                    }
                }

                // 6. Default Actions
                if (!action && self.ep >= 1) {
                    action = { type: 'explore' };
                    thought = { reasoning: "Active sweep for targets and loot.", plannedAction: "Explore" };
                } else if (!action) {
                    action = { type: 'rest' };
                    thought = { reasoning: "Recovering Energy for next engagement.", plannedAction: "Rest" };
                }

                // Action Categories
                const group1Types = ['move', 'explore', 'attack', 'use_item', 'interact', 'rest'];
                const isGroup1 = (act) => group1Types.includes(act.type);

                if (action) {
                    log(`[Action] ${action.type} | ${thought.reasoning}`);
                    const result = await molty.executeAction(gameId, agentId, action, thought);

                    if (result && result.success) {
                        if (isGroup1(action)) {
                            const jitter = Math.floor(Math.random() * 3000); // 0-3s jitter
                            log(`[Loop] Action cooldown: ${5.5 + (jitter / 1000)}s including jitter...`);
                            await new Promise(r => setTimeout(r, 5500 + jitter));
                        } else {
                            log("[Loop] Minor action detected. No cooldown. Proceeding...");
                            await new Promise(r => setTimeout(r, 500)); // Fast safety pause
                        }
                    } else if (result?.error?.code === 'NETWORK_ERROR') {
                        const jitter = Math.floor(Math.random() * 2000);
                        log(`[Loop] Network/SSL error encountered. Retrying in ${2 + (jitter / 1000)}s...`);
                        await new Promise(r => setTimeout(r, 2000 + jitter));
                        continue; // Immediate retry for network issues
                    } else if (result?.error?.code === 'ALREADY_ACTED') {
                        log("[Loop] Already acted. Waiting 3s before retry...");
                        await new Promise(r => setTimeout(r, 3000));
                    } else {
                        log("[Loop] Action failed. Retrying in 5s...");
                        await new Promise(r => setTimeout(r, 5000));
                    }
                } else {
                    log("[Loop] No immediate tasks. Checking again in 2s...");
                    await new Promise(r => setTimeout(r, 2000));
                }

            } catch (err) {
                logErr("[Loop Error]", err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        log("[System] Game cycle finished. Waiting 10s before restarting...");
        await new Promise(r => setTimeout(r, 10000));
    }
}

// Export for manager
if (require.main === module) {
    (async () => {
        console.log("=== Molty Royale AI Agent Starting ===");

        // Parse CLI Arguments
        const args = process.argv.slice(2);
        const argMap = {};
        for (let i = 0; i < args.length; i++) {
            if (args[i].startsWith('--')) {
                argMap[args[i].slice(2)] = args[i + 1];
                i++;
            }
        }

        loadConfig();

        // Override or initialize config from arguments
        if (argMap.apiKey) config.apiKey = argMap.apiKey;
        if (argMap.ip) config.ipAddress = argMap.ip;
        if (argMap.name) config.accountName = argMap.name;
        if (argMap.id) config.accountId = argMap.id;

        // 1. Account Initialization
        if (!config.apiKey) {
            console.log(`[Auth] Creating new account: ${config.accountName}...`);
            const molty = new MoltyClient();
            molty.refreshIP();
            molty.setApiKey(null);
            const result = await molty.createAccount(config.accountName);
            if (result && result.success) {
                config.apiKey = result.data.apiKey;
                config.accountId = result.data.accountId;
                config.ipAddress = molty.currentIP;
                saveConfig();
                console.log(`[Auth] Account created! API Key saved to config.json`);
            } else {
                console.error("[Auth] Failed to create initial account.");
                process.exit(1);
            }
        }
        await startBattle(config);
    })().catch(console.error);
}

module.exports = { MoltyClient, generateRandomIP, startBattle };
