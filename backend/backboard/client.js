

// // backend/backboard/client.js
// import fs from "fs";
// import FormData from "form-data"; // ✅ add this
// const BASE_URL = "https://app.backboard.io/api";

// function mustOk(res, text) {
//   if (!res.ok) {
//     const err = new Error(`Backboard error ${res.status}: ${text}`);
//     err.status = res.status;
//     throw err;
//   }
// }

// export class BackboardClient {
//   constructor(apiKey) {
//     if (!apiKey) throw new Error("BACKBOARD_API_KEY is missing");
//     this.apiKey = apiKey;
//   }

//   jsonHeaders() {
//     return {
//       "X-API-Key": this.apiKey,
//       "Content-Type": "application/json",
//     };
//   }

//   authHeaders() {
//     return { "X-API-Key": this.apiKey };
//   }

//   async createAssistant({ name, system_prompt }) {
//     const res = await fetch(`${BASE_URL}/assistants`, {
//       method: "POST",
//       headers: this.jsonHeaders(),
//       body: JSON.stringify({ name, system_prompt }),
//     });
//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text);
//   }

//   async createThread(assistantId) {
//     const res = await fetch(`${BASE_URL}/assistants/${assistantId}/threads`, {
//       method: "POST",
//       headers: this.authHeaders(),
//     });
//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text);
//   }

//   async getThread(threadId) {
//     const res = await fetch(`${BASE_URL}/threads/${threadId}`, {
//       method: "GET",
//       headers: this.authHeaders(),
//     });
//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text); // includes messages[]
//   }

//   /**
//    * Adds a message to a thread (multipart/form-data).
//    * For caretaker storage entries, use send_to_llm=false.
//    * NOTE: Keeping this for compatibility with your current implementation.
//    */
//   async addMessage({
//     threadId,
//     content,
//     send_to_llm = true,
//     stream = false,
//     metadata = null,
//     memory = null,
//   }) {
//     const form = new FormData();
//     form.set("content", content ?? "");
//     form.set("stream", String(stream));
//     form.set("send_to_llm", String(send_to_llm));
//     if (memory) form.set("memory", memory);
//     if (metadata) form.set("metadata", JSON.stringify(metadata));

//     const res = await fetch(`${BASE_URL}/threads/${threadId}/messages`, {
//       method: "POST",
//       headers: this.authHeaders(), // IMPORTANT: don't set Content-Type manually for FormData
//       body: form,
//     });

//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text);
//   }

//   /**
//    * Adds a message to a thread (JSON body).
//    * Use this when you want to reliably set memory="Auto" etc.
//    *
//    * memory values: "Auto" | "On" | "Off" | "Readonly"
//    * (Backboard supports memory modes; you asked for "Auto" caretaker writes.)
//    */
//   async addMessageJson({
//     threadId,
//     content,
//     send_to_llm = false,
//     stream = false,
//     metadata = null,
//     memory = "Auto",
//   }) {
//     const body = {
//       content: content ?? "",
//       stream: Boolean(stream),
//       send_to_llm: String(send_to_llm),
//       memory,
//     };

//     // Your system uses metadata as JSON string; keep consistent:
//     if (metadata) body.metadata = JSON.stringify(metadata);

//     const res = await fetch(`${BASE_URL}/threads/${threadId}/messages`, {
//       method: "POST",
//       headers: this.jsonHeaders(),
//       body: JSON.stringify(body),
//     });

//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text);
//   }

//   /**
//    * Upload a document to an assistant.
//    * Use this for stable facts (care plan, routine, baseline meds).
//    *
//    * This uses multipart/form-data:
//    * - DO NOT set Content-Type manually (browser/node will set boundary)
//    */
//   async uploadAssistantDocument({ assistantId, filePath }) {
//     if (!assistantId) throw new Error("uploadAssistantDocument: assistantId is required");
//     if (!filePath) throw new Error("uploadAssistantDocument: filePath is required");
//     if (!fs.existsSync(filePath)) throw new Error(`uploadAssistantDocument: file not found: ${filePath}`);

