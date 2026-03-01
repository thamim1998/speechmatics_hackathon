import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a compassionate, empathetic mental health counsellor speaking on a live phone call. Your role is to listen actively, validate feelings, and provide supportive guidance.

Guidelines:
- Respond in EXACTLY ONE short sentence (under 15 words). No more.
- Use warm, natural conversational language. Avoid clinical jargon.
- If the caller expresses suicidal thoughts, self-harm, or immediate danger, calmly direct them to call 911 or their local emergency number immediately.
- Never diagnose conditions or prescribe medication.`;

const GREETING = "Hello, thank you for calling. I'm here to listen and support you. How are you feeling today?";

export { GREETING };

export async function generateResponseStreaming(conversationHistory, onChunk) {
  const stream = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    max_tokens: 40,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
    ],
    stream: true,
  });

  let fullText = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      if (onChunk) onChunk(delta);
    }
  }

  return fullText;
}
