// backend/backboard/bootstrap.js
import { BackboardClient } from './client.js';
import { loadBackboardState, saveBackboardState } from './state.js';

const DEFAULT_SYSTEM_PROMPT =
  `You are a supportive assistant in a dementia-care context. ` +
  `Be concise, empathetic, and safety-focused.`;

export async function bootstrapBackboard() {
  const client = new BackboardClient(process.env.BACKBOARD_API_KEY);

  // Try cached state — validate the assistant still exists
  const saved = loadBackboardState();
  if (saved?.assistant_id) {
    try {
      await client.listThreads(saved.assistant_id);
      console.log('[bootstrap] Cached assistant validated OK');
      return saved;
    } catch (err) {
      console.log(`[bootstrap] Cached assistant stale (${err.message}), creating new one...`);
    }
  }

  // Create fresh assistant + thread
  const assistantName = process.env.BACKBOARD_ASSISTANT_NAME || 'Dementia App Assistant';
  const assistant = await client.createAssistant({
    name: assistantName,
    system_prompt: DEFAULT_SYSTEM_PROMPT,
  });

  const thread = await client.createThread(assistant.assistant_id);

  const state = {
    assistant_id: assistant.assistant_id,
    thread_id: thread.thread_id,
    created_at: new Date().toISOString(),
  };

  saveBackboardState(state);
  return state;
}
