// backend/backboard/bootstrap.js
import { BackboardClient } from './client.js';
import { loadBackboardState, saveBackboardState } from './state.js';
import { SYSTEM_PROMPT } from '../counsellor.js';

const ASSISTANT_NAME = 'Megan - Dementia Care Companion';

export async function bootstrapBackboard() {
  const client = new BackboardClient(process.env.BACKBOARD_API_KEY);

  // Try cached state — validate the assistant still exists
  const saved = loadBackboardState();
  if (saved?.assistant_id) {
    try {
      await client.listThreads(saved.assistant_id);
      // Always sync the system prompt in case it changed
      await client.updateAssistant(saved.assistant_id, {
        name: ASSISTANT_NAME,
        system_prompt: SYSTEM_PROMPT,
      });
      console.log('[bootstrap] Cached assistant validated + prompt synced');
      return saved;
    } catch (err) {
      console.log(`[bootstrap] Cached assistant stale (${err.message}), creating new one...`);
    }
  }

  // Create fresh assistant with full Megan persona prompt
  const assistant = await client.createAssistant({
    name: ASSISTANT_NAME,
    system_prompt: SYSTEM_PROMPT,
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
