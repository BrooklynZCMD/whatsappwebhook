const { default: makeWASocket, BufferJSON, initAuthCreds, proto, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://nuvaistudio.com/crm/api/whatsapp_webhook.php';

// Pool de conexión a MySQL
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'server62.shared.spaceship.host',
  user: process.env.DB_USER || 'dkzboynbfh_admin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dkzboynbfh_crm_db',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Variable global para almacenar la instancia del socket de Baileys
let sock = null;

// ==========================================
// ADAPTADOR DE AUTENTICACIÓN MYSQL
// ==========================================
async function useMySQLAuthState() {
  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await dbPool.query(
      'INSERT INTO whatsapp_auth (id, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [id, json]
    );
  };

  const readData = async (id) => {
    const [rows] = await dbPool.query('SELECT value FROM whatsapp_auth WHERE id = ?', [id]);
    if (rows.length > 0) {
      return JSON.parse(rows[0].value, BufferJSON.reviver);
    }
    return null;
  };

  const removeData = async (id) => {
    await dbPool.query('DELETE FROM whatsapp_auth WHERE id = ?', [id]);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

// ==========================================
// 1. MOTOR DE BAILEYS (Persistencia en MySQL)
// ==========================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMySQLAuthState();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==================================================');
      console.log('--- ESCANEA ESTE CÓDIGO QR DESDE TU WHATSAPP ---');
      console.log('==================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ ¡CONEXIÓN ESTABLECIDA CON ÉXITO Y GUARDADA EN MYSQL!');
    }
  });

  // Escuchar mensajes entrantes REALES de WhatsApp
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue; // Ignorar mis propios mensajes

      const text = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || '';

      if (!text.trim()) continue;

      const fromRaw = msg.key.remoteJid || '';
      const fromNumber = fromRaw.replace(/@.*$/, '').replace(/[^0-9]/g, '');

      let timestamp = msg.messageTimestamp;
      if (typeof timestamp === 'object' && timestamp !== null) {
        timestamp = timestamp.low;
      }
      timestamp = timestamp || Math.floor(Date.now() / 1000);

      const safeData = {
        id: msg.key.id || `msg_${Date.now()}`,
        from: fromNumber,
        name: msg.pushName && msg.pushName !== '-' ? msg.pushName : 'Usuario',
        text: text.trim(),
        timestamp: timestamp
      };

      console.log('[Baileys Real] Mensaje recibido de WhatsApp, enviando a PHP:', safeData);
      forwardToPhp(safeData);
    }
  });
}

// ==========================================
// 2. ENDPOINTS EXPRESS
// ==========================================

// Endpoint de prueba por cURL
app.post('/webhook', (req, res) => {
  try {
    const payload = req.body;
    res.status(200).send({ status: 'success' });

    if (!payload || typeof payload !== 'object') return;
    if (payload.fromMe || payload.key?.fromMe) return;

    const text = payload.text ? payload.text.trim() : '';
    if (!text) return;

    const messageId = payload.id || payload.key?.id || payload.message?.id || `msg_${Date.now()}`;
    let from = payload.from || payload.key?.remoteJid || '';
    if (!from) return;
    from = from.replace(/@.*$/, '').replace(/[^0-9]/g, '');

    let timestamp = payload.timestamp;
    if (typeof timestamp === 'object' && timestamp !== null) {
      timestamp = timestamp.low;
    }
    timestamp = timestamp || Math.floor(Date.now() / 1000);

    const safeData = {
      id: messageId,
      from: from,
      name: payload.name && payload.name !== '-' ? payload.name : 'Usuario',
      text: text,
      timestamp: timestamp
    };

    console.log(`[Webhook Manual] Enviando a PHP:`, safeData);
    forwardToPhp(safeData);

  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
});

// Endpoint para que PHP responda al cliente
app.post('/send-message', async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: 'Parámetros obligatorios: to y text' });
    }

    console.log(`[Outbound] Enviando respuesta a ${to}: "${text}"`);

    if (sock) {
      const formattedJid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(formattedJid, { text: text });
      return res.status(200).json({ status: 'sent', to: formattedJid });
    }

    res.status(503).json({ error: 'Sesión de WhatsApp no inicializada aún en Engine' });

  } catch (error) {
    console.error('Error en /send-message:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Reenvío hacia el CRM en PHP
async function forwardToPhp(data) {
  try {
    const response = await fetch(PHP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      console.error(`[PHP Error] Código HTTP: ${response.status}`);
    }
  } catch (error) {
    console.error('Error al enviar datos a PHP:', error.message);
  }
}

// Iniciar servidor y motor de Baileys
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Engine escuchando en el puerto ${PORT}`);
  connectToWhatsApp();
});