// // backend/routes/caretaker.js
// import express from 'express';
// import { CaretakerStore } from '../backboard/caretakerStore.js';
// import { summarizeTimeline } from '../backboard/analytics.js';

// export default function caretakerRouter({ threadId }) {
//   const router = express.Router();

//   // Shared secret auth middleware
//   router.use((req, res, next) => {
//     const secret = req.header('X-CARETAKER-SECRET');
//     if (!process.env.CARETAKER_SECRET) {
//       return res.status(500).json({ error: 'CARETAKER_SECRET not configured on server' });
//     }
//     if (secret !== process.env.CARETAKER_SECRET) {
//       return res.status(401).json({ error: 'Unauthorized' });
//     }
//     next();
//   });


//    const store = new CaretakerStore({
//     apiKey: process.env.BACKBOARD_API_KEY,
//     threadId: state.thread_id,
//     assistantId: state.assistant_id, // ✅ REQUIRED for document uploads
//   });

//   // Health/status (helpful for debugging)
//   router.get('/status', (req, res) => {
//     res.json({ ok: true, threadId });
//   });

//   // Add caretaker event/context
//   router.post('/event', async (req, res) => {
//     try {
//       const { type, text, data, timestampISO, tags } = req.body || {};
//       if (!type) return res.status(400).json({ error: 'type is required' });
//       if (!text && !data) return res.status(400).json({ error: 'text or data is required' });

//       const result = await store.addCaretakerEvent({
//         type,
//         text,
//         data,
//         timestampISO,
//         tags,
//       });

//       res.json({ ok: true, result });
//     } catch (err) {
//       console.error('[caretaker/event] error:', err);
//       res.status(500).json({ error: err.message || 'Internal error' });
//     }
//   });

//   // Read timeline
//   router.get('/timeline', async (req, res) => {
//     try {
//       const messages = await store.getTimeline();
//       res.json({ ok: true, messages });
//     } catch (err) {
//       console.error('[caretaker/timeline] error:', err);
//       res.status(500).json({ error: err.message || 'Internal error' });
//     }
//   });

//   // Analytics summary
//   router.get('/analytics/summary', async (req, res) => {
//     try {
//       const messages = await store.getTimeline();
//       const summary = summarizeTimeline(messages);
//       res.json({ ok: true, summary });
//     } catch (err) {
//       console.error('[caretaker/analytics] error:', err);
//       res.status(500).json({ error: err.message || 'Internal error' });
//     }
//   });

//   return router;
// }


// backend/routes/caretaker.js
import express from "express";
import { CaretakerStore } from "../backboard/caretakerStore.js";
import { summarizeTimeline } from "../backboard/analytics.js";

export default function caretakerRouter({ threadId, assistantId }) {
  if (!threadId) throw new Error("caretakerRouter: threadId is required");
  if (!assistantId) throw new Error("caretakerRouter: assistantId is required");

  const router = express.Router();

  // Create store once (shared by all routes)
  const store = new CaretakerStore({
    apiKey: process.env.BACKBOARD_API_KEY,
    threadId,
    assistantId, // ✅ REQUIRED for document uploads
  });

  // Health/status (helpful for debugging)
  router.get("/status", (req, res) => {
    res.json({ ok: true, threadId, assistantId });
  });

  // Add caretaker event/context
  router.post("/event", async (req, res) => {
    try {
      const body = req.body || {};
      const typeRaw = body.type;

      // Normalize type to avoid casing/whitespace bugs from frontend
      const type = String(typeRaw || "")
        .trim()
        .toLowerCase();

      const text = body.text;
      const data = body.data;
      const timestampISO = body.timestampISO;
      const tags = body.tags;

      if (!type) return res.status(400).json({ error: "type is required" });
      if (!text && !data)
        return res.status(400).json({ error: "text or data is required" });

      // Debug (optional but useful)
      // console.log("[caretaker/event]", { type, hasText: Boolean(text), hasData: Boolean(data) });

      const result = await store.addCaretakerEvent({
        type,
        text,
        data,
        timestampISO,
        tags,
      });

      res.json({ ok: true, result });
    } catch (err) {
      console.error("[caretaker/event] error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // Read timeline
  router.get("/timeline", async (req, res) => {
    try {
      const messages = await store.getTimeline();
      res.json({ ok: true, messages });
    } catch (err) {
      console.error("[caretaker/timeline] error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // Call session transcripts (from Python agent post-call saves)
  router.get("/transcripts", async (req, res) => {
    try {
      const messages = await store.getTimeline();
      const sessions = messages.filter((m) => {
        const md = m.metadata_ || {};
        return md.type === "call_session";
      });
      res.json({ ok: true, transcripts: sessions });
    } catch (err) {
      console.error("[caretaker/transcripts] error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // Patient memories (extracted by Backboard from conversations)
  router.get("/memories", async (req, res) => {
    try {
      const data = await store.client.getAssistantMemories(assistantId);
      res.json({ ok: true, memories: data.memories || [] });
    } catch (err) {
      console.error("[caretaker/memories] error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // Analytics summary
  router.get("/analytics/summary", async (req, res) => {
    try {
      const messages = await store.getTimeline();
      const summary = summarizeTimeline(messages);
      res.json({ ok: true, summary });
    } catch (err) {
      console.error("[caretaker/analytics] error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
}