const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  try {
    const payload = req.body;

    // 1. Responder inmediatamente 200 OK a WhatsApp/Engine para evitar reintentos duplicados
    res.status(200).send({ status: 'success' });

    // 2. Validar que la carga útil exista
    if (!payload || typeof payload !== 'object') {
      console.log('Payload no válido o vacío');
      return;
    }

    // 3. Ignorar eventos sin texto o vacíos (evita procesar pings/ack sin mensaje)
    const text = payload.text ? payload.text.trim() : '';
    if (!text) {
      console.log('Mensaje ignorado: texto vacío o evento de sistema.');
      return;
    }

    // 4. Extracción segura de ID (evita "Cannot read properties of undefined (reading 'id')")
    const messageId = payload.id 
      || payload.key?.id 
      || payload.message?.id 
      || `msg_${Date.now()}`;

    // 5. Normalizar el Remitente (Manejo de @lid y números tradicionales)
    const from = payload.from || payload.key?.remoteJid || '';
    if (!from) {
      console.log('Mensaje ignorado: remitente no encontrado.');
      return;
    }

    // 6. Normalizar el Timestamp (Manejo de enteros y objetos protobuf { low, high })
    let timestamp = payload.timestamp;
    if (typeof timestamp === 'object' && timestamp !== null) {
      timestamp = timestamp.low;
    }
    timestamp = timestamp || Math.floor(Date.now() / 1000);

    // 7. Estructura limpia y segura para la lógica del bot
    const safeData = {
      id: messageId,
      from: from,
      name: payload.name && payload.name !== '-' ? payload.name : 'Usuario',
      text: text,
      timestamp: timestamp
    };

    console.log('Procesando mensaje válido:', safeData);

    // 8. Lógica de respuesta del Bot
    procesarRespuestaBot(safeData);

  } catch (error) {
    console.error('Error procesando el webhook:', error.message);
  }
});

function procesarRespuestaBot(data) {
  // Lógica de respuesta según el texto
  if (data.text.toLowerCase() === 'hola') {
    console.log(`Enviando respuesta a ${data.from}: ¡Hola! ¿En qué puedo ayudarte?`);
    // Llama aquí a tu función de envío de mensajes (p. ej. engine.sendMessage)
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Webhook escuchando en el puerto ${PORT}`);
});