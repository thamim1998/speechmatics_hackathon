/**
 * LiveKit Outbound PSTN Calling Agent
 *
 * AI agent dials a real phone number via LiveKit Cloud + Twilio SIP trunk,
 * joins a LiveKit room, and speaks to the user in real time.
 *
 * Pipeline:
 *   LiveKit AudioStream (PCM 16kHz) → Speechmatics STT (real-time)
 *     → 0.5s silence timeout → Claude (streaming)
 *     → sentence-by-sentence Speechmatics TTS → LiveKit AudioSource
 *
 * Usage:
 *   node livekit-agent.js +33XXXXXXXXX
 */

import 'dotenv/config';
import {
  RoomServiceClient,
  SipClient,
  AccessToken,
} from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  TrackKind,
  TrackSource,
  TrackPublishOptions,
  AudioStream,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
} from '@livekit/rtc-node';
import { createSTTClient, synthesizeSpeech } from './speechmatics.js';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import { generateResponseStreaming, GREETING } from './counsellor.js';

// ─── Config ────────────────────────────────────────────────────
const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  SIP_TRUNK_ID,
  SPEECHMATICS_API_KEY,
} = process.env;

const PHONE_NUMBER = process.argv[2];
const ROOM_NAME = `call-${Date.now()}`;
const SILENCE_MS_SHORT = 300;    // used when utterance looks complete
const SILENCE_MS_DEFAULT = 500;  // used when user might still be talking
const AGENT_SAMPLE_RATE = 16000; // matches Speechmatics TTS output

/** Short timeout if >3 words and ends cleanly; default otherwise */
function getSilenceTimeout(text) {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length > 3 && /[.!?,;:]$/.test(trimmed)) return SILENCE_MS_SHORT;
  if (words.length > 3 && /\w$/.test(trimmed)) return SILENCE_MS_SHORT;
  return SILENCE_MS_DEFAULT;
}

if (!PHONE_NUMBER) {
  console.error('Usage: node livekit-agent.js <+phoneNumber>');
  process.exit(1);
}

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !SIP_TRUNK_ID) {
  console.error('Missing env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, SIP_TRUNK_ID');
  process.exit(1);
}

if (!SPEECHMATICS_API_KEY) {
  console.error('Missing env: SPEECHMATICS_API_KEY');
  process.exit(1);
}

