const express = require('express');
const app = express();

app.use(express.json());

// Tu URL exacta de PHP en nuvaistudio.com
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://nuvaistudio.com/crm/api/whatsapp_webhook.php';

app.post('/webhook', (req, res) => {
  try {
    const payload = req.body;

    // 1. Responder 200 OK de inmediato a WhatsApp/Engine para liberar la petición
    res.status(200).send({ status: 'success' });

    // 2. Validar que la carga útil exista
    if (!payload || typeof payload !== 'object') {
      return;
    }

    // 3. Ignorar mensajes salientes enviados por el propio bot (evita bucles)
    if (payload.fromMe || payload.key?.fromMe) {
      return;
    }

    // 4. Ignorar eventos sin texto o vacíos
    const text = payload.text ? payload.text.trim() : '';
    if (!text) {
      return;
    }

    // 5. Extracción segura de ID de mensaje
    const messageId = payload.id 
      || payload.key?.id 
      || payload.message?.id 
      || `msg_${Date.now()}`;

    // 6. Normalizar remitente (limpieza de JID a número telefónico puro)
    let from = payload.from || payload.key?.remoteJid || '';
    if (!from) {
      return;
    }
    from = from.replace(/@.*$/, '').replace(/[^0-9]/g, '');

    // 7. Normalizar el Timestamp
    let timestamp = payload.timestamp;
    if (typeof timestamp === 'object' && timestamp !== null) {
      timestamp = timestamp.low;
    }
    timestamp = timestamp || Math.floor(Date.now() / 1000);

    // 8. Estructura limpia para el script PHP
    const safeData = {
      id: messageId,
      from: from,
      name: payload.name && payload.name !== '-' ? payload.name : 'Usuario',
      text: text,
      timestamp: timestamp
    };

    console.log(`[Forwarding] Reenviando a PHP (${PHP_WEBHOOK_URL}):`, safeData);

    // 9. Reenviar los datos de forma asíncrona a tu script PHP usando fetch nativo
    forwardToPhp(safeData);

  } catch (error) {
    console.error('Error procesando el webhook en Node.js:', error.message);
  }
});

// Función de reenvío con fetch nativo de Node.js (v18+)
async function forwardToPhp(data) {
  try {
    const response = await fetch(PHP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000) // Timeout de 8 segundos
    });

    if (!response.ok) {
      console.error(`[PHP Error] El servidor PHP respondió con código de estado: ${response.status}`);
    }
  } catch (error) {
    console.error('Error al reenviar los datos a PHP:', error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Engine (Node.js) escuchando en puerto ${PORT}`);
});