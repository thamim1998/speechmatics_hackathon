import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import twilio from 'twilio';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
// ngrok is started manually via CLI — no need for programmatic tunnel

import {
  createSession,
  getSession,
  addMessage,
  destroySession,
} from './session.js';
import { generateResponse, GREETING } from './counsellor.js';
import {
  createSTTClient,
  connectSTT,
  synthesizeSpeech,
  pcm16kToMulaw8k,
} from './speechmatics.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// Store the public ngrok URL (set on startup)
let publicUrl = 'https://tesha-untripped-honourably.ngrok-free.dev';
console.log('[api/call] Using public URL:', publicUrl);

// ─── Express Endpoints ──────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('AI Counsellor Phone Agent — running');
});

// Initiate a Twilio call that connects to our media stream
app.post('/api/call', async (req, res) => {
  const { phoneNumber, contactName, relationship, questions } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required' });
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
    to = `+33${digits.slice(1)}`;
  } else if (digits.startsWith('1') && digits.length === 11) {
    to = `+${digits}`;
  } else {
    to = `+33${digits}`;
  }

  if (!publicUrl) {
    return res
      .status(503)
      .json({ error: 'Server not ready — ngrok tunnel not established' });
  }

  // Build TwiML that connects to our WebSocket media stream
  const wsUrl = publicUrl.replace('https://', 'wss://') + '/media-stream';
  const twiml = `<Response>
    <Connect>
      <Stream url="${wsUrl}">
        <Parameter name="contactName" value="${contactName || ''}" />
        <Parameter name="relationship" value="${relationship || ''}" />
        <Parameter name="questions" value="${(questions || []).map((q) => q.text || q).join('|')}" />
      </Stream>
    </Connect>
  </Response>`;

  try {
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml,
    });

    console.log(`[api/call] Call initiated — SID: ${call.sid}, to: ${to}`);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('[api/call] Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Optional: TwiML webhook (Twilio can fetch this URL instead of inline TwiML)
app.post('/api/twiml', (req, res) => {
  if (!publicUrl) {
    res
      .type('text/xml')
      .send('<Response><Say>Service unavailable.</Say></Response>');
    return;
  }

  const wsUrl = publicUrl.replace('https://', 'wss://') + '/media-stream';
  res.type('text/xml').send(`<Response>
    <Connect>
      <Stream url="${wsUrl}" />
    </Connect>
  </Response>`);
});

// ─── HTTP + WebSocket Server ────────────────────────────────────

const server = createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/media-stream',
});

wss.on('connection', (ws) => {
  console.log('[ws] New WebSocket connection');
  let callSid = null;

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'connected':
        console.log('[ws] Twilio media stream connected');
        break;

      case 'start': {
        callSid = msg.start.callSid;
        const streamSid = msg.start.streamSid;
        const params = msg.start.customParameters || {};

        console.log(
          `[ws] Stream started — callSid: ${callSid}, streamSid: ${streamSid}`,
        );

        // Create session with metadata from the call
        const session = createSession(callSid, {
          contactName: params.contactName,
          relationship: params.relationship,
          questions: params.questions ? params.questions.split('|') : [],
        });
        session.streamSid = streamSid;

        // Initialize STT with callbacks
        session.mediaChunkCount = 0;
        session.sttClient = createSTTClient({
          onPartial: (text) => {
            console.log(`[stt] Partial: "${text}"`);
            session.currentUtterance = text;
          },
          onFinal: (text) => {
            console.log(`[stt] Final: "${text}"`);
            if (text.trim()) {
              session.currentUtterance +=
                (session.currentUtterance ? ' ' : '') + text;
            }
          },
          onEndOfUtterance: () => {
            console.log(`[stt] EndOfUtterance — currentUtterance: "${session.currentUtterance}", isProcessing: ${session.isProcessing}`);
            handleEndOfUtterance(callSid, ws);
          },
        });

        // Connect STT, then generate and play greeting
        try {
          await connectSTT(session.sttClient);
          await playGreeting(callSid, ws);
        } catch (err) {
          console.error('[ws] Failed to initialize:', err.message);
        }
        break;
      }

      case 'media': {
        // Forward Twilio's mulaw audio to Speechmatics STT
        const session = getSession(callSid);
        if (session?.sttClient) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          session.mediaChunkCount = (session.mediaChunkCount || 0) + 1;
          if (session.mediaChunkCount % 250 === 1) {
            console.log(`[ws] Received ${session.mediaChunkCount} audio chunks from client (~${Math.round(session.mediaChunkCount * 20 / 1000)}s)`);
          }
          try {
            session.sttClient.sendAudio(audioBuffer);
          } catch (err) {
            if (session.mediaChunkCount <= 3) console.log(`[ws] sendAudio failed (expected during init): ${err.message}`);
          }
        }
        break;
      }

      case 'stop':
        console.log(`[ws] Stream stopped — callSid: ${callSid}`);
        if (callSid) {
          await destroySession(callSid);
        }
        break;

      case 'mark':
        // Mark events confirm audio playback milestones
        break;
    }
  });

  ws.on('close', async () => {
    console.log('[ws] WebSocket closed');
    if (callSid) {
      await destroySession(callSid);
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] WebSocket error:', err.message);
  });
});

// ─── Voice Pipeline ─────────────────────────────────────────────

async function playGreeting(callSid, ws) {
  const session = getSession(callSid);
  if (!session) return;

  console.log(`[pipeline] Playing greeting for ${callSid}`);
  addMessage(callSid, 'assistant', GREETING);

  // Forward transcript to client (Twilio ignores unknown event types)
  try { ws.send(JSON.stringify({ event: 'transcript', transcript: { speaker: 'assistant', text: GREETING } })); } catch {};

  try {
    const pcmAudio = await synthesizeSpeech(GREETING);
    const mulawAudio = pcm16kToMulaw8k(pcmAudio);
    sendAudioToTwilio(ws, session.streamSid, mulawAudio);
  } catch (err) {
    console.error('[pipeline] Greeting TTS failed:', err.message);
  }
}

async function handleEndOfUtterance(callSid, ws) {
  const session = getSession(callSid);
  if (!session || session.isProcessing) return;

  const userText = session.currentUtterance.trim();
  if (!userText) return;

  session.isProcessing = true;
  session.currentUtterance = '';

  console.log(`[pipeline] Caller said: "${userText}"`);
  addMessage(callSid, 'user', userText);
  try { ws.send(JSON.stringify({ event: 'transcript', transcript: { speaker: 'user', text: userText } })); } catch {};

  try {
    // Generate counsellor response via Claude
    const responseText = await generateResponse(session.messages);
    console.log(`[pipeline] Counsellor: "${responseText}"`);
    addMessage(callSid, 'assistant', responseText);
    try { ws.send(JSON.stringify({ event: 'transcript', transcript: { speaker: 'assistant', text: responseText } })); } catch {};

    // Synthesize speech and send to Twilio
    const pcmAudio = await synthesizeSpeech(responseText);
    const mulawAudio = pcm16kToMulaw8k(pcmAudio);
    sendAudioToTwilio(ws, session.streamSid, mulawAudio);
  } catch (err) {
    console.error('[pipeline] Response pipeline failed:', err.message);
  } finally {
    session.isProcessing = false;
  }
}

function sendAudioToTwilio(ws, streamSid, mulawBuffer) {
  // Chunk into ~8KB pieces (1 second of 8kHz mulaw audio)
  const CHUNK_SIZE = 8000;

  for (let offset = 0; offset < mulawBuffer.length; offset += CHUNK_SIZE) {
    const chunk = mulawBuffer.subarray(offset, offset + CHUNK_SIZE);
    const payload = chunk.toString('base64');

    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload },
      }),
    );
  }

  // Send a mark to track when playback completes
  ws.send(
    JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: `speech_${Date.now()}` },
    }),
  );
}

// ─── Startup ────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[ngrok] Public URL: ${publicUrl}`);
  console.log(
    `[ngrok] WebSocket URL: ${publicUrl.replace('https://', 'wss://')}/media-stream`,
  );
});
