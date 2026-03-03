import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { SipClient } from 'livekit-server-sdk';

import caretakerRouter from './routes/caretaker.js';
import { bootstrapBackboard } from './backboard/bootstrap.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─── LiveKit SIP Client ─────────────────────────────────────────
const sipClient = new SipClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

// ─── Express Endpoints ──────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Dementia Voice Agent — running');
});

// Initiate an outbound call via LiveKit SIP
app.post('/api/call', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required' });
  }

  const sipTrunkId = process.env.SIP_TRUNK_ID;
  if (!sipTrunkId) {
    return res.status(503).json({ error: 'SIP_TRUNK_ID not configured — set up Telnyx + LiveKit SIP trunk first' });
  }

  // Strip formatting and ensure E.164 format
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  let to;
  if (digits.startsWith('33')) {
    to = `+${digits}`;
  } else if (digits.startsWith('0') && digits.length === 10) {
    // French local number
    to = `+33${digits.slice(1)}`;
  } else if (digits.startsWith('1') && digits.length === 11) {
    // US number
    to = `+${digits}`;
  } else if (digits.length >= 10) {
    // Assume international if 10+ digits
    to = `+${digits}`;
  } else {
    to = `+33${digits}`;
  }

  const roomName = `call-${Date.now()}`;

  try {
    const participant = await sipClient.createSipParticipant(
      sipTrunkId,
      to,
      roomName,
      {
        participantIdentity: `phone-${Date.now()}`,
        participantName: 'Patient',
        playDialtone: true,
      },
    );

    console.log(`[api/call] SIP call initiated — room: ${roomName}, to: ${to}`);
    res.json({ success: true, roomName, participantId: participant.participantId });
  } catch (err) {
    console.error('[api/call] LiveKit SIP error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HTTP Server ────────────────────────────────────────────────

const server = createServer(app);

// ─── Startup ────────────────────────────────────────────────────

async function main() {
  // Bootstrap Backboard (creates assistant/thread on first run)
  const bb = await bootstrapBackboard();

  // Mount caretaker routes (protected by X-CARETAKER-SECRET)
  app.use('/api/caretaker', caretakerRouter({ threadId: bb.thread_id, assistantId: bb.assistant_id }));

  console.log('[backboard] assistant_id:', bb.assistant_id);
  console.log('[backboard] thread_id:', bb.thread_id);

  server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[startup] failed:', err);
  process.exit(1);
});
