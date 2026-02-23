const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { MoltyClient, generateRandomIP, startBattle } = require('./molty-agent');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const MAX_LOG_LINES = 50;
const runningBots = {}; // { accountId: { config, logs: [], active: true, process: null, promise: null } }
let currentViewAccountId = null;
let integratedMode = true; // Default to Integrated Mode for stability on Armbian

function loadAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        try {
            const parsed = JSON.parse(data);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            return [];
        }
    }
    return [];
}

function saveAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function startBot(account) {
    if (runningBots[account.accountId]) {
        return; // Already running
    }

    const bot = {
        config: account,
        logs: [`[System] Bot starting as child process for ${account.name}...`],
        active: true,
        process: null
    };
    runningBots[account.accountId] = bot;

    const logHandler = (msg) => {
        const timestamp = new Date().toLocaleTimeString();
        const cleanedMsg = msg.replace(/\n$/, ''); // Remove trailing newline
        const formattedMsg = `[${timestamp}] ${cleanedMsg}`;
        bot.logs.push(formattedMsg);
        if (bot.logs.length > MAX_LOG_LINES) bot.logs.shift();

        // If this bot is being viewed, print to terminal
        if (currentViewAccountId === account.accountId) {
            process.stdout.write(formattedMsg + '\n');
        }
    };

    try {
        if (integratedMode) {
            logHandler(`[System] Starting bot in INTEGRATED mode (Single Process)...`);
            bot.promise = startBattle(account, logHandler);
            bot.promise.catch(err => {
                bot.active = false;
                logHandler(`[System] Integrated bot crashed: ${err.message}`);
            });
        } else {
            console.log(`[System] Spawning process for ${account.name}...`);
            const child = spawn(process.execPath, [
                path.join(__dirname, 'molty-agent.js'),
                '--apiKey', account.apiKey,
                '--ip', account.ipAddress,
                '--name', account.name,
                '--id', account.accountId
            ]);

            bot.process = child;

            child.stdout.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) logHandler(line);
                });
            });

            child.stderr.on('data', (data) => {
                logHandler(`[ERR] ${data.toString()}`);
            });

            child.on('close', (code) => {
                bot.active = false;
                logHandler(`[System] Process exited with code ${code}`);
            });

            child.on('error', (err) => {
                bot.active = false;
                logHandler(`[System] Failed to start process: ${err.message}`);
            });
        }
    } catch (err) {
        bot.active = false;
        logHandler(`[System] CRITICAL ERROR spawning process: ${err.message}`);
    }
}

async function createAccount() {
    return new Promise((resolve) => {
        rl.question('\nEnter Account Name: ', async (name) => {
            if (!name) {
                console.log('Name cannot be empty.');
                return resolve();
            }

            const molty = new MoltyClient();
            console.log(`[Auth] Creating account "${name}"...`);
            molty.refreshIP();

            const result = await molty.createAccount(name);
            if (result && result.success) {
                const accounts = loadAccounts();
                const newAcc = {
                    accountId: result.data.accountId,
                    name: result.data.name,
                    apiKey: result.data.apiKey,
                    ipAddress: molty.currentIP,
                    createdAt: result.data.createdAt
                };
                accounts.push(newAcc);
                saveAccounts(accounts);
                console.log(`[Success] Account created! ID: ${newAcc.accountId}`);
                console.log(`[Battle] Starting bot in background...`);
                startBot(newAcc);
            } else {
                console.error('[Error] Failed to create account.');
            }
            resolve();
        });
    });
}

