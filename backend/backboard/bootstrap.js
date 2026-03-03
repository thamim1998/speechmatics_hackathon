// backend/backboard/bootstrap.js
import { BackboardClient } from './client.js';
import { loadBackboardState, saveBackboardState } from './state.js';

const DEFAULT_SYSTEM_PROMPT =
  `You are a supportive assistant in a dementia-care context. ` +
  `Be concise, empathetic, and safety-focused.`;

export async function bootstrapBackboard() {
  const client = new BackboardClient(process.env.BACKBOARD_API_KEY);

  // 1. Resolve assistant_id: env var → saved state → create new
  let assistant_id = process.env.BACKBOARD_ASSISTANT_ID;
  const saved = loadBackboardState();

  if (!assistant_id && saved?.assistant_id) {
    assistant_id = saved.assistant_id;
  }

  if (!assistant_id) {
    const assistantName = process.env.BACKBOARD_ASSISTANT_NAME || 'Dementia App Assistant';
    const assistant = await client.createAssistant({
      name: assistantName,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
    });
    assistant_id = assistant.assistant_id;
    console.log('[backboard] Created new assistant:', assistant_id);
  }

  // 2. Resolve thread_id: env var → saved state → create new
  let thread_id = process.env.BACKBOARD_THREAD_ID;

  if (!thread_id && saved?.thread_id) {
    thread_id = saved.thread_id;
  }

  if (!thread_id) {
    const thread = await client.createThread(assistant_id);
    thread_id = thread.thread_id;
    console.log('[backboard] Created new thread:', thread_id);
  }

  // 3. Persist to disk for next run
  const state = {
    assistant_id,
    thread_id,
    created_at: saved?.created_at || new Date().toISOString(),
  };

  saveBackboardState(state);
  return state;
}
