// backend/backboard/client.js
const BASE_URL = 'https://app.backboard.io/api';

function mustOk(res, text) {
  if (!res.ok) {
    const err = new Error(`Backboard error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
}

export class BackboardClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('BACKBOARD_API_KEY is missing');
    this.apiKey = apiKey;
  }

  jsonHeaders() {
    return {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  authHeaders() {
    return { 'X-API-Key': this.apiKey };
  }

  async createAssistant({ name, system_prompt }) {
    const res = await fetch(`${BASE_URL}/assistants`, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ name, system_prompt }),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  async createThread(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/threads`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  async getThread(threadId) {
    const res = await fetch(`${BASE_URL}/threads/${threadId}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text); // includes messages[]
  }

  /**
   * Adds a message to a thread.
   * For caretaker storage entries, use send_to_llm=false.
   * Backboard expects multipart/form-data for this endpoint.
   */
  async addMessage({ threadId, content, send_to_llm = true, stream = false, metadata = null, memory = null }) {
    const form = new FormData();
    form.set('content', content ?? '');
    form.set('stream', String(stream));
    form.set('send_to_llm', String(send_to_llm));
    if (memory) form.set('memory', memory);
    if (metadata) form.set('metadata', JSON.stringify(metadata));

    const res = await fetch(`${BASE_URL}/threads/${threadId}/messages`, {
      method: 'POST',
      headers: this.authHeaders(), // IMPORTANT: don't set Content-Type manually for FormData
      body: form,
    });

    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  // ─── Memory management ─────────────────────────────────────────

  async listMemories(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/memories`, {
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    const data = JSON.parse(text);
    return data.memories || [];
  }

  async deleteMemory(assistantId, memoryId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/memories/${memoryId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
  }

  // ─── Thread management ─────────────────────────────────────────

  async listThreads(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/threads`, {
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    const data = JSON.parse(text);
    const threads = data.threads || data;
    return Array.isArray(threads) ? threads : [];
  }

  async deleteThread(threadId) {
    const res = await fetch(`${BASE_URL}/threads/${threadId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
  }

  // ─── Document management ───────────────────────────────────────

  async listDocuments(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/documents`, {
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  }

  async deleteDocument(assistantId, documentId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/documents/${documentId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
  }

  async uploadDocument(assistantId, filename, buffer, mimeType = 'text/markdown') {
    const form = new FormData();
    form.set('file', new Blob([buffer], { type: mimeType }), filename);

    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/documents`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }
}