// backend/routes/caretaker.js
import express from 'express';
import { CaretakerStore } from '../backboard/caretakerStore.js';
import { summarizeTimeline } from '../backboard/analytics.js';

export default function caretakerRouter({ threadId }) {
  const router = express.Router();

  // Shared secret auth middleware
  router.use((req, res, next) => {
    const secret = req.header('X-CARETAKER-SECRET');
    if (!process.env.CARETAKER_SECRET) {
      return res.status(500).json({ error: 'CARETAKER_SECRET not configured on server' });
    }
    if (secret !== process.env.CARETAKER_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  const store = new CaretakerStore({
    apiKey: process.env.BACKBOARD_API_KEY,
    threadId,
  });

  // Health/status (helpful for debugging)
  router.get('/status', (req, res) => {
    res.json({ ok: true, threadId });
  });

  // Add caretaker event/context
  router.post('/event', async (req, res) => {
    try {
      const { type, text, data, timestampISO, tags } = req.body || {};
      if (!type) return res.status(400).json({ error: 'type is required' });
      if (!text && !data) return res.status(400).json({ error: 'text or data is required' });

      const result = await store.addCaretakerEvent({
        type,
        text,
        data,
        timestampISO,
        tags,
      });

      res.json({ ok: true, result });
    } catch (err) {
      console.error('[caretaker/event] error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  });

  // Read timeline
  router.get('/timeline', async (req, res) => {
    try {
      const messages = await store.getTimeline();
      res.json({ ok: true, messages });
    } catch (err) {
      console.error('[caretaker/timeline] error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  });

  // Analytics summary
  router.get('/analytics/summary', async (req, res) => {
    try {
      const messages = await store.getTimeline();
      const summary = summarizeTimeline(messages);
      res.json({ ok: true, summary });
    } catch (err) {
      console.error('[caretaker/analytics] error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  });

  return router;
}