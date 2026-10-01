const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('📱 ABRE ESTA URL EN TU NAVEGADOR PARA ESCANEAR EL QR:');
      console.log(`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('🚀 ¡WhatsApp conectado exitosamente!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;

        const payload = {
          from: msg.key.remoteJid,
          name: msg.pushName || 'Contacto',
          text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
          timestamp: msg.messageTimestamp,
        };

        if (WEBHOOK_URL) {
          try {
            await fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            console.log('Mensaje reenviado al Webhook:', payload.from);
          } catch (err) {
            console.error('Error reenviando al Webhook:', err.message);
          }
        }
      }
    }
  });

  app.post('/send-message', async (req, res) => {
    const { to, message } = req.body;
    try {
      const formattedTo = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(formattedTo, { text: message });
      res.json({ status: 'sent', to, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

app.get('/', (req, res) => res.send('Engine de WhatsApp Activo'));

app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  startBot();
});