const { default: makeWASocket, BufferJSON, initAuthCreds, proto, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://nuvaistudio.com/crm/api/whatsapp_webhook.php';
const MONGO_URI = process.env.MONGO_URI;
// Cargar la clave secreta desde las variables de entorno
const WEBHOOK_SECRET_KEY = process.env.WEBHOOK_SECRET_KEY || '';

// Variable global para almacenar la instancia del socket de Baileys
let sock = null;

// ==========================================
// ADAPTADOR NATIVO DE AUTENTICACIÓN PARA MONGODB
// ==========================================
async function useMongoDBAuthState(collection) {
  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await collection.updateOne(
      { _id: id },
      { $set: { value: json } },
      { upsert: true }
    );
  };

  const readData = async (id) => {
    const doc = await collection.findOne({ _id: id });
    if (doc && doc.value) {
      return JSON.parse(doc.value, BufferJSON.reviver);
    }
    return null;
  };

  const removeData = async (id) => {
    await collection.deleteOne({ _id: id });
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
// 1. MOTOR DE BAILEYS (Conexión MongoDB)
// ==========================================
async function connectToWhatsApp() {
  try {
    if (!MONGO_URI) {
      console.error('❌ Error: La variable MONGO_URI no está configurada en Render.');
      return;
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
      console.log('✅ Conectado exitosamente a MongoDB Atlas');
    }

    const collection = mongoose.connection.collection('whatsapp_sessions');
    const { state, saveCreds } = await useMongoDBAuthState(collection);

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
        console.log('✅ ¡CONEXIÓN ESTABLECIDA Y PERSISTIDA EN MONGODB!');
      }
    });

    // Escuchar mensajes entrantes REALES de WhatsApp
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;

        const text = msg.message?.conversation 
          || msg.message?.extendedTextMessage?.text 
          || '';

        if (!text.trim()) continue;

        const rawJid = msg.key.remoteJid || '';
        
        let fromNumber = rawJid;
        if (msg.key.participant) {
          fromNumber = msg.key.participant;
        }

        if (fromNumber.includes('@s.whatsapp.net')) {
          fromNumber = fromNumber.replace(/@.*$/, '').replace(/[^0-9]/g, '');
        } else if (!fromNumber.includes('@')) {
          fromNumber = fromNumber.replace(/[^0-9]/g, '');
        }

        let timestamp = msg.messageTimestamp;
        if (typeof timestamp === 'object' && timestamp !== null) {
          timestamp = timestamp.low;
        }
        timestamp = timestamp || Math.floor(Date.now() / 1000);

        const safeData = {
          id: msg.key.id || `msg_${Date.now()}`,
          from: fromNumber,
          rawJid: rawJid,
          name: msg.pushName && msg.pushName !== '-' ? msg.pushName : 'Usuario',
          text: text.trim(),
          timestamp: timestamp
        };

        console.log('[Baileys Real] Mensaje recibido de WhatsApp, enviando a PHP:', safeData);
        forwardToPhp(safeData);
      }
    });

  } catch (err) {
    console.error('Error al conectar con MongoDB o Baileys:', err.message);
  }
}

// ==========================================
// 2. ENDPOINTS EXPRESS
// ==========================================

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

    if (from.includes('@s.whatsapp.net')) {
      from = from.replace(/@.*$/, '').replace(/[^0-9]/g, '');
    }

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

app.post('/send-message', async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: 'Parámetros obligatorios: to y text' });
    }

    console.log(`[Outbound] Enviando respuesta a ${to}: "${text}"`);

    if (sock) {
      let formattedJid = to.trim();

      if (!formattedJid.includes('@')) {
        const cleanNumber = formattedJid.replace(/[^0-9]/g, '');
        formattedJid = `${cleanNumber}@s.whatsapp.net`;
      }

      await sock.sendMessage(formattedJid, { text: text });
      return res.status(200).json({ status: 'sent', to: formattedJid });
    }

    res.status(503).json({ error: 'Sesión de WhatsApp no inicializada aún en Engine' });

  } catch (error) {
    console.error('Error en /send-message:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Envió a PHP con encabezado de autenticación seguro
async function forwardToPhp(data) {
  try {
    const headers = { 
      'Content-Type': 'application/json' 
    };

    // Agregar el encabezado X-Api-Key si está configurado en las variables de entorno
    if (WEBHOOK_SECRET_KEY) {
      headers['X-Api-Key'] = WEBHOOK_SECRET_KEY;
    }

    const response = await fetch(PHP_WEBHOOK_URL, {
      method: 'POST',
      headers: headers,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Engine escuchando en el puerto ${PORT}`);
  connectToWhatsApp();
});