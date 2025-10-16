/**
 * Knight Bot - A WhatsApp Bot
 * Modified for Vercel Deployment
 */
require('./settings')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
const pino = require("pino")
const express = require('express')

// Import lightweight store
const store = require('./lib/lightweight_store')

// Initialize Express for Vercel
const app = express()
app.use(express.json())

// Vercel-specific session path
const SESSION_PATH = '/tmp/session'

// Initialize store
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

let phoneNumber = process.env.PHONE_NUMBER || "911234567890"
let owner = process.env.OWNER_NUMBER || "1234567890"

global.botname = "KNIGHT BOT"
global.themeemoji = "•"
const pairingCode = !!phoneNumber

// Web QR Code endpoint
app.get('/', async (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Knight Bot - WhatsApp</title>
        <style>
            body { font-family: Arial; text-align: center; padding: 50px; }
            .container { max-width: 500px; margin: 0 auto; }
            .qr-code { margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Knight Bot</h1>
            <p>Scan the QR code below with WhatsApp</p>
            <div class="qr-code" id="qrcode"></div>
            <p>Or enter pairing code in terminal</p>
        </div>
    </body>
    </html>
    `)
})

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Bot is running', timestamp: new Date().toISOString() })
})

async function startXeonBotInc() {
    let { version, isLatest } = await fetchLatestBaileysVersion()
    
    // Use /tmp for session storage in Vercel
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
    const msgRetryCounterCache = new NodeCache()

    const XeonBotInc = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            let jid = jidNormalizedUser(key.remoteJid)
            let msg = await store.loadMessage(jid, key.id)
            return msg?.message || ""
        },
        msgRetryCounterCache,
        defaultQueryTimeoutMs: undefined,
    })

    store.bind(XeonBotInc.ev)

    // Message handling
    XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0]
            if (!mek.message) return
            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message
            if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                await handleStatus(XeonBotInc, chatUpdate);
                return;
            }
            if (!XeonBotInc.public && !mek.key.fromMe && chatUpdate.type === 'notify') return
            if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return

            try {
                await handleMessages(XeonBotInc, chatUpdate, true)
            } catch (err) {
                console.error("Error in handleMessages:", err)
            }
        } catch (err) {
            console.error("Error in messages.upsert:", err)
        }
    })

    XeonBotInc.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server && decode.user + '@' + decode.server || jid
        } else return jid
    }

    XeonBotInc.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = XeonBotInc.decodeJid(contact.id)
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    XeonBotInc.getName = (jid, withoutContact = false) => {
        id = XeonBotInc.decodeJid(jid)
        withoutContact = XeonBotInc.withoutContact || withoutContact
        let v
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = XeonBotInc.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === XeonBotInc.decodeJid(XeonBotInc.user.id) ?
            XeonBotInc.user :
            (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    XeonBotInc.public = true
    XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store)

    // Handle pairing code
    if (pairingCode && !XeonBotInc.authState.creds.registered) {
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '')
        
        const pn = require('awesome-phonenumber');
        if (!pn('+' + cleanNumber).isValid()) {
            console.log(chalk.red('Invalid phone number in environment variables.'));
            return;
        }

        setTimeout(async () => {
            try {
                let code = await XeonBotInc.requestPairingCode(cleanNumber)
                code = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
                console.log(chalk.yellow(`\nPlease enter this code in your WhatsApp app`))
            } catch (error) {
                console.error('Error requesting pairing code:', error)
            }
        }, 3000)
    }

    // Connection handling
    XeonBotInc.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect } = s
        if (connection == "open") {
            console.log(chalk.yellow(`🌿Connected to => ` + JSON.stringify(XeonBotInc.user, null, 2)))
            
            console.log(chalk.yellow(`\n\n[ ${global.botname} ]\n\n`))
            console.log(chalk.green(`🤖 Bot Connected Successfully ✅`))
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(chalk.red('Session logged out. Please re-authenticate.'))
                startXeonBotInc()
            } else {
                startXeonBotInc()
            }
        }
    })

    XeonBotInc.ev.on('creds.update', saveCreds)
    XeonBotInc.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(XeonBotInc, update);
    });

    return XeonBotInc
}

// Start bot and server
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`)
    try {
        await startXeonBotInc()
    } catch (error) {
        console.error('Failed to start bot:', error)
    }
})

// Export for Vercel
module.exports = app