//     const form = new FormData();
//     form.set("file", fs.createReadStream(filePath));

//     const res = await fetch(`${BASE_URL}/assistants/${assistantId}/documents`, {
//       method: "POST",
//       headers: this.authHeaders(), // IMPORTANT: don't set Content-Type manually for FormData
//       body: form,
//     });

//     const text = await res.text();
//     mustOk(res, text);
//     return JSON.parse(text);
//   }
// }


// backend/backboard/client.js
import fs from "fs";
import NodeFormData from "form-data";

const BASE_URL = "https://app.backboard.io/api";

function mustOk(res, text) {
  if (!res.ok) {
    const err = new Error(`Backboard error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
}

export class BackboardClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error("BACKBOARD_API_KEY is missing");
    this.apiKey = apiKey;
  }

  jsonHeaders() {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  authHeaders() {
    return { "X-API-Key": this.apiKey };
  }

  async createAssistant({ name, system_prompt }) {
    const res = await fetch(`${BASE_URL}/assistants`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ name, system_prompt }),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  async createThread(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/threads`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  async getThread(threadId) {
    const res = await fetch(`${BASE_URL}/threads/${threadId}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text); // includes messages[]
  }

  /**
   * Adds a message to a thread (multipart/form-data).
   * For caretaker storage entries, use send_to_llm=false.
   *
   * NOTE: This is kept for compatibility, but uses NodeFormData
   * so multipart boundaries are correct in Node.
   */
  async addMessage({
    threadId,
    content,
    send_to_llm = true,
    stream = false,
    metadata = null,
    memory = null,
  }) {
    const form = new NodeFormData();
    form.append("content", content ?? "");
    form.append("stream", String(stream));
    form.append("send_to_llm", String(send_to_llm));
    if (memory) form.append("memory", memory);
    if (metadata) form.append("metadata", JSON.stringify(metadata));

    const res = await fetch(`${BASE_URL}/threads/${threadId}/messages`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        ...form.getHeaders(), // ✅ IMPORTANT (multipart boundary)
      },
      body: form,
    });

    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  /**
   * Adds a message to a thread (JSON body).
   * Use this when you want to reliably set memory="Auto" etc.
   *
   * memory values: "Auto" | "On" | "Off" | "Readonly"
   */
  async addMessageJson({
    threadId,
    content,
    send_to_llm = false,
    stream = false,
    metadata = null,
    memory = "Auto",
  }) {
    const body = {
      content: content ?? "",
      stream: Boolean(stream),
      send_to_llm: String(send_to_llm),
      memory,
    };

    // Your system uses metadata as JSON string; keep consistent:
    if (metadata) body.metadata = JSON.stringify(metadata);

    const res = await fetch(`${BASE_URL}/threads/${threadId}/messages`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(body),
    });

    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  /**
   * List all threads for an assistant.
   */
  async listThreads(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/threads`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  /**
   * Get all memories extracted by Backboard for an assistant.
   * Returns { memories: [{ id, content, metadata, created_at, updated_at }] }
   */
  async getAssistantMemories(assistantId) {
    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/memories`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }

  /**
   * Upload a document to an assistant.
   * Use this for stable facts (care plan, routine, baseline meds).
   *
   * IMPORTANT: Use NodeFormData so Backboard receives a real UploadFile.
   */
  async uploadAssistantDocument({ assistantId, filePath }) {
    if (!assistantId) throw new Error("uploadAssistantDocument: assistantId is required");
    if (!filePath) throw new Error("uploadAssistantDocument: filePath is required");
    if (!fs.existsSync(filePath)) {
      throw new Error(`uploadAssistantDocument: file not found: ${filePath}`);
    }

    const form = new NodeFormData();
    form.append("file", fs.createReadStream(filePath)); // ✅ REAL file stream

    const res = await fetch(`${BASE_URL}/assistants/${assistantId}/documents`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        ...form.getHeaders(), // ✅ includes multipart boundary
      },
      body: form,
    });

    const text = await res.text();
    mustOk(res, text);
    return JSON.parse(text);
  }
}