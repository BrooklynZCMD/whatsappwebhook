const express = require('express');
const axios = require('axios'); // Asegúrate de tener instalado axios: npm install axios
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

    // 3. Ignorar mensajes enviados por el propio bot para evitar bucles infinitos
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

    // 6. Normalizar remitente (limpieza de JID a número de teléfono limpio)
    let from = payload.from || payload.key?.remoteJid || '';
    if (!from) {
      return;
    }
    // Deja solo los números limpios sin el dominio @s.whatsapp.net o @lid
    from = from.replace(/@.*$/, '').replace(/[^0-9]/g, '');

    // 7. Normalizar el Timestamp
    let timestamp = payload.timestamp;
    if (typeof timestamp === 'object' && timestamp !== null) {
      timestamp = timestamp.low;
    }
    timestamp = timestamp || Math.floor(Date.now() / 1000);

    // 8. Estructura limpia lista para tu script en PHP
    const safeData = {
      id: messageId,
      from: from,
      name: payload.name && payload.name !== '-' ? payload.name : 'Usuario',
      text: text,
      timestamp: timestamp
    };

    console.log(`[Forwarding] Enviando a https://nuvaistudio.com/crm/api/whatsapp_webhook.php ->`, safeData);

    // 9. Reenviar los datos de forma asíncrona a tu script PHP
    forwardToPhp(safeData);

  } catch (error) {
    console.error('Error procesando el webhook en Node.js:', error.message);
  }
});

// Función que reenvía los datos mediante POST a tu backend PHP
async function forwardToPhp(data) {
  try {
    await axios.post(PHP_WEBHOOK_URL, data, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000
    });
  } catch (error) {
    console.error('Error al reenviar los datos a PHP:', error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Engine (Node.js) escuchando en puerto ${PORT}`);
});