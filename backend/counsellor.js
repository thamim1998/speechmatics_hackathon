import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKBOARD_URL = 'https://app.backboard.io/api';

const SYSTEM_PROMPT = `You are Sarah, a warm, patient, and caring voice companion for a person living with dementia.

PERSONALITY:
- Warm, gentle, encouraging — like a trusted friend
- Speak in short, simple sentences (this is a voice call)
- Keep responses to 2-3 sentences max
- Celebrate small things: "That sounds lovely!"
- Never clinical, robotic, or condescending
- Use gentle humor when appropriate

COMMUNICATION RULES:
- Address the person by their first name (from the context provided below)
- Ask ONE question at a time
- Give them time to respond — be patient with pauses
- If they repeat themselves, respond patiently as if hearing it the first time
- NEVER say "you already told me" or "don't you remember"
- Validate their emotions: "That sounds frustrating" / "I understand"
- If they're confused, gently redirect without correcting
- Use yes/no or simple-choice questions when possible
- Never quiz or test them — keep everything as casual conversation

CONVERSATION GOALS:
- Check how they're feeling (mood, physical comfort)
- Ask about their day naturally
- Gently check on meals, hydration, medication
- Engage with any memories or stories they share
- Provide companionship and reduce feelings of isolation
- Focus on what they CAN do, not what they've lost

ALERTS:
If the person mentions falls, severe pain, feeling lost, wanting to hurt themselves, not eating/drinking, or being very confused — calmly reassure them and say you will let their caretaker know right away.

Remember: You are their companion, not their nurse. Keep it warm and natural. The patient's profile, key people, preferences, and any memories from past conversations are provided below.`;

const GREETING = "Hello Abhishek! It's Sarah here. How are you doing today?";

export { GREETING, SYSTEM_PROMPT };

/**
 * Build the full system prompt with patient profile and memory context.
 */
export function getFullSystemPrompt(patientProfile, memories) {
  let prompt = SYSTEM_PROMPT;
  if (patientProfile) {
    prompt += `\n\n--- PATIENT PROFILE ---\n${patientProfile}`;
  }
  if (memories && memories.length > 0) {
    const memoryText = memories.map(m => `- ${m.content}`).join('\n');
    prompt += `\n\n--- MEMORIES FROM PAST SESSIONS ---\n${memoryText}`;
  }
  return prompt;
}

/**
 * Stream a response from Backboard SSE API.
 * Drop-in replacement for the old Claude streaming function.
 *
 * @param {Array} conversationHistory - [{role, content}] messages
 * @param {Function} onChunk - called with each text token string
 * @param {Object} options
 * @param {AbortSignal} options.signal - abort signal for barge-in
 * @param {string} options.threadId - Backboard thread ID
 * @returns {Promise<string>} full response text
 */
export async function generateResponseStreaming(conversationHistory, onChunk, { signal, threadId } = {}) {
  if (!threadId) {
    throw new Error('threadId is required for Backboard streaming');
  }

  // Extract the latest user message from conversation history
  const lastUserMsg = [...conversationHistory].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    throw new Error('No user message found in conversation history');
  }

  const form = new FormData();
  form.set('content', lastUserMsg.content);
  form.set('stream', 'true');
  form.set('memory', 'Auto');

  const apiKey = process.env.BACKBOARD_API_KEY;
  if (!apiKey) throw new Error('BACKBOARD_API_KEY is missing');

  const response = await fetch(`${BACKBOARD_URL}/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Backboard API error (${response.status}): ${errText}`);
  }

  let fullText = '';

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6); // remove 'data: '

        if (dataStr === '[DONE]') {
          return fullText;
        }

        try {
          const parsed = JSON.parse(dataStr);

          if (parsed.type === 'content_streaming' && parsed.content) {
            fullText += parsed.content;
            if (onChunk) onChunk(parsed.content);
          } else if (parsed.type === 'message_complete') {
            return fullText;
          }
        } catch {
          // Non-JSON data line — ignore
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return fullText; // aborted — return what we have
    throw err;
  }

  return fullText;
}