async function bulkCreateAccounts() {
    return new Promise((resolve) => {
        rl.question('\nHow many accounts to create? (default 10): ', async (countStr) => {
            const count = parseInt(countStr) || 10;
            const accounts = loadAccounts();
            console.log(`[Auth] Creating ${count} accounts with pattern DracinAgent_XYZ...`);

            for (let i = 0; i < count; i++) {
                let name;
                let exists = true;
                const prefixes = ['Kayrel_', 'GolDracin_', 'Ikiscream_', 'RedmiNote_', 'Samsung_'];
                while (exists) {
                    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
                    const rand = Math.floor(Math.random() * 9000) + 1000; // 1000-9999
                    name = `${prefix}${rand}`;
                    exists = accounts.some(acc => acc.name === name);
                }

                const molty = new MoltyClient();
                molty.refreshIP();

                const result = await molty.createAccount(name);
                if (result && result.success) {
                    const newAcc = {
                        accountId: result.data.accountId,
                        name: result.data.name,
                        apiKey: result.data.apiKey,
                        ipAddress: molty.currentIP,
                        createdAt: result.data.createdAt
                    };
                    accounts.push(newAcc);
                    saveAccounts(accounts);
                    console.log(`[${i + 1}/${count}] Success: ${newAcc.name} (ID: ${newAcc.accountId})`);
                    startBot(newAcc);
                } else {
                    console.error(`[${i + 1}/${count}] Error: Failed to create ${name}.`);
                }
                // Increased delay to avoid hitting server too hard
                await new Promise(r => setTimeout(r, 3000));
            }
            console.log(`[Complete] ${count} accounts processed.`);
            resolve();
        });
    });
}

async function viewBattle() {
    const accounts = loadAccounts();
    console.log('\n=== LOG VIEWER / ACCOUNT LIST ===');
    if (accounts.length === 0) {
        console.log('No accounts found.');
        return;
    }

    accounts.forEach((acc, index) => {
        const status = runningBots[acc.accountId] ? (runningBots[acc.accountId].active ? 'RUNNING' : 'FINISHED') : 'IDLE';
        console.log(`${index + 1}. [${acc.name}] - ${status} (ID: ${acc.accountId})`);
    });
    console.log('S. Start All Bots');
    console.log('B. Back');
    console.log('=====================\n');

    return new Promise((resolve) => {
        rl.question('Select option or account number: ', async (choice) => {
            const lowerChoice = choice.toLowerCase();
            if (lowerChoice === 'b' || choice === '') {
                return resolve();
            }

            if (lowerChoice === 's') {
                const idleAccounts = accounts.filter(acc => !runningBots[acc.accountId] || !runningBots[acc.accountId].active);
                console.log(`[System] Starting ${idleAccounts.length} idle bots...`);
                for (const acc of idleAccounts) {
                    startBot(acc);
                    await new Promise(r => setTimeout(r, 1500)); // Increased stagger to prevent surge of 429s
                }
                console.log('[System] All bots triggered. Press ENTER to refresh list.');
                return resolve();
            }

            const index = parseInt(choice) - 1;
            if (!isNaN(index) && accounts[index]) {
                const selected = accounts[index];
                if (!runningBots[selected.accountId]) {
                    console.log(`[System] Starting bot for ${selected.name}...`);
                    startBot(selected);
                }

                await showLogs(selected.accountId);
            }
            resolve();
        });
    });
}

async function viewAccountHistory() {
    const accounts = loadAccounts();
    console.log('\n=== ACCOUNT TRANSACTION HISTORY ===');
    if (accounts.length === 0) {
        console.log('No accounts found.');
        return;
    }

    accounts.forEach((acc, index) => {
        console.log(`${index + 1}. ${acc.name} (ID: ${acc.accountId})`);
    });
    console.log('B. Back');

    return new Promise((resolve) => {
        rl.question('\nSelect account to view history: ', async (choice) => {
            if (choice.toLowerCase() === 'b' || choice === '') return resolve();

            const index = parseInt(choice) - 1;
            if (!isNaN(index) && accounts[index]) {
                const acc = accounts[index];
                const molty = new MoltyClient(acc.apiKey, null, acc.ipAddress);
                console.log(`\n[System] Fetching info & history for ${acc.name}...`);

                const meResp = await molty.getMe();
                const histResp = await molty.getAccountHistory(50);

                if (meResp && meResp.success) {
                    const me = meResp.data;
                    console.log(`\n=== ACCOUNT SUMMARY: ${me.name} ===`);
                    console.log(`Balance: ${me.balance} $Moltz`);
                    console.log(`Total Games: ${me.totalGames} | Wins: ${me.totalWins}`);
                    console.log(`Verification: ${me.verificationCode || 'N/A'}`);
                    console.log(`Created At: ${new Date(me.createdAt).toLocaleString()}`);
                    console.log(`------------------------------------------`);
                }

                if (histResp && histResp.success) {
                    console.log(`\n--- Transaction History (Last 50) ---`);
                    if (histResp.data.length === 0) {
                        console.log('No transactions found.');
                    } else {
                        // Table Header
                        console.log('ID'.padEnd(20) + 'Type'.padEnd(15) + 'Amount'.padEnd(10) + 'Reason'.padEnd(30));
                        console.log('-'.repeat(75));

                        histResp.data.forEach(tx => {
                            const amount = tx.amount > 0 ? `+${tx.amount}` : tx.amount;
                            const safeId = tx.id ? `${tx.id.slice(0, 18)}...` : 'N/A'.padEnd(20);
                            const safeType = (tx.type || 'N/A').padEnd(15);
                            const safeReason = (tx.reason || 'N/A').slice(0, 30);

                            console.log(
                                (tx.id ? `${tx.id.slice(0, 18)}...` : 'N/A').padEnd(20) +
                                (tx.type || 'N/A').padEnd(15) +
                                String(amount).padEnd(10) +
                                safeReason
                            );
                        });
                    }
                    console.log('\n--- End of History ---');
                    rl.question('Press ENTER to return...', () => resolve());
                } else {
                    console.log('[Error] Failed to fetch history.');
                    resolve();
                }
            } else {
                console.log('Invalid choice.');
                resolve();
            }
        });
    });
}

async function showLogs(accountId) {
    currentViewAccountId = accountId;
    const bot = runningBots[accountId];

    console.log('\x1Bc'); // Clear terminal
    console.log(`=== LIVE LOGS: ${bot.config.name} ===`);
    console.log('--- (Press ENTER to stop viewing logs and return to menu) ---');

    // Print existing buffer
    bot.logs.forEach(line => console.log(line));

    return new Promise((resolve) => {
        // We wait for the next enter key to stop viewing logs
        const onData = (data) => {
            if (data.toString() === '\r' || data.toString() === '\n') {
                process.stdin.removeListener('data', onData);
                currentViewAccountId = null;
                resolve();
            }
        };
        process.stdin.on('data', onData);
    });
}

async function mainMenu() {
    console.log('\n--- MOLTY ROYALE MULTI-MANAGER ---');
    console.log('1. Create Account');
    console.log('2. View Battle & Logs');
    console.log('3. Account Transaction History');
    console.log(`4. Toggle Mode (Current: ${integratedMode ? 'LOW MEMORY / INTEGRATED' : 'PERFORMANCE / ISOLATED'})`);
    console.log('5. Exit');

    rl.question('Select option: ', async (choice) => {
        switch (choice) {
            case '1':
                rl.question('\n1. Single Account\n2. Bulk (Pattern: DracinAgent_XYZ)\nChoice: ', async (subChoice) => {
                    if (subChoice === '1') {
                        await createAccount();
                    } else if (subChoice === '2') {
                        await bulkCreateAccounts();
                    } else {
                        console.log('Invalid choice.');
                    }
                    mainMenu();
                });
                return; // Return because inner question will call mainMenu
            case '2':
                await viewBattle();
                break;
            case '3':
                await viewAccountHistory();
                break;
            case '4':
                integratedMode = !integratedMode;
                console.log(`\n[System] Mode switched to: ${integratedMode ? 'LOW MEMORY' : 'PERFORMANCE (Isolated Processes)'}`);
                if (!integratedMode) {
                    console.log('[Warning] Performance mode uses more RAM. Use carefully on Armbian.');
                }
                break;
            case '5':
                console.log('Goodbye! (Bots will be stopped)');
                process.exit(0);
                break;
            default:
                console.log('Invalid option.');
                break;
        }
        mainMenu();
    });
}

console.log('Starting Manager...');
mainMenu();
