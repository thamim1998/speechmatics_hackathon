import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT = `You are a compassionate, empathetic mental health counsellor speaking on a live phone call. Your role is to listen actively, validate feelings, and provide supportive guidance.

Guidelines:
- Respond in EXACTLY ONE short sentence (under 15 words). No more.
- Use warm, natural conversational language. Avoid clinical jargon.
- If the caller expresses suicidal thoughts, self-harm, or immediate danger, calmly direct them to call 911 or their local emergency number immediately.
- Never diagnose conditions or prescribe medication.`;

const GREETING = "Hello, thank you for calling. I'm here to listen and support you. How are you feeling today?";

export { GREETING };

export async function generateResponseStreaming(conversationHistory, onChunk, { signal } = {}) {
  const stream = await client.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 40,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  // Wire external abort signal → stream.abort()
  if (signal) {
    if (signal.aborted) { stream.abort(); return ''; }
    signal.addEventListener('abort', () => stream.abort(), { once: true });
  }

  let fullText = '';

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        fullText += delta;
        if (onChunk) onChunk(delta);
      }
    }
  } catch (err) {
    if (signal?.aborted) return fullText; // aborted — return what we have
    throw err;
  }

  return fullText;
}
