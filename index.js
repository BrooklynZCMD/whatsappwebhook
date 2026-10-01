const express = require('express');
const app = express();

app.use(express.json());

const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://nuvaistudio.com/crm/api/whatsapp_webhook.php';

// Variable global para almacenar la instancia del socket de Baileys cuando esté activa
let sock = null; 

// ==========================================
// 1. ENDPOINT PARA RECIBIR Y REENVIAR MENSAJES (WhatsApp -> Node -> PHP)
// ==========================================
app.post('/webhook', (req, res) => {
  try {
    const payload = req.body;

    res.status(200).send({ status: 'success' });

    if (!payload || typeof payload !== 'object') return;
    if (payload.fromMe || payload.key?.fromMe) return;

    const text = payload.text ? payload.text.trim() : '';
    if (!text) return;

    // Extracción garantizada del ID del mensaje
    const messageId = payload.id 
      || payload.key?.id 
      || payload.message?.id 
      || `msg_${Date.now()}`;

    let from = payload.from || payload.key?.remoteJid || '';
    if (!from) return;
    from = from.replace(/@.*$/, '').replace(/[^0-9]/g, '');

    let timestamp = payload.timestamp;
    if (typeof timestamp === 'object' && timestamp !== null) {
      timestamp = timestamp.low;
    }
    timestamp = timestamp || Math.floor(Date.now() / 1000);

    const safeData = {
      id: messageId, // Siempre presente para evitar 'undefined (reading id)'
      from: from,
      name: payload.name && payload.name !== '-' ? payload.name : 'Usuario',
      text: text,
      timestamp: timestamp
    };

    console.log(`[Forwarding] Enviando a PHP:`, safeData);
    forwardToPhp(safeData);

  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
});

// ==========================================
// 2. ENDPOINT PARA ENVIAR RESPUESTAS (PHP -> Node -> WhatsApp)
// ==========================================
app.post('/send-message', async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: 'Parámetros obligatorios: to y text' });
    }

    console.log(`[Outbound] Intentando enviar mensaje a ${to}: "${text}"`);

    // Si estás usando la instancia de Baileys dentro del mismo proyecto
    if (sock) {
      const formattedJid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(formattedJid, { text: text });
      return res.status(200).json({ status: 'sent', to: formattedJid });
    }

    // Respuesta temporal si la sesión de Baileys aún se está conectando
    res.status(200).json({ status: 'accepted', message: 'Petición recibida en Engine' });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Engine escuchando en el puerto ${PORT}`);
});