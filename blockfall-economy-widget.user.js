// ==UserScript==
// @name         Blockfall Economy Viewer
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Auto-display Blockfall economy data as floating widget on the page
// @author       You
// @match        https://blockfall.io/play*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=blockfall.io
// @grant        GM_xmlhttpRequest
// @require      https://bundle.run/buffer@6.0.3
// @require      https://unpkg.com/@solana/web3.js@1.98.0/lib/index.iife.min.js
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('bf-economy-widget')) return;

  // Polyfill Buffer for solanaWeb3
  if (typeof window !== 'undefined' && window.buffer && !window.Buffer) {
    window.Buffer = window.buffer.Buffer;
  }

  // --- State ---
  let autoOpenBoxEnabled = true;
  let autoOpenBoxInterval = null;
  let autoOpenBoxDelay = 5000; // ms between checks
  let openBoxCount = 0;
  let lastOpenBoxResult = null;

  let autoListEnabled = true;
  let autoListInterval = null;
  let autoListDelay = 10000; // ms between scans
  let listCount = 0;
  let lastListResult = null;

  // --- Wallet State ---
  let walletPublicKey = null;   // base58 pubkey string (stored, never private key)
  let walletSOL = null;         // SOL balance in lamports
  let walletBLOCK = null;       // BLOCK token balance (ui amount)
  let vaultPublicKey = null;
  let vaultSOL = null;
  let vaultBLOCK = null;
  let walletLoading = false;

  // --- Bot State ---
  let botRunning = localStorage.getItem('bfBotAutoOn') !== 'false'; // Defaults to true if not explicitly set to false
  let botLogs = [];
  const TRANSFER_AMOUNT = 0n; // 0 = transfer all
  const INTERVAL = 30 * 1000; // 30s

  const BLOCK_MINT = 'GKUwfyQoJ9apCaoWyYaQ9RT8inZed469v41M1Ljb1ock';
  const SOLANA_RPC = 'https://mainnet.helius-rpc.com/?api-key=8571e27e-eb74-4db1-b26a-877f75a74b19';

  // Auto-refresh on 403 (5 min cooldown via localStorage)
  const BF_REFRESH_KEY = 'bf_last_refresh';
  const BF_COOLDOWN = 5 * 60 * 1000; // 5 minutes
  let refreshTimeout = null;
  function handle403() {
    if (refreshTimeout) return;
    const last = parseInt(localStorage.getItem(BF_REFRESH_KEY) || '0', 10);
    const elapsed = Date.now() - last;
    if (elapsed < BF_COOLDOWN) {
      console.log(`[BF Extension] 403 detected but cooldown active, waiting ${Math.ceil((BF_COOLDOWN - elapsed) / 1000)}s`);
      return;
    }
    localStorage.setItem(BF_REFRESH_KEY, Date.now().toString());
    console.log('[BF Extension] 403 detected, refreshing in 3s...');
    refreshTimeout = setTimeout(() => { location.reload(); }, 3000);
  }

  const originalFetch = window.fetch;

  // ============================================================
  // --- Solana Wallet Utilities ---
  // ============================================================

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET.charAt(i)] = i;

  function decodeBase58(string) {
    if (string.length === 0) return new Uint8Array(0);
    let bytes = [0];
    for (let i = 0; i < string.length; i++) {
      const c = string[i];
      if (!(c in ALPHABET_MAP)) throw new Error('Karakter base58 tidak valid');
      for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
      bytes[0] += ALPHABET_MAP[c];
      let carry = 0;
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] += carry;
        carry = bytes[j] >> 8;
        bytes[j] &= 0xff;
      }
      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (let i = 0; i < string.length && string[i] === '1'; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  function encodeBase58(buffer) {
    if (buffer.length === 0) return '';
    let digits = [0];
    for (let i = 0; i < buffer.length; i++) {
      for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
      digits[0] += buffer[i];
      let carry = 0;
      for (let j = 0; j < digits.length; j++) {
        digits[j] += carry;
        carry = (digits[j] / 58) | 0;
        digits[j] %= 58;
      }
      while (carry) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) digits.push(0);
    return digits.reverse().map(digit => ALPHABET[digit]).join('');
  }

  function extractPublicKey(inputStr) {
    let privKeyBytes;
    inputStr = inputStr.trim();
    if (inputStr.startsWith('[')) {
      try {
        privKeyBytes = new Uint8Array(JSON.parse(inputStr));
      } catch (e) {
        throw new Error("Format array private key tidak valid");
      }
    } else {
      privKeyBytes = decodeBase58(inputStr);
    }

    if (privKeyBytes.length === 64) {
      // Solana secret key is 64 bytes (32 byte seed + 32 byte public key)
      const pubKeyBytes = privKeyBytes.slice(32);
      return encodeBase58(pubKeyBytes);
    } else if (privKeyBytes.length === 32) {
      // It might be a public key already
      return inputStr; // as base58
    } else {
      throw new Error("Panjang kunci tidak valid (harus 64 bytes untuk private, 32 bytes untuk public)");
    }
  }


  // --- Tampermonkey fetch wrapper for cross-origin RPC ---
  function gmFetch(url, options) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        // Fallback to original window.fetch if GM_xmlhttpRequest is not available
        window.fetch(url, options).then(resolve).catch(reject);
        return;
      }
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: url,
        headers: options.headers,
        data: options.body,
        onload: function (response) {
          resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText || '',
            url: response.finalUrl || url,
            headers: {
              get: (name) => {
                if (!response.responseHeaders) return null;
                const match = response.responseHeaders.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
                return match ? match[1] : null;
              }
            },
            text: () => Promise.resolve(response.responseText),
            json: () => Promise.resolve(JSON.parse(response.responseText)),
            clone: function () { return this; }
          });
        },
        onerror: function (error) {
          reject(new Error("Network Error"));
        }
      });
    });
  }

  // --- Solana RPC: Get SOL balance ---
  async function getSolanaBalance(pubkey) {
    const res = await gmFetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [pubkey, { commitment: 'confirmed' }]
      })
    });
    if (!res.ok) throw new Error(`Solana RPC error: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.result.value; // in lamports
  }

  // --- Solana RPC: Get token accounts by owner for BLOCK mint (Supports Token-2022) ---
  async function getBlockTokenBalance(pubkey) {
    // 1. Coba fetch dari Token Program standar
    let res = await gmFetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getTokenAccountsByOwner',
        params: [
          pubkey,
          { mint: BLOCK_MINT },
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]
      })
    });
    let data = await res.json();
    let accounts = data.result?.value || [];

    // 2. Jika tidak ada, coba fetch menggunakan Token-2022 Program secara eksplisit
    if (accounts.length === 0) {
      res = await gmFetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 3,
          method: 'getTokenAccountsByOwner',
          params: [
            pubkey,
            { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
            { encoding: 'jsonParsed', commitment: 'confirmed' }
          ]
        })
      });
      data = await res.json();
      const allToken22 = data.result?.value || [];
      // Filter berdasarkan CA (BLOCK_MINT)
      accounts = allToken22.filter(acc => acc.account.data.parsed.info.mint === BLOCK_MINT);
    }

    if (accounts.length === 0) return { uiAmount: 0, uiAmountString: '0', amount: '0', decimals: 0 };
    // Take first account's balance
    const tokenAmount = accounts[0].account.data.parsed.info.tokenAmount;
    return tokenAmount;
  }

  // --- Load / refresh wallet balances ---
  async function refreshWalletBalances() {
    if ((!walletPublicKey && !vaultPublicKey) || walletLoading) return;
    walletLoading = true;
    updateWalletUI();
    try {
      if (walletPublicKey) {
        walletSOL = await getSolanaBalance(walletPublicKey).catch(e => { console.error('Main SOL error:', e); return null; });
        walletBLOCK = await getBlockTokenBalance(walletPublicKey).catch(e => { console.error('Main BLOCK error:', e); return null; });
      }
      if (vaultPublicKey) {
        vaultSOL = await getSolanaBalance(vaultPublicKey).catch(e => { console.error('Vault SOL error:', e); return null; });
        vaultBLOCK = await getBlockTokenBalance(vaultPublicKey).catch(e => { console.error('Vault BLOCK error:', e); return null; });
      }
    } catch (err) {
      console.error('[BF Wallet] Unexpected balance fetch error:', err.message);
    } finally {
      walletLoading = false;
      updateWalletUI();
    }
  }

  // --- Remove wallet ---
  function removeWallet() {
    walletPublicKey = null;
    walletSOL = null;
    walletBLOCK = null;
    localStorage.removeItem('bfWalletPubkey');
    localStorage.removeItem('bfWalletPrivkey');
    updateWalletUI();
  }

  function removeVault() {
    vaultPublicKey = null;
    vaultSOL = null;
    vaultBLOCK = null;
    localStorage.removeItem('bfVaultPubkey');
    localStorage.removeItem('bfVaultPrivkey');
    updateWalletUI();
  }

  // --- Format SOL (lamports → SOL) ---
  function formatSOL(lamports) {
    if (lamports === null) return '...';
    return (lamports / 1e9).toFixed(4) + ' SOL';
  }

  // --- Format BLOCK token ---
  function formatBLOCK(tokenAmount) {
    if (tokenAmount === null) return '...';
    const n = parseFloat(tokenAmount.uiAmountString || '0');
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M BLOCK';
    if (n >= 1000) return (n / 1000).toFixed(2) + 'K BLOCK';
    return n.toFixed(2) + ' BLOCK';
  }

  // --- Shorten public key display ---
  function shortenKey(key) {
    if (!key) return '';
    return key.slice(0, 6) + '...' + key.slice(-4);
  }

  // --- Update wallet section UI (without full re-render) ---
  function updateWalletUI() {
    const container = document.getElementById('bf-wallet-container');
    if (!container) return;

    let html = '';

    // Main Wallet
    if (!walletPublicKey) {
      html += `
        <div style="text-align:center;padding:4px 0;color:#555;font-size:10px;">
          <input type="password" id="bf-wallet-input" placeholder="Main Wallet: Private/Pub Key" style="width:100%; box-sizing:border-box; background:rgba(0,0,0,0.2); border:1px solid rgba(167,139,250,0.3); color:#fff; padding:4px; border-radius:4px; font-size:9px; text-align:center; margin-bottom:4px;">
          <div id="bf-wallet-error" style="color:#f44336;font-size:9px;margin-bottom:4px;display:none;"></div>
          <button class="bf-btn" id="bf-wallet-save" style="margin-top:0;">Import Main Wallet</button>
        </div>
      `;
    } else {
      const solText = walletLoading ? '⏳' : formatSOL(walletSOL);
      const blockText = walletLoading ? '⏳' : formatBLOCK(walletBLOCK);
      html += `
        <div class="bf-row" style="align-items:flex-start;">
          <span class="bf-label">Wallet</span>
          <span style="font-size:9px;color:#888;font-family:monospace;word-break:break-all;text-align:right;max-width:130px;">${shortenKey(walletPublicKey)}</span>
        </div>
        <div class="bf-row">
          <span class="bf-label">SOL</span>
          <span class="bf-val cyan">${solText}</span>
        </div>
        <div class="bf-row">
          <span class="bf-label">🟣 BLOCK (SPL22)</span>
          <span class="bf-val" style="color:#a78bfa;">${blockText}</span>
        </div>
        <div style="display:flex;gap:4px;margin-top:2px;">
          <button class="bf-btn danger" id="bf-wallet-remove" style="flex:1;margin-top:0;font-size:9px;padding:3px;">✕ Remove Main</button>
        </div>
      `;
    }

    // Divider
    html += '<div style="margin:8px 0;border-top:1px dashed rgba(167,139,250,0.3);"></div>';

    // Vault Wallet
    if (!vaultPublicKey) {
      html += `
        <div style="text-align:center;padding:4px 0;color:#555;font-size:10px;">
          <input type="password" id="bf-vault-input" placeholder="Vault Wallet: Private/Pub Key" style="width:100%; box-sizing:border-box; background:rgba(0,0,0,0.2); border:1px solid rgba(167,139,250,0.3); color:#fff; padding:4px; border-radius:4px; font-size:9px; text-align:center; margin-bottom:4px;">
          <div id="bf-vault-error" style="color:#f44336;font-size:9px;margin-bottom:4px;display:none;"></div>
          <button class="bf-btn" id="bf-vault-save" style="margin-top:0;">Import Vault Wallet</button>
        </div>
      `;
    } else {
      const solText = walletLoading ? '⏳' : formatSOL(vaultSOL);
      const blockText = walletLoading ? '⏳' : formatBLOCK(vaultBLOCK);
      html += `
        <div class="bf-row" style="align-items:flex-start;">
          <span class="bf-label">Vault</span>
          <span style="font-size:9px;color:#888;font-family:monospace;word-break:break-all;text-align:right;max-width:130px;">${shortenKey(vaultPublicKey)}</span>
        </div>
        <div class="bf-row">
          <span class="bf-label">SOL</span>
          <span class="bf-val cyan">${solText}</span>
        </div>
        <div class="bf-row">
          <span class="bf-label">🟣 BLOCK (SPL22)</span>
          <span class="bf-val" style="color:#a78bfa;">${blockText}</span>
        </div>
        <div style="display:flex;gap:4px;margin-top:2px;">
          <button class="bf-btn danger" id="bf-vault-remove" style="flex:1;margin-top:0;font-size:9px;padding:3px;">✕ Remove Vault</button>
        </div>
      `;
    }

    // Refresh All Button
    if (walletPublicKey || vaultPublicKey) {
      html += `
        <button class="bf-btn" id="bf-wallet-refresh" style="width:100%;margin-top:6px;">
          &#8635; Refresh Balances
        </button>
      `;
    }

    container.innerHTML = html;

    // Attach Events
    document.getElementById('bf-wallet-save')?.addEventListener('click', () => {
      const val = document.getElementById('bf-wallet-input').value.trim();
      const errEl = document.getElementById('bf-wallet-error');
      if (val) {
        try {
          const pubKey = extractPublicKey(val);
          if (val !== pubKey) localStorage.setItem('bfWalletPrivkey', val);
          walletPublicKey = pubKey;
          localStorage.setItem('bfWalletPubkey', pubKey);
          errEl.style.display = 'none';
          updateWalletUI();
          refreshWalletBalances();
        } catch (e) {
          errEl.textContent = e.message;
          errEl.style.display = 'block';
        }
      }
    });

    document.getElementById('bf-vault-save')?.addEventListener('click', () => {
      const val = document.getElementById('bf-vault-input').value.trim();
      const errEl = document.getElementById('bf-vault-error');
      if (val) {
        try {
          const pubKey = extractPublicKey(val);
          if (val !== pubKey) localStorage.setItem('bfVaultPrivkey', val);
          vaultPublicKey = pubKey;
          localStorage.setItem('bfVaultPubkey', pubKey);
          errEl.style.display = 'none';
          updateWalletUI();
          refreshWalletBalances();
        } catch (e) {
          errEl.textContent = e.message;
          errEl.style.display = 'block';
        }
      }
    });

    document.getElementById('bf-wallet-remove')?.addEventListener('click', removeWallet);
    document.getElementById('bf-vault-remove')?.addEventListener('click', removeVault);
    document.getElementById('bf-wallet-refresh')?.addEventListener('click', refreshWalletBalances);
  }

  // --- Bot UI ---
  function addBotLog(msg) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    botLogs.push(`[${time}] ${msg}`);
    if (botLogs.length > 20) botLogs.shift();
    updateBotUI();
  }

  function updateBotUI() {
    const container = document.getElementById('bf-bot-container');
    if (!container) return;

    const privWallet = localStorage.getItem('bfWalletPrivkey');
    const privVault = localStorage.getItem('bfVaultPrivkey');

    let html = '';

    if (!privWallet || !privVault) {
      html += `<div style="color:#f44336;font-size:9px;text-align:center;padding:4px;">Main/Vault Private Keys required!</div>`;
    } else {
      html += `
        <div class="bf-consume-row">
          <span class="bf-label" style="color:${botRunning ? '#4caf50' : '#f44336'}">${botRunning ? 'RUNNING' : 'STOPPED'}</span>
          <button class="bf-toggle ${botRunning ? 'on' : ''}" id="bf-bot-toggle"></button>
        </div>
       `;
    }

    // Terminal
    html += `
      <div style="margin-top:6px;background:rgba(0,0,0,0.4);border:1px solid rgba(245,158,11,0.3);border-radius:4px;padding:4px;height:60px;overflow-y:auto;font-family:monospace;font-size:8px;color:#bbb;white-space:pre-wrap;display:flex;flex-direction:column-reverse;">
        <div>${botLogs.slice().reverse().join('<br>')}</div>
      </div>
    `;

    container.innerHTML = html;

    document.getElementById('bf-bot-toggle')?.addEventListener('click', () => {
      botRunning = !botRunning;
      localStorage.setItem('bfBotAutoOn', botRunning);
      if (botRunning) {
        addBotLog('Bot Started.');
        runBotCycle(); // start cycle
      } else {
        addBotLog('Bot Stopped.');
      }
      updateBotUI();
    });
  }

  // --- Auto-Transfer Bot Logic ---
  let cycleInProgress = false;

  async function runBotCycle() {
    if (cycleInProgress) return;
    if (!botRunning) return;
    cycleInProgress = true;

    try {
      const privWalletHex = localStorage.getItem('bfWalletPrivkey');
      const privVaultHex = localStorage.getItem('bfVaultPrivkey');
      if (!privWalletHex || !privVaultHex) throw new Error("Missing private keys");

      addBotLog("Initializing Solana Web3...");
      const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } = solanaWeb3;

      const connection = new Connection(SOLANA_RPC, { fetch: gmFetch, commitment: 'confirmed' });
      const wallet = Keypair.fromSecretKey(decodeBase58(privWalletHex));
      const vault = Keypair.fromSecretKey(decodeBase58(privVaultHex));
      const tokenMint = new PublicKey(BLOCK_MINT);

      const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

      let tokenProgramId = TOKEN_2022_PROGRAM_ID;

      // SPL-Token manual helpers
      function getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve = true, programId = TOKEN_2022_PROGRAM_ID) {
        return PublicKey.findProgramAddressSync(
          [owner.toBytes(), programId.toBytes(), mint.toBytes()],
          ASSOCIATED_TOKEN_PROGRAM_ID
        )[0];
      }

      function createAssociatedTokenAccountInstruction(payer, associatedToken, owner, mint, programId = TOKEN_2022_PROGRAM_ID) {
        return new solanaWeb3.TransactionInstruction({
          keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: associatedToken, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: false },
          ],
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          data: new Uint8Array(0)
        });
      }

      function createTransferInstruction(source, destination, owner, amount, multiSigners = [], programId = TOKEN_2022_PROGRAM_ID) {
        const data = new Uint8Array(9);
        data[0] = 3; // Transfer instruction index
        const view = new DataView(data.buffer);
        view.setBigUint64(1, BigInt(amount), true); // little-endian
        return new solanaWeb3.TransactionInstruction({
          keys: [
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false }
          ],
          programId,
          data
        });
      }

      function createCloseAccountInstruction(account, destination, authority, multiSigners = [], programId = TOKEN_2022_PROGRAM_ID) {
        const data = new Uint8Array(1);
        data[0] = 9; // CloseAccount instruction index
        return new solanaWeb3.TransactionInstruction({
          keys: [
            { pubkey: account, isSigner: false, isWritable: true },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: authority, isSigner: true, isWritable: false }
          ],
          programId,
          data
        });
      }

      async function getAccount(connection, address, commitment, programId) {
        const info = await connection.getParsedAccountInfo(address, commitment);
        if (!info.value) throw new Error("Token account not found");
        return { amount: BigInt(info.value.data.parsed.info.tokenAmount.amount) };
      }

      // Helpers within cycle scope
      async function getBalanceByOwner(owner) {
        const ata = getAssociatedTokenAddress(tokenMint, owner, true, tokenProgramId);
        try {
          const info = await getAccount(connection, ata, 'confirmed', tokenProgramId);
          return { amount: info.amount, address: ata };
        } catch {
          return { amount: 0n, address: ata };
        }
      }

      async function sendTx(ixs, signers = [wallet]) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          try {
            const tx = new Transaction();
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }));
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
            ixs.forEach(ix => tx.add(ix));

            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = signers[0].publicKey;
            tx.sign(...signers);

            const rawTransaction = tx.serialize();
            const txid = await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 5 });

            // Poll using HTTP to avoid WebSocket CSP errors
            let confirmed = false;
            while (!confirmed) {
                const { value } = await connection.getSignatureStatuses([txid]);
                const status = value && value[0];
                if (status) {
                    if (status.err) throw new Error(`Tx failed: ${JSON.stringify(status.err)}`);
                    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                        confirmed = true;
                        break;
                    }
                }
                const blockHeight = await connection.getBlockHeight('confirmed');
                if (blockHeight > lastValidBlockHeight) {
                    const error = new Error("Transaction expired");
                    error.name = 'TransactionExpiredBlockheightExceededError';
                    throw error;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            return txid;
          } catch (e) {
            if (e.name === 'TransactionExpiredBlockheightExceededError' || (e.message && e.message.includes('expired'))) {
              attempts++;
              addBotLog(`Tx expired, retrying (${attempts}/${maxAttempts})...`);
              if (attempts >= maxAttempts) {
                throw new Error("Transaction expired after maximum retries.");
              }
            } else {
              throw e;
            }
          }
        }
      }

      async function getOrCreateAta(owner, payerKeypair) {
        const ata = getAssociatedTokenAddress(tokenMint, owner, true, tokenProgramId);
        try {
          await getAccount(connection, ata, 'confirmed', tokenProgramId);
          return ata;
        } catch {
          const ix = createAssociatedTokenAccountInstruction(payerKeypair.publicKey, ata, owner, tokenMint, tokenProgramId);
          await sendTx([ix], [payerKeypair]);
          return ata;
        }
      }

      function fmtAmount(amount, decimals = 9) {
        const d = BigInt(10 ** decimals);
        return `${amount / d}.${(amount % d).toString().padStart(decimals, '0')}`;
      }

      // Cycle Start
      addBotLog(`[SCAN] Wallet: ${wallet.publicKey.toBase58().slice(0, 6)}...`);

      const walletBal = await getBalanceByOwner(wallet.publicKey);
      addBotLog(`[SCAN] Wallet balance: ${fmtAmount(walletBal.amount)}`);

      if (walletBal.amount === 0n) {
        addBotLog('[SCAN] Wallet empty. Next cycle...');
      } else {
        // Vault sends tokens to wallet
        const vaultBal = await getBalanceByOwner(vault.publicKey);
        if (vaultBal.amount > 0n) {
          addBotLog(`[STEP 1] Vault → Wallet...`);
          const walletAtaNew = await getOrCreateAta(wallet.publicKey, vault);
          const transferAmt = TRANSFER_AMOUNT === 0n ? vaultBal.amount : (TRANSFER_AMOUNT <= vaultBal.amount ? TRANSFER_AMOUNT : vaultBal.amount);

          const vaultAta = getAssociatedTokenAddress(tokenMint, vault.publicKey, true, tokenProgramId);
          const transferIx = createTransferInstruction(vaultAta, walletAtaNew, vault.publicKey, Number(transferAmt), [], tokenProgramId);
          const transferTx = await sendTx([transferIx], [vault]);
          addBotLog(`[STEP 1] TX Success (Vault->Wallet)`);
        }

        // Wait 60s
        addBotLog('[STEP 2] Waiting 60 seconds...');
        if (!botRunning) { cycleInProgress = false; return; }
        await new Promise(r => setTimeout(r, 60000));
        if (!botRunning) { cycleInProgress = false; return; }

        // Send back all tokens Wallet -> Vault
        addBotLog('[STEP 3] Wallet → Vault (All tokens)...');
        const walletBalFinal = await getBalanceByOwner(wallet.publicKey);
        if (walletBalFinal.amount > 0n) {
          const vaultAtaFinal = await getOrCreateAta(vault.publicKey, wallet);
          const walletAtaFinal = getAssociatedTokenAddress(tokenMint, wallet.publicKey, true, tokenProgramId);

          const finalTransferIx = createTransferInstruction(walletAtaFinal, vaultAtaFinal, wallet.publicKey, Number(walletBalFinal.amount), [], tokenProgramId);
          await sendTx([finalTransferIx], [wallet]);
          addBotLog(`[STEP 3] TX Success (Wallet->Vault)`);

          addBotLog('[STEP 4] Reclaiming SOL...');
          const closeIx = createCloseAccountInstruction(walletAtaFinal, vault.publicKey, wallet.publicKey, [], tokenProgramId);
          await sendTx([closeIx], [wallet]);
          addBotLog(`[STEP 4] Close TX Success`);
        }
      }

      addBotLog('[DONE] Cycle complete.');
      refreshWalletBalances();

    } catch (e) {
      addBotLog(`Error: ${e.message}`);
      console.error(e);
    }

    cycleInProgress = false;

    // Schedule next cycle if still running
    if (botRunning) {
      setTimeout(() => {
        if (botRunning) runBotCycle();
      }, INTERVAL);
    }
  }

  // --- API calls ---
  async function fetchEconomy() {
    const res = await originalFetch('https://blockfall.io/api/economy', {
      method: 'GET',
      credentials: 'include',
      headers: { 'accept': '*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }
    });
    if (!res.ok) { if (res.status === 403) handle403(); throw new Error(`Economy HTTP ${res.status}`); }
    return await res.json();
  }

  async function openBox() {
    const res = await originalFetch('https://blockfall.io/api/economy/box/open', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'accept': '*/*',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });
    if (!res.ok) throw new Error(`OpenBox HTTP ${res.status}`);
    return await res.json();
  }

  // --- Market API ---
  async function fetchMarketInventory() {
    const res = await originalFetch('https://blockfall.io/api/market?inventory=1', {
      method: 'GET',
      credentials: 'include',
      headers: { 'accept': '*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }
    });
    if (!res.ok) { if (res.status === 403) handle403(); throw new Error(`MarketInventory HTTP ${res.status}`); }
    return await res.json();
  }

  async function fetchMarketPrice(blockName) {
    const res = await originalFetch(`https://blockfall.io/api/market?block=${encodeURIComponent(blockName)}&period=7d`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'accept': '*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }
    });
    if (!res.ok) throw new Error(`MarketPrice HTTP ${res.status}`);
    return await res.json();
  }

  async function listItem(itemId, price, count) {
    const res = await originalFetch('https://blockfall.io/api/market/list', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      },
      body: JSON.stringify({ itemId, price, count })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const errMsg = body?.detail || body?.message || body?.error || `HTTP ${res.status}`;
      throw new Error(errMsg);
    }
    return body;
  }

  async function fetchMarketMine() {
    const res = await originalFetch('https://blockfall.io/api/market?mine=1', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': '*/*',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });
    if (!res.ok) throw new Error(`MarketMine HTTP ${res.status}`);
    return await res.json();
  }

  // --- Check if item is already listed (not sold) ---
  function parseActiveListings(mineData) {
    const active = {};
    if (!mineData) return active;

    let items = [];
    if (Array.isArray(mineData)) {
      items = mineData;
    } else if (mineData.listings && Array.isArray(mineData.listings)) {
      items = mineData.listings;
    } else if (mineData.items && Array.isArray(mineData.items)) {
      items = mineData.items;
    } else if (mineData.active && Array.isArray(mineData.active)) {
      items = mineData.active;
    } else if (mineData.data && Array.isArray(mineData.data)) {
      items = mineData.data;
    } else {
      for (const key of Object.keys(mineData)) {
        if (Array.isArray(mineData[key]) && mineData[key].length > 0) {
          items = mineData[key];
          break;
        }
      }
    }

    for (const item of items) {
      // Try multiple field names for item id and name
      const id = item.id || item.itemId || item.blockId || item.block || item.item || item.item_id;
      const name = item.name || item.blockName || '';
      const status = (item.status || item.state || '').toLowerCase();
      const count = item.count || item.amount || item.qty || item.quantity || 1;

      // Only skip if explicitly sold/cancelled/expired
      const isSold = status === 'sold' || status === 'complete' || status === 'completed';
      const isCancelled = status === 'cancelled' || status === 'canceled' || status === 'removed';
      const isExpired = status === 'expired' || status === 'ended';

      if (!isSold && !isCancelled && !isExpired && count > 0) {
        // Store both id and name as keys for flexible matching
        if (id) active[id] = true;
        if (name) active[name] = true;
      }
    }

    console.log('[BF Extension] Active listings:', Object.keys(active));
    return active;
  }

  // --- Auto open box logic ---
  async function doOpenBox() {
    if (!autoOpenBoxEnabled) return;

    try {
      const eco = await fetchEconomy();
      if (eco.box && eco.box.stored > 0) {
        const result = await openBox();
        lastOpenBoxResult = { ok: true, data: result };
        openBoxCount++;
      } else {
        lastOpenBoxResult = { ok: true, data: null, empty: true };
      }
      updateOpenBoxStatus();
    } catch (err) {
      lastOpenBoxResult = { ok: false, error: err.message };
      updateOpenBoxStatus();
    }
  }

  function startAutoOpenBox() {
    if (autoOpenBoxInterval) return;
    autoOpenBoxEnabled = true;
    doOpenBox(); // immediate first check
    autoOpenBoxInterval = setInterval(doOpenBox, autoOpenBoxDelay);
  }

  function stopAutoOpenBox() {
    autoOpenBoxEnabled = false;
    if (autoOpenBoxInterval) {
      clearInterval(autoOpenBoxInterval);
      autoOpenBoxInterval = null;
    }
  }

  function updateOpenBoxStatus() {
    const el = document.getElementById('bf-openbox-status');
    if (!el) return;
    if (!autoOpenBoxEnabled) {
      el.textContent = 'OFF';
      el.style.color = '#555';
    } else if (lastOpenBoxResult?.empty) {
      el.textContent = `#${openBoxCount} No box`;
      el.style.color = '#888';
    } else if (lastOpenBoxResult?.ok) {
      el.textContent = `#${openBoxCount} OK`;
      el.style.color = '#4caf50';
    } else {
      el.textContent = lastOpenBoxResult?.error || 'Error';
      el.style.color = '#f44336';
    }
  }

  // --- Auto market listing logic ---
  async function doAutoList() {
    if (!autoListEnabled) return;

    try {
      // Fetch inventory and current market listings in parallel
      const [inventory, mineData] = await Promise.all([
        fetchMarketInventory(),
        fetchMarketMine().catch(err => {
          console.warn('[BF Extension] Failed to fetch market mine data:', err);
          return null;
        })
      ]);

      // Parse active listings to check if item already listed
      const activeListings = parseActiveListings(mineData);
      console.log('[BF Extension] Active listings:', Object.keys(activeListings));

      console.log('[BF Extension] Market inventory response:', JSON.stringify(inventory));

      // Try multiple response structures
      let items = [];
      if (Array.isArray(inventory)) {
        items = inventory;
      } else if (inventory.items) {
        items = inventory.items;
      } else if (inventory.inventory) {
        items = inventory.inventory;
      } else if (inventory.listings) {
        items = inventory.listings;
      } else {
        // Try to find any array in the response
        for (const key of Object.keys(inventory)) {
          if (Array.isArray(inventory[key])) {
            items = inventory[key];
            console.log(`[BF Extension] Found items in key: ${key}`);
            break;
          }
        }
      }

      if (!items.length) {
        console.log('[BF Extension] No items found in inventory. Response keys:', Object.keys(inventory));
        lastListResult = { ok: true, empty: true };
        updateListStatus();
        return;
      }

      console.log(`[BF Extension] Found ${items.length} items in inventory`);
      let listed = 0;
      let skipped = 0;
      let alreadyListed = 0;

      for (const item of items) {
        console.log('[BF Extension] Processing item:', JSON.stringify(item));

        // Try multiple field names for item id
        const itemId = item.id || item.itemId || item.blockId || item.block || item.item;
        const itemName = item.name || '';
        // Tier check
        const tier = item.tier || 0;

        if (!itemId) {
          console.warn('[BF Extension] No itemId found for item:', item);
          continue;
        }

        // Only list tier 3 and above
        if (tier < 3) {
          console.log(`[BF Extension] Skipping ${itemId}, tier ${tier} < 3`);
          skipped++;
          continue;
        }

        // Check if item is already listed (not sold yet)
        // Inventory uses id (snake_case), my listing uses name (Title Case) - check both
        const isListed = activeListings[itemId] || activeListings[itemName];
        if (isListed) {
          console.log(`[BF Extension] Skipping ${itemId}, already listed`);
          alreadyListed++;
          continue;
        }

        try {
          // Price: tier 3-4 = default 10, tier 5-7 = floor price
          let price = 10;
          if (tier >= 5) {
            const marketData = await fetchMarketPrice(itemId);
            const detail = marketData?.detail || marketData;
            price = detail?.floor || 10;
          }

          // List with qty=1
          console.log(`[BF Extension] Listing ${itemId} x1 at ${price} (tier: ${tier})`);
          const listResult = await listItem(itemId, price, 1);
          console.log(`[BF Extension] List result for ${itemId}:`, JSON.stringify(listResult));
          listed++;
          listCount++;
          console.log(`[BF Extension] Successfully listed ${itemId}`);

          // Delay between listings to avoid rate limiting
          await delay(1500);
        } catch (itemErr) {
          console.warn(`[BF Extension] List ${itemId} failed:`, itemErr.message);
        }
      }

      lastListResult = { ok: true, listed, skipped, alreadyListed };
      updateListStatus();
    } catch (err) {
      console.error('[BF Extension] Auto list error:', err);
      lastListResult = { ok: false, error: err.message };
      updateListStatus();
    }
  }

  function startAutoList() {
    if (autoListInterval) return;
    autoListEnabled = true;
    doAutoList(); // immediate first scan
    autoListInterval = setInterval(doAutoList, autoListDelay);
  }

  function stopAutoList() {
    autoListEnabled = false;
    if (autoListInterval) {
      clearInterval(autoListInterval);
      autoListInterval = null;
    }
  }

  function updateListStatus() {
    const el = document.getElementById('bf-list-status');
    if (!el) return;
    if (!autoListEnabled) {
      el.textContent = 'OFF';
      el.style.color = '#555';
    } else if (lastListResult?.empty) {
      el.textContent = 'No items';
      el.style.color = '#888';
    } else if (lastListResult?.ok) {
      const waiting = lastListResult.alreadyListed || 0;
      el.textContent = `#${listCount} OK${waiting > 0 ? ` (${waiting} waiting)` : ''}`;
      el.style.color = '#4caf50';
    } else {
      el.textContent = lastListResult?.error || 'Error';
      el.style.color = '#f44336';
    }
  }

  // --- Formatting helpers ---
  function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  function formatTimer(sec) {
    if (sec <= 0) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --- Inject CSS ---
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #bf-economy-widget {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        width: 230px;
        background: rgba(15, 20, 35, 0.92);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(0, 212, 255, 0.25);
        border-radius: 12px;
        font-family: 'Segoe UI', sans-serif;
        color: #e0e0e0;
        font-size: 12px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
        user-select: none;
      }
      #bf-economy-widget.bf-minimized .bf-body { display: none; }
      .bf-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        cursor: move;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .bf-header-title { font-weight: 700; font-size: 11px; color: #00d4ff; letter-spacing: 0.5px; }
      .bf-header-buttons { display: flex; gap: 4px; }
      .bf-header-buttons button {
        background: none; border: none; color: #888; cursor: pointer;
        font-size: 14px; padding: 0 3px; line-height: 1;
      }
      .bf-header-buttons button:hover { color: #fff; }
      .bf-body { 
        padding: 8px 10px 10px; 
        max-height: calc(100vh - 80px); 
        overflow-y: auto; 
        overflow-x: hidden; 
      }
      .bf-body::-webkit-scrollbar { width: 4px; }
      .bf-body::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 4px; }
      .bf-body::-webkit-scrollbar-thumb { background: rgba(0,212,255,0.4); border-radius: 4px; }
      .bf-row {
        display: flex; justify-content: space-between; align-items: center; padding: 4px 0;
      }
      .bf-row + .bf-row { border-top: 1px solid rgba(255,255,255,0.04); }
      .bf-label { color: #777; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
      .bf-val { font-weight: 700; font-size: 13px; }
      .bf-val.gold { color: #ffd700; }
      .bf-val.cyan { color: #00d4ff; }
      .bf-val.red { color: #ff6b6b; }
      .bf-val.green { color: #4caf50; }
      .bf-val.orange { color: #ff9800; }
      .bf-sub { font-size: 9px; color: #555; text-align: right; }
      .bf-progress {
        width: 100%; height: 3px; background: rgba(255,255,255,0.08);
        border-radius: 2px; margin-top: 3px;
      }
      .bf-progress-fill {
        height: 100%; background: linear-gradient(90deg, #00d4ff, #00ff88);
        border-radius: 2px; transition: width 0.4s;
      }
      .bf-btn {
        display: block; width: 100%; margin-top: 6px; padding: 5px;
        background: rgba(0,212,255,0.1); border: 1px solid rgba(0,212,255,0.2);
        border-radius: 6px; color: #00d4ff; font-size: 10px;
        cursor: pointer; text-align: center;
      }
      .bf-btn:hover { background: rgba(0,212,255,0.2); }
      .bf-btn.active { background: rgba(76,175,80,0.2); border-color: rgba(76,175,80,0.4); color: #4caf50; }
      .bf-btn.danger { background: rgba(244,67,54,0.15); border-color: rgba(244,67,54,0.3); color: #f44336; }
      .bf-timer { font-size: 9px; color: #ff6b6b; text-align: right; margin-top: 2px; }
      .bf-loading { text-align: center; padding: 16px; color: #555; }
      .bf-section-label {
        font-size: 9px; color: #00d4ff; text-transform: uppercase;
        letter-spacing: 1px; margin-top: 8px; margin-bottom: 4px;
        padding-bottom: 3px; border-bottom: 1px solid rgba(0,212,255,0.15);
      }
      .bf-consume-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 0; gap: 6px;
      }
      .bf-toggle {
        position: relative; width: 36px; height: 20px;
        background: #333; border-radius: 10px; cursor: pointer;
        border: none; padding: 0; transition: background 0.2s;
      }
      .bf-toggle.on { background: #4caf50; }
      .bf-toggle::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 16px; height: 16px; background: #fff; border-radius: 50%;
        transition: transform 0.2s;
      }
      .bf-toggle.on::after { transform: translateX(16px); }

      /* Wallet section styles */
      #bf-wallet-container input {
        user-select: text !important;
        -webkit-user-select: text !important;
      }
      #bf-wallet-container input:focus {
        border-color: rgba(167, 139, 250, 0.6) !important;
        box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.1);
      }
      .bf-val-purple { color: #a78bfa; }
    `;
    document.head.appendChild(style);
  }

  // --- Build widget ---
  function createWidget() {
    injectStyles();
    const widget = document.createElement('div');
    widget.id = 'bf-economy-widget';
    widget.innerHTML = `
      <div class="bf-header">
        <span class="bf-header-title">BF ECONOMY</span>
        <div class="bf-header-buttons">
          <button id="bf-refresh" title="Refresh">&#8635;</button>
          <button id="bf-minimize" title="Minimize">&#9472;</button>
          <button id="bf-close" title="Hide">&#10005;</button>
        </div>
      </div>
      <div class="bf-body">
        <div class="bf-loading">Loading...</div>
      </div>
    `;
    document.body.appendChild(widget);
    makeDraggable(widget);

    document.getElementById('bf-minimize').addEventListener('click', () => widget.classList.toggle('bf-minimized'));
    document.getElementById('bf-close').addEventListener('click', () => widget.style.display = 'none');
    document.getElementById('bf-refresh').addEventListener('click', () => loadData(true));

    return widget;
  }

  function makeDraggable(el) {
    const header = el.querySelector('.bf-header');
    let dragging = false, sx, sy, ix, iy;
    header.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ix = r.left; iy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      el.style.left = (ix + e.clientX - sx) + 'px';
      el.style.top = (iy + e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => dragging = false);
  }

  // --- Parse Sold Data ---
  function renderSoldData(mineData) {
    if (!mineData) return '';

    let soldItems = [];
    if (mineData.sold && Array.isArray(mineData.sold)) {
      soldItems = mineData.sold;
    } else if (Array.isArray(mineData)) {
      soldItems = mineData.filter(i => i.status === 'sold' || i.sold);
    } else if (mineData.items && Array.isArray(mineData.items)) {
      soldItems = mineData.items.filter(i => i.status === 'sold' || i.sold);
    } else {
      // Fallback: search values if object
      for (const key of Object.keys(mineData)) {
        if (Array.isArray(mineData[key])) {
          const possibleSold = mineData[key].filter(i => i.status === 'sold' || i.sold);
          if (possibleSold.length > 0) soldItems.push(...possibleSold);
        }
      }
    }

    if (soldItems.length === 0) return '';

    let soldCount = 0;
    let soldGold = 0;

    for (const item of soldItems) {
      soldCount += (item.count || item.amount || 1);
      const itemPrice = item.total !== undefined ? item.total : (item.price || 0) * (item.count || item.amount || 1);
      soldGold += itemPrice;
    }

    if (soldCount === 0 && soldGold === 0) return '';

    return `
      <div class="bf-row" style="margin-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px;">
        <span class="bf-label">Sold Items</span>
        <span class="bf-val" style="color: #4caf50;">${formatNumber(soldCount)}</span>
      </div>
      <div class="bf-row">
        <span class="bf-label">Sold Value</span>
        <span class="bf-val gold">+${formatNumber(soldGold)}</span>
      </div>
    `;
  }

  // --- Render ---
  function renderBody(data, mineData) {
    const box = data.box;
    const lvl = data.level;
    const xpPct = lvl.need > 0 ? (lvl.into / lvl.need * 100) : 0;

    let timerHTML = '';
    if (box.nextBoxInSec > 0) {
      timerHTML = `<div class="bf-timer">Next box: ${formatTimer(box.nextBoxInSec)}</div>`;
    } else if (box.stored < box.cap) {
      timerHTML = `<div class="bf-timer" style="color:#4caf50">Box ready!</div>`;
    }

    return `
      <div class="bf-row">
        <span class="bf-label">Balance</span>
        <span class="bf-val gold">${formatNumber(data.balance)}</span>
      </div>
      <div class="bf-row">
        <span class="bf-label">Level</span>
        <span class="bf-val cyan">${lvl.level}</span>
      </div>
      <div class="bf-row">
        <span class="bf-sub" style="width:100%">${lvl.into} / ${lvl.need} XP</span>
      </div>
      <div class="bf-progress"><div class="bf-progress-fill" style="width:${xpPct}%"></div></div>
      <div class="bf-row">
        <span class="bf-label">Box</span>
        <span class="bf-val red">${box.stored} / ${box.cap}</span>
      </div>
      ${timerHTML}
      <div class="bf-row">
        <span class="bf-label">Staked</span>
        <span class="bf-val green">${formatNumber(data.staked)}</span>
      </div>
      <div class="bf-row">
        <span class="bf-label">Achievements</span>
        <span class="bf-val orange">${data.achievementsUnlocked}</span>
      </div>
      ${renderSoldData(mineData)}
      <button class="bf-btn" id="bf-refresh-inner">&#8635; Refresh</button>

      <div class="bf-section-label">Auto Open Box</div>
      <div class="bf-consume-row">
        <span class="bf-label" id="bf-openbox-status" style="color:#555">OFF</span>
        <button class="bf-toggle ${autoOpenBoxEnabled ? 'on' : ''}" id="bf-openbox-toggle"></button>
      </div>
      ${autoOpenBoxEnabled ? `<div class="bf-sub" style="text-align:left;margin-top:2px;">
        Every ${autoOpenBoxDelay / 1000}s | Opened: ${openBoxCount}
      </div>` : ''}

      <div class="bf-section-label">Auto Market List</div>
      <div class="bf-consume-row">
        <span class="bf-label" id="bf-list-status" style="color:#555">OFF</span>
        <button class="bf-toggle ${autoListEnabled ? 'on' : ''}" id="bf-list-toggle"></button>
      </div>
      ${autoListEnabled ? `<div class="bf-sub" style="text-align:left;margin-top:2px;">
        Every ${autoListDelay / 1000}s | Listed: ${listCount}${lastListResult?.alreadyListed ? ` | Waiting: ${lastListResult.alreadyListed}` : ''}
      </div>` : ''}

      <div class="bf-section-label" style="color:#a78bfa;border-color:rgba(167,139,250,0.2);">Solana Wallet</div>
      <div id="bf-wallet-container"></div>
      
      <div class="bf-section-label" style="color:#f59e0b;border-color:rgba(245,158,11,0.2);">Auto-Transfer Bot</div>
      <div id="bf-bot-container"></div>
    `;
  }

  // --- Load data ---
  async function loadData(manual = false) {
    const widget = document.getElementById('bf-economy-widget') || createWidget();
    const body = widget.querySelector('.bf-body');
    const scrollTop = body.scrollTop;
    if (manual) body.innerHTML = '<div class="bf-loading">Refreshing...</div>';

    try {
      const [data, mineData] = await Promise.all([
        fetchEconomy(),
        fetchMarketMine().catch(err => {
          console.warn('[BF Extension] Failed to fetch market mine data:', err);
          return null;
        })
      ]);
      body.innerHTML = renderBody(data, mineData);

      // Re-attach buttons
      const refreshBtn = document.getElementById('bf-refresh-inner');
      if (refreshBtn) refreshBtn.addEventListener('click', () => loadData(true));

      // Open box toggle
      const openBoxToggle = document.getElementById('bf-openbox-toggle');
      if (openBoxToggle) {
        openBoxToggle.addEventListener('click', () => {
          if (autoOpenBoxEnabled) {
            stopAutoOpenBox();
          } else {
            startAutoOpenBox();
          }
          loadData();
        });
      }

      updateOpenBoxStatus();

      // Market list toggle
      const listToggle = document.getElementById('bf-list-toggle');
      if (listToggle) {
        listToggle.addEventListener('click', () => {
          if (autoListEnabled) {
            stopAutoList();
          } else {
            startAutoList();
          }
          loadData();
        });
      }

      updateListStatus();

      // Always render wallet and bot section after body is set
      updateWalletUI();
      updateBotUI();
      
      // Restore scroll position
      if (!manual) body.scrollTop = scrollTop;
    } catch (err) {
      body.innerHTML = `
        <div class="bf-loading" style="color:#f44336">Error: ${err.message}</div>
        <div class="bf-section-label" style="color:#a78bfa;border-color:rgba(167,139,250,0.2);">Solana Wallet</div>
        <div id="bf-wallet-container"></div>
        <div class="bf-section-label" style="color:#f59e0b;border-color:rgba(245,158,11,0.2);">Auto-Transfer Bot</div>
        <div id="bf-bot-container"></div>
      `;
      updateWalletUI();
      updateBotUI();
    }
  }

  // --- Init ---
  function init() {
    if (document.body) {
      createWidget();
      // Load economy data first, then init wallet UI once DOM is ready
      loadData().then(() => {
        startAutoOpenBox();
        startAutoList();
        // Restore saved wallet public keys
        const savedWallet = localStorage.getItem('bfWalletPubkey');
        const savedVault = localStorage.getItem('bfVaultPubkey');
        if (savedWallet) walletPublicKey = savedWallet;
        if (savedVault) vaultPublicKey = savedVault;

        updateWalletUI();
        updateBotUI();
        if (walletPublicKey || vaultPublicKey) {
          refreshWalletBalances();
        }

        // Start bot automatically if enabled and keys exist
        if (botRunning && localStorage.getItem('bfWalletPrivkey') && localStorage.getItem('bfVaultPrivkey')) {
          runBotCycle();
        }

        // Auto-refresh economy and wallet balances every 60s
        setInterval(() => {
          loadData(false);
          if (walletPublicKey || vaultPublicKey) refreshWalletBalances();
        }, 60000);
      }).catch(() => {
        startAutoOpenBox();
        startAutoList();
        updateWalletUI();
      });
    } else {
      setTimeout(init, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
