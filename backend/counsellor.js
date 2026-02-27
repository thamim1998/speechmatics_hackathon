import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const SYSTEM_PROMPT = `You are a compassionate, empathetic mental health counsellor speaking on a live phone call. Your role is to listen actively, validate feelings, and provide supportive guidance.

Guidelines:
- Keep responses to 1-2 short sentences — this is a live phone call, be concise and natural.
- Use warm, natural conversational language. Avoid clinical jargon.
- Acknowledge what the caller said before responding.
- Ask one open-ended question to encourage the caller to share more.
- If the caller expresses suicidal thoughts, self-harm, or immediate danger, calmly direct them to call 911 or their local emergency number immediately.
- Never diagnose conditions or prescribe medication.
- Do not repeat the same question or phrase verbatim.`;

const GREETING = "Hello, thank you for calling. I'm here to listen and support you. How are you feeling today?";

export { GREETING };

export async function generateResponse(conversationHistory) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  return response.content[0].text;
}

export async function generateResponseStreaming(conversationHistory, onChunk) {
  const stream = client.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  let fullText = '';

  stream.on('text', (text) => {
    fullText += text;
    if (onChunk) onChunk(text);
  });

  const finalMessage = await stream.finalMessage();
  return fullText;
}
