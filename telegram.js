const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Manual .env parser to avoid external dependencies
 * Handles Windows (\r\n) and Unix (\n) line endings, and ignores comments.
 */
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        console.log(`[Telegram] .env not found at ${envPath}`);
        return;
    }

    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n');

    lines.forEach(line => {
        // Strip comments and trim carriage returns
        const cleanLine = line.split('#')[0].trim();
        if (!cleanLine) return;

        const match = cleanLine.match(/^([\w.-]+)\s*=\s*(.*)?$/);
        if (match) {
            const key = match[1];
            let value = match[2] || '';
            // Handle quotes
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
                value = value.substring(1, value.length - 1);
            }
            process.env[key] = value.trim();
        }
    });

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        console.log(`[Telegram] Environment variables loaded.`);
    } else {
        console.warn(`[Telegram] Warning: Credentials missing in .env`);
    }
}

// Initial load
loadEnv();

/**
 * Sends a document to a Telegram chat using manual multipart construction.
 * @param {string} filePath - Path to the file to send
 * @param {string} caption - Optional caption for the document
 */
async function sendDocument(filePath, caption = '') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error("[Telegram] Missing credentials. Cannot send document.");
        return;
    }

    if (!fs.existsSync(filePath)) {
        console.error(`[Telegram] File not found: ${filePath}`);
        return;
    }

    try {
        const fileContent = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const boundary = `----MoltyAgentBoundary${Math.random().toString(36).substring(2)}`;

        // Construct multipart/form-data manually
        let bodyParts = [];

        // chat_id
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));

        // caption
        if (caption) {
            bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
        }

        // document
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/json\r\n\r\n`));
        bodyParts.push(fileContent);
        bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const payload = Buffer.concat(bodyParts);
        const url = `https://api.telegram.org/bot${token}/sendDocument`;

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length
            }
        });

        if (response.data && response.data.ok) {
            console.log(`[Telegram] File ${fileName} sent successfully.`);
        } else {
            console.error(`[Telegram] Failed to send file: ${JSON.stringify(response.data)}`);
        }
    } catch (error) {
        console.error(`[Telegram] Error sending document: ${error.message}`);
    }
}

/**
 * Sends a plain text message to a Telegram chat.
 * @param {string} text - Message text
 */
async function sendMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error("[Telegram] Missing credentials. Cannot send message.");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        });

        if (response.data && response.data.ok) {
            console.log(`[Telegram] Message sent successfully.`);
        } else {
            console.error(`[Telegram] Failed to send message: ${JSON.stringify(response.data)}`);
        }
    } catch (error) {
        console.error(`[Telegram] Error sending message: ${error.message}`);
    }
}

module.exports = { sendDocument, sendMessage };