// ─── AudioPlayer (20ms real-time pacing) ──────────────────────
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (AGENT_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 320

class AudioPlayer {
  constructor(source) {
    this._source = source;
    this._queue = [];       // array of Int16Array chunks
    this._draining = false;
    this._stopped = false;
    this._doneResolvers = [];
  }

  isPlaying() { return this._draining; }

  stopNow() {
    this._stopped = true;
    this._queue.length = 0;
    // Resolve all waiters immediately so pipeline unblocks
    for (const resolve of this._doneResolvers) resolve();
    this._doneResolvers = [];
  }

  /** Non-blocking — adds PCM buffer to the playback queue */
  enqueue(pcmBuffer) {
    const int16 = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2,
    );
    // Slice into 20ms frames
    for (let off = 0; off < int16.length; off += SAMPLES_PER_FRAME) {
      const end = Math.min(off + SAMPLES_PER_FRAME, int16.length);
      this._queue.push(int16.slice(off, end));
    }
    if (!this._draining) this._drain();
  }

  /** Resolves when all queued audio has been sent */
  waitUntilDone() {
    if (this._queue.length === 0 && !this._draining) {
      return Promise.resolve();
    }
    return new Promise(resolve => this._doneResolvers.push(resolve));
  }

  async _drain() {
    this._draining = true;
    this._stopped = false;
    const startTime = performance.now();
    let framesSent = 0;

    while (this._queue.length > 0 && !this._stopped) {
      const samples = this._queue.shift();
      const frame = new AudioFrame(samples, AGENT_SAMPLE_RATE, 1, samples.length);
      await this._source.captureFrame(frame);
      framesSent++;

      // Clock-based pacing: sleep until the next frame boundary
      const elapsed = performance.now() - startTime;
      const targetTime = framesSent * FRAME_DURATION_MS;
      const sleepMs = targetTime - elapsed;
      if (sleepMs > 1) {
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }

    this._draining = false;
    // Notify all waiters
    for (const resolve of this._doneResolvers) resolve();
    this._doneResolvers = [];
  }
}

// ─── Session State ─────────────────────────────────────────────
let messages = [];           // Claude conversation history [{role, content}]
let currentUtterance = '';   // Confirmed finals accumulated
let partialUtterance = '';   // Latest partial (tentative)
let isProcessing = false;    // Guard against concurrent responses
let utteranceTimer = null;
let generationId = 0;        // Incremented on barge-in to invalidate stale TTS

// ─── Latency Tracking ─────────────────────────────────────────
let t_lastAudioPacket = 0;  // timestamp of last audio packet from user

function ms() { return performance.now(); }

function logLatency(label, t0, t1) {
  console.log(`  ⏱  ${label}: ${(t1 - t0).toFixed(0)}ms`);
}

// ─── Helpers ───────────────────────────────────────────────────

function createAgentToken(roomName, identity) {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '10m',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

/**
 * Connect Speechmatics STT configured for PCM s16le at 16kHz
 * (LiveKit AudioStream outputs PCM, unlike Twilio which outputs mulaw)
 */
async function connectSTTForLiveKit(client) {
  const jwt = await createSpeechmaticsJWT({
    type: 'rt',
    apiKey: SPEECHMATICS_API_KEY,
    ttl: 300,
  });

  await client.start(jwt, {
    transcription_config: {
      language: 'en',
      enable_partials: true,
      max_delay: 2,
    },
    audio_format: {
      type: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: 16000,
    },
  });

  console.log('[stt] Connected to Speechmatics (PCM s16le, 16kHz)');
}

// ─── TTS Phrase Cache ─────────────────────────────────────────
const ttsCache = new Map();

const BRIDGE_FILLERS = ["Mm-hm.", "Okay.", "Right."];

const CACHE_WARMUP_PHRASES = [
  GREETING,
  ...BRIDGE_FILLERS,
  "I hear you.",
  "That sounds really difficult.",
  "Tell me more about that.",
  "How does that make you feel?",
  "Take your time.",
  "I'm here for you.",
  "That makes sense.",
  "I understand.",
  "Thank you for sharing that.",
];

let bridgeIndex = 0;

async function cachedSynthesizeSpeech(text) {
  const key = text.toLowerCase().trim();
  if (ttsCache.has(key)) {
    console.log(`  ⚡ TTS cache hit: "${text.slice(0, 40)}..."`);
    return ttsCache.get(key);
  }
  const pcm = await synthesizeSpeech(text);
  ttsCache.set(key, pcm);
  return pcm;
}

async function warmTtsCache() {
  console.log(`[cache] Pre-warming TTS cache with ${CACHE_WARMUP_PHRASES.length} phrases...`);
  const t0 = ms();
  const results = await Promise.allSettled(
    CACHE_WARMUP_PHRASES.map(async (phrase) => {
      const pcm = await synthesizeSpeech(phrase);
      ttsCache.set(phrase.toLowerCase().trim(), pcm);
    }),
  );
  const hits = results.filter(r => r.status === 'fulfilled').length;
  logLatency(`Cache warmup (${hits}/${CACHE_WARMUP_PHRASES.length} phrases)`, t0, ms());
}

// ─── Voice Pipeline ────────────────────────────────────────────

async function playGreeting(player) {
  console.log('[pipeline] Playing greeting');
  messages.push({ role: 'assistant', content: GREETING });

  try {
    const t0 = ms();
    const pcmAudio = await cachedSynthesizeSpeech(GREETING);
    const t1 = ms();
    logLatency('Greeting TTS', t0, t1);
    console.log(`[pipeline] Greeting TTS returned ${pcmAudio.length} bytes (${(pcmAudio.length / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s)`);
    player.enqueue(pcmAudio);
    logLatency('Greeting enqueue', t1, ms());
    await player.waitUntilDone();
    console.log('[pipeline] Greeting played');
  } catch (err) {
    console.error('[pipeline] Greeting TTS failed:', err.message);
  }
}

async function handleEndOfUtterance(player) {
  if (isProcessing) return;

  const userText = currentUtterance.trim();
  if (!userText) return;

  isProcessing = true;
  currentUtterance = '';
  partialUtterance = '';

  const t_endpointDetected = ms();

  console.log(`\n━━━ Turn: "${userText}" ━━━`);
  logLatency('EoU latency (silence detect − last audio)', t_lastAudioPacket, t_endpointDetected);

  messages.push({ role: 'user', content: userText });

  try {
    // ── Play instant bridge filler to hide LLM latency ──
    const filler = BRIDGE_FILLERS[bridgeIndex++ % BRIDGE_FILLERS.length];
    const fillerPcm = ttsCache.get(filler.toLowerCase().trim());
    if (fillerPcm) {
      console.log(`  ⚡ Bridge: "${filler}"`);
      player.enqueue(fillerPcm);
    }

    // ── Parallel TTS pipeline ──
    // Producer: fires TTS immediately on sentence boundary (stores promises)
    // Consumer: awaits promises in order and enqueues audio to player
    let buffer = '';
    let t_llmFirstToken = 0;
    let sentenceIndex = 0;
    const thisGenId = generationId; // Capture — if barge-in bumps it, we bail
    const ttsTasks = []; // ordered array of { promise, sentence, idx, t_boundary }

    const fireTts = (sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) return;
      const idx = sentenceIndex++;
      logLatency(`S${idx} LLM→TTS start (sentence boundary − endpoint)`, t_endpointDetected, ms());
      // Fire TTS immediately — don't wait for previous sentence to finish playing
      const promise = (async () => {
        const t_ttsStart = ms();
        const pcm = await cachedSynthesizeSpeech(trimmed);
        logLatency(`S${idx} TTS synthesis`, t_ttsStart, ms());
        return pcm;
      })();
      ttsTasks.push({ promise, sentence: trimmed, idx });
    };

    const t_llmStart = ms();
    logLatency('STT finalize (endpoint → LLM request)', t_endpointDetected, t_llmStart);

    const responseText = await generateResponseStreaming(messages, (chunk) => {
      if (!t_llmFirstToken) {
        t_llmFirstToken = ms();
        logLatency('LLM TTFT (first token)', t_llmStart, t_llmFirstToken);
      }
      buffer += chunk;
      // Split on sentence boundaries: . ! ? followed by space or end
      const match = buffer.match(/^(.*?[.!?])\s+(.*)$/s);
      if (match) {
        fireTts(match[1]);
        buffer = match[2];
      }
    });

    // Flush remaining text
    if (buffer.trim()) {
      fireTts(buffer);
    }

    const t_llmDone = ms();
    logLatency('LLM total generation', t_llmStart, t_llmDone);

    // Consumer: await each TTS result in order, enqueue to player
    for (const { promise, sentence, idx } of ttsTasks) {
      if (generationId !== thisGenId) {
        console.log(`  🛑 S${idx}: discarded (barge-in)`);
        continue;
      }
      try {
        const pcmAudio = await promise;
        if (generationId !== thisGenId) {
          console.log(`  🛑 S${idx}: discarded after TTS (barge-in)`);
          continue;
        }
        player.enqueue(pcmAudio);
        const t_enqueued = ms();
        logLatency(`S${idx} TOTAL (endpoint → audio enqueued)`, t_endpointDetected, t_enqueued);
        console.log(`  📢 S${idx}: "${sentence}" (${(pcmAudio.length / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s audio)`);
      } catch (err) {
        console.error(`[pipeline] S${idx} TTS failed:`, err.message);
      }
    }

    // Wait for all audio to finish playing (unless barged in)
    if (generationId === thisGenId) {
      await player.waitUntilDone();
    }

    const t_allDone = ms();
    const bargedIn = generationId !== thisGenId;
    logLatency(`Full turn (endpoint → ${bargedIn ? 'barge-in' : 'all audio played'})`, t_endpointDetected, t_allDone);
    console.log(`━━━ End turn${bargedIn ? ' (interrupted)' : ''}: "${responseText}" ━━━\n`);

    messages.push({ role: 'assistant', content: responseText });
  } catch (err) {
    console.error('[pipeline] Response pipeline failed:', err.message);
  } finally {
    isProcessing = false;
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const httpUrl = LIVEKIT_URL.replace('wss://', 'https://');

  // Pre-warm TTS cache in parallel with room setup
  const cacheWarmup = warmTtsCache();

  // 1. Create the room
  console.log(`[room] Creating room: ${ROOM_NAME}`);
  const roomService = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  try {
    await roomService.createRoom({ name: ROOM_NAME, emptyTimeout: 300 });
    console.log(`[room] Room "${ROOM_NAME}" created`);
  } catch (err) {
    if (err.message?.includes('already exists')) {
      console.log(`[room] Room "${ROOM_NAME}" already exists, reusing`);
    } else {
      console.log(`[room] Create room result:`, err.message || 'ok');
    }
  }

  // 2. Agent joins the room (ready before the call connects)
  console.log(`[agent] Joining room: ${ROOM_NAME}`);
  const agentToken = await createAgentToken(ROOM_NAME, 'ai-agent');

  const room = new Room();

  // Persistent audio source + track for the agent voice
  const agentSource = new AudioSource(AGENT_SAMPLE_RATE, 1);
  const agentTrack = LocalAudioTrack.createAudioTrack('agent-voice', agentSource);
  const player = new AudioPlayer(agentSource);

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`[room] Participant connected: ${participant.identity}`);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    console.log(`[room] Participant disconnected: ${participant.identity}`);
    if (participant.identity === 'phone-user') {
      console.log('[agent] Phone user hung up. Exiting.');
      process.exit(0);
    }
  });

  // Promise that resolves when the SIP call is answered
  let callAnsweredResolve;
  const callAnswered = new Promise(r => { callAnsweredResolve = r; });

  // 3. When phone user's audio arrives, wire up the real STT → Claude → TTS pipeline
  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    console.log(`[agent] Subscribed to audio from: ${participant.identity}`);

    // Create Speechmatics STT with silence-timeout logic
    const sttClient = createSTTClient({
      onPartial: (text) => {
        partialUtterance = text;

        // ── Barge-in: user started talking while agent is playing ──
        if (text.trim() && player.isPlaying()) {
          console.log(`[barge-in] 🛑 User interrupted: "${text.trim()}"`);
          generationId++;
          player.stopNow();
          isProcessing = false;
        }

        // Reset silence timer — user is still speaking
        if (utteranceTimer) clearTimeout(utteranceTimer);
        const pending = (currentUtterance + ' ' + text).trim();
        const silenceMs = getSilenceTimeout(pending);
        utteranceTimer = setTimeout(() => {
          const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
          currentUtterance = fullText;
          partialUtterance = '';
          console.log(`[stt] Silence timeout (${silenceMs}ms) — triggering response (utterance: "${fullText}")`);
          handleEndOfUtterance(player);
        }, silenceMs);
      },
      onFinal: (text) => {
        console.log(`[stt] Final: "${text}"`);
        if (text.trim()) {
          currentUtterance += (currentUtterance ? ' ' : '') + text;
        }
        partialUtterance = '';
        if (utteranceTimer) clearTimeout(utteranceTimer);
        const silenceMs = getSilenceTimeout(currentUtterance);
        utteranceTimer = setTimeout(() => {
          console.log(`[stt] Silence timeout (${silenceMs}ms) — triggering response (utterance: "${currentUtterance}")`);
          handleEndOfUtterance(player);
        }, silenceMs);
      },
      onEndOfUtterance: () => {
        const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
        currentUtterance = fullText;
        partialUtterance = '';
        console.log(`[stt] EndOfUtterance — utterance: "${fullText}", isProcessing: ${isProcessing}`);
        if (utteranceTimer) clearTimeout(utteranceTimer);
        handleEndOfUtterance(player);
      },
    });

    // Connect STT, then wait for SIP call to be answered before greeting
    await connectSTTForLiveKit(sttClient);
    console.log('[agent] Waiting for SIP call to be answered before greeting...');
    await callAnswered;
    await new Promise(r => setTimeout(r, 300));
    await playGreeting(player);

    // Stream phone audio to Speechmatics STT
    const audioStream = new AudioStream(track, AGENT_SAMPLE_RATE, 1);
    for await (const frame of audioStream) {
      t_lastAudioPacket = ms();
      try {
        sttClient.sendAudio(frame.data);
      } catch (err) {
        // Expected during init, suppress
      }
    }
  });

  await room.connect(LIVEKIT_URL, agentToken, { autoSubscribe: true });
  console.log(`[agent] Connected to room as "ai-agent"`);

  // Publish the agent audio track
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(agentTrack, publishOptions);
  console.log(`[agent] Audio track published as MICROPHONE source`);

  // Wait for TTS cache warmup to finish before dialing
  await cacheWarmup;

  // 4. Dial the phone number (agent is already in the room waiting)
  console.log(`[sip] Dialing ${PHONE_NUMBER} via trunk ${SIP_TRUNK_ID}...`);
  const sipClient = new SipClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  const sipParticipant = await sipClient.createSipParticipant(
    SIP_TRUNK_ID,
    PHONE_NUMBER,
    ROOM_NAME,
    {
      participantIdentity: 'phone-user',
      participantName: 'Phone User',
      playDialtone: true,
    },
  );

  console.log(`[sip] Call connected! SIP participant:`, sipParticipant.participantIdentity);

  // Signal that the call is answered — greeting can now play
  callAnsweredResolve();

  // Keep alive
  console.log('[agent] Agent is running. Press Ctrl+C to exit.');
  process.on('SIGINT', async () => {
    console.log('\n[agent] Shutting down...');
    await room.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
