/**
 * WhatsApp messaging via Composio API.
 *
 * Uses WHATSAPP_SEND_TEMPLATE_MESSAGE — the only reliable delivery method
 * with Meta test phone numbers through Composio.
 */

const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v2';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const COMPOSIO_ENTITY_ID = process.env.COMPOSIO_ENTITY_ID;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Send a WhatsApp message.
 * @param {string} text - Message body (currently unused — sends hello_world template).
 * @param {string} phoneNumber - Recipient phone number (any format, e.g. '+919952072184').
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendWhatsAppMessage(text, phoneNumber) {
  if (!text || !phoneNumber) {
    throw new Error('Both text and phoneNumber are required');
  }

  const toNumber = phoneNumber.replace(/\D/g, '');

  const res = await fetch(
    `${COMPOSIO_BASE_URL}/actions/WHATSAPP_SEND_TEMPLATE_MESSAGE/execute`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': COMPOSIO_API_KEY,
      },
      body: JSON.stringify({
        appName: 'whatsapp',
        entityId: COMPOSIO_ENTITY_ID,
        input: {
          phone_number_id: WHATSAPP_PHONE_NUMBER_ID,
          to_number: toNumber,
          template_name: 'hello_world',
          language_code: 'en_US',
        },
      }),
    },
  );

  const data = await res.json();

  if (!data.successful) {
    console.error('[whatsapp] Send failed:', data.error || data.message);
    return { success: false, error: data.error || data.message };
  }

  const messageId = data.data?.messages?.[0]?.id;
  console.log(`[whatsapp] Message sent — id: ${messageId}, to: ${toNumber}`);
  return { success: true, messageId };
}
