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
import { createSTTClient, synthesizeSpeech, synthesizeSpeechStreaming } from './speechmatics.js';
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
const AGENT_SAMPLE_RATE = 16000; // matches Speechmatics TTS output

// ─── Pipeline Tuning Constants ──────────────────────────────────
const FLUSH_CHARS_MIN   = 80;    // min chars before considering a buffer flush
const FLUSH_TIMEOUT_MS  = 350;   // max ms between flushes
const TTS_BATCH_TARGET  = 200;   // ideal chars per TTS call (~2s speech)
const TTS_BATCH_MIN     = 40;    // min chars for punctuation-triggered flush
const COMMIT_DELAY_SHORT_MS = 700;  // delay for 1–2 word utterances (phone pauses are longer)
const COMMIT_DELAY_LONG_MS  = 400;  // delay for 3+ word utterances
const VAD_NOISE_FLOOR_INIT  = 200;  // initial noise floor estimate
const VAD_NOISE_ALPHA       = 0.03; // EMA smoothing factor for noise floor update
const VAD_THRESHOLD_FACTOR  = 3.0;  // speech threshold = noiseFloor * factor
const VAD_FLOOR_MIN         = 50;   // minimum noise floor — prevents threshold reaching 0
const VAD_FLOOR_MAX         = 1500; // cap noise floor for extremely noisy lines
const VAD_SILENCE_MS        = 250;  // ms of sub-threshold RMS before "silence"

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
const SPEECH_TAIL_MS = 800; // ms to keep isSpeaking() true after drain ends (phone echo drain)

class AudioPlayer {
  constructor(source) {
    this._source = source;
    this._queue = [];       // array of Int16Array chunks
    this._draining = false;
    this._stopped = false;
    this._doneResolvers = [];
    this._speakingUntil = 0;
  }

  /** True while audio is playing OR within the echo tail after playback ends */
  isSpeaking() {
    return this._draining || performance.now() < this._speakingUntil;
  }

  stopNow() {
    this._stopped = true;
    this._queue.length = 0;
    this._speakingUntil = performance.now() + SPEECH_TAIL_MS;
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
    this._speakingUntil = performance.now() + SPEECH_TAIL_MS;
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
let generationId = 0;        // Incremented on barge-in to invalidate stale TTS
let lastSpeechTime = 0;      // timestamp of last VAD-detected speech
let noiseFloor = VAD_NOISE_FLOOR_INIT; // adaptive noise floor estimate (EMA)
let commitTimer = null;      // delay timer before committing to response
let currentAbortController = null; // AbortController for current LLM+TTS turn
let heardUserSpeech = false;       // true when VAD detects speech while agent is NOT speaking

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

/** Compute RMS energy of PCM Int16 samples for voice activity detection */
function computeRMS(int16Array) {
  let sum = 0;
  for (let i = 0; i < int16Array.length; i++) sum += int16Array[i] * int16Array[i];
  return Math.sqrt(sum / int16Array.length);
}

// ─── TTS Phrase Cache ─────────────────────────────────────────
const ttsCache = new Map();

const BRIDGE_FILLERS = [
  "Got it, one sec.",
  "I hear you, let me think.",
  "Okay, give me a moment.",
  "Right, let me consider that.",
];

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

async function cachedSynthesizeSpeech(text, { signal } = {}) {
  const key = text.toLowerCase().trim();
  if (ttsCache.has(key)) {
    console.log(`  ⚡ TTS cache hit: "${text.slice(0, 40)}..."`);
    return ttsCache.get(key);
  }
  const pcm = await synthesizeSpeech(text, 'sarah', { signal });
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
    currentUtterance = '';
    partialUtterance = '';
    heardUserSpeech = false;
    console.log('[pipeline] Greeting played');
  } catch (err) {
    console.error('[pipeline] Greeting TTS failed:', err.message);
  }
}

async function handleEndOfUtterance(player) {
  if (isProcessing) return;

  const userText = currentUtterance.trim();
  if (!userText) return;

  // Filter garbage / too-short STT outputs (".", "Hi .", "High", etc.)
  const MIN_INPUT_CHARS = 4;
  const stripped = userText.replace(/[\s.!?,;:'"()\-]+/g, '');
  if (stripped.length < MIN_INPUT_CHARS) {
    console.log(`[filter] Skipping short/empty input: "${userText}"`);
    currentUtterance = '';
    partialUtterance = '';
    return;
  }

  isProcessing = true;
  currentUtterance = '';
  partialUtterance = '';

  // Abort any previous in-flight turn
  if (currentAbortController) {
    currentAbortController.abort();
  }
  const abortController = new AbortController();
  currentAbortController = abortController;
  const { signal } = abortController;

  const t_endpointDetected = ms();

  console.log(`\n━━━ Turn: "${userText}" ━━━`);
  logLatency('EoU latency (silence detect − last audio)', t_lastAudioPacket, t_endpointDetected);

  messages.push({ role: 'user', content: userText });

  try {
    // ── Play bridge filler to keep isSpeaking()=true during LLM wait ──
    const filler = BRIDGE_FILLERS[bridgeIndex++ % BRIDGE_FILLERS.length];
    let fillerPcm = ttsCache.get(filler.toLowerCase().trim());
    if (!fillerPcm) {
      try { fillerPcm = await synthesizeSpeech(filler, 'sarah', { signal }); } catch {}
    }
    if (fillerPcm) {
      console.log(`  [bridge] "${filler}"`);
      player.enqueue(fillerPcm);
    }

    // ── Two-level accumulation: buffer → ttsAccum → TTS ──
    let buffer = '';          // raw LLM chunks
    let ttsAccum = '';        // flushed text waiting for TTS batch
    let t_llmFirstToken = 0;
    let lastFlushTime = ms();
    let sentenceIndex = 0;
    const thisGenId = generationId;
    const ttsTasks = [];

    const fireTts = (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (signal.aborted) { console.log(`  [skip] aborted`); return; }
      const idx = sentenceIndex++;
      logLatency(`S${idx} LLM->TTS start`, t_endpointDetected, ms());
      const key = trimmed.toLowerCase().trim();
      const promise = (async () => {
        const t_ttsStart = ms();
        if (ttsCache.has(key)) {
          console.log(`  ⚡ TTS cache hit: "${trimmed.slice(0, 40)}..."`);
          logLatency(`S${idx} TTS synthesis (cached)`, t_ttsStart, ms());
          return ttsCache.get(key); // Returns Buffer
        }
        // Stream for cache misses — returns ReadableStream
        const stream = await synthesizeSpeechStreaming(trimmed, 'sarah', { signal });
        logLatency(`S${idx} TTS stream started`, t_ttsStart, ms());
        return stream;
      })();
      ttsTasks.push({ promise, sentence: trimmed, idx });
    };

    /** Flush buffer → ttsAccum, then fire TTS if ttsAccum is large enough */
    const flushBuffer = () => {
      if (!buffer) return;
      ttsAccum += buffer;
      buffer = '';
      lastFlushTime = ms();
      // Fire TTS when ttsAccum hits batch target
      if (ttsAccum.length >= TTS_BATCH_TARGET) {
        fireTts(ttsAccum);
        ttsAccum = '';
      }
    };

    // 50ms interval to catch time-threshold flushes between LLM chunks
    const flushInterval = setInterval(() => {
      if (buffer && (ms() - lastFlushTime >= FLUSH_TIMEOUT_MS)) {
        flushBuffer();
      }
    }, 50);

    const t_llmStart = ms();
    logLatency('STT finalize (endpoint → LLM request)', t_endpointDetected, t_llmStart);

    const responseText = await generateResponseStreaming(messages, (chunk) => {
      if (signal.aborted) return;
      if (!t_llmFirstToken) {
        t_llmFirstToken = ms();
        logLatency('LLM TTFT (first token)', t_llmStart, t_llmFirstToken);
      }
      buffer += chunk;

      // Flush rules: char threshold OR punctuation + min chars
      if (buffer.length >= FLUSH_CHARS_MIN) {
        flushBuffer();
      } else if (/[.!?,]/.test(chunk) && buffer.length >= TTS_BATCH_MIN) {
        flushBuffer();
      }
    }, { signal });

    clearInterval(flushInterval);

    // Force flush any remaining text
    if (buffer.trim()) {
      ttsAccum += buffer;
      buffer = '';
    }
    if (ttsAccum.trim()) {
      fireTts(ttsAccum);
      ttsAccum = '';
    }

    const t_llmDone = ms();
    logLatency('LLM total generation', t_llmStart, t_llmDone);

    // Consumer: await each TTS result in order, enqueue to player
    for (const { promise, sentence, idx } of ttsTasks) {
      if (generationId !== thisGenId || signal.aborted) {
        console.log(`  [skip] S${idx}: discarded (barge-in)`);
        continue;
      }
      try {
        const result = await promise;
        if (generationId !== thisGenId || signal.aborted) {
          console.log(`  [skip] S${idx}: discarded after TTS (barge-in)`);
          continue;
        }

        if (result instanceof Buffer) {
          // Cache hit — full buffer, enqueue immediately
          player.enqueue(result);
          const t_enqueued = ms();
          logLatency(`S${idx} TOTAL (endpoint → audio enqueued)`, t_endpointDetected, t_enqueued);
          console.log(`  S${idx}: "${sentence}" (${(result.length / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s audio)`);
        } else {
          // Stream — read chunks and enqueue incrementally
          // Must maintain even byte alignment for Int16 PCM samples
          const reader = result.getReader();
          const chunks = [];
          let totalBytes = 0;
          let leftover = null; // dangling byte from odd-length chunk
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (generationId !== thisGenId || signal.aborted) {
              reader.cancel();
              console.log(`  [skip] S${idx}: stream cancelled (barge-in)`);
              break;
            }
            let buf = Buffer.from(value);
            // Prepend any leftover byte from previous chunk
            if (leftover) {
              buf = Buffer.concat([leftover, buf]);
              leftover = null;
            }
            // Hold back dangling byte if odd length
            if (buf.length % 2 !== 0) {
              leftover = buf.slice(buf.length - 1);
              buf = buf.slice(0, buf.length - 1);
            }
            if (buf.length > 0) {
              player.enqueue(buf);
              chunks.push(buf);
              totalBytes += buf.length;
            }
          }
          const t_enqueued = ms();
          logLatency(`S${idx} TOTAL (endpoint → stream done)`, t_endpointDetected, t_enqueued);
          console.log(`  S${idx}: "${sentence}" (${(totalBytes / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s audio, streamed)`);
          // Cache the full buffer for future hits
          if (chunks.length > 0) {
            const fullBuf = Buffer.concat(chunks);
            ttsCache.set(sentence.toLowerCase().trim(), fullBuf);
          }
        }
      } catch (err) {
        if (signal.aborted) { console.log(`  [skip] S${idx}: aborted`); continue; }
        console.error(`[pipeline] S${idx} TTS failed:`, err.message);
      }
    }

    // Wait for all audio to finish playing (unless barged in)
    if (generationId === thisGenId && !signal.aborted) {
      await player.waitUntilDone();
    }
    currentUtterance = '';
    partialUtterance = '';
    heardUserSpeech = false;

    const t_allDone = ms();
    const bargedIn = generationId !== thisGenId || signal.aborted;
    logLatency(`Full turn (endpoint → ${bargedIn ? 'barge-in' : 'all audio played'})`, t_endpointDetected, t_allDone);
    console.log(`━━━ End turn${bargedIn ? ' (interrupted)' : ''}: "${responseText}" ━━━\n`);

    messages.push({ role: 'assistant', content: responseText });
  } catch (err) {
    if (signal.aborted) {
      console.log(`[pipeline] Turn aborted`);
    } else {
      console.error('[pipeline] Response pipeline failed:', err.message);
    }
  } finally {
    isProcessing = false;
    if (currentAbortController === abortController) {
      currentAbortController = null;
    }
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

    // Create Speechmatics STT — gated by player.isSpeaking()
    const sttClient = createSTTClient({
      onPartial: (text) => {
        if (player.isSpeaking()) return;
        partialUtterance = text;
        if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      },
      onFinal: (text) => {
        if (player.isSpeaking()) return;
        console.log(`[stt] Final: "${text}"`);
        if (text.trim()) {
          currentUtterance += (currentUtterance ? ' ' : '') + text;
        }
        partialUtterance = '';
        if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      },
      onEndOfUtterance: () => {
        const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
        currentUtterance = fullText;
        partialUtterance = '';
        console.log(`[stt] EndOfUtterance — utterance: "${fullText}"`);
      },
    });

    await connectSTTForLiveKit(sttClient);

    // Start consuming audio frames IMMEDIATELY (prevents buffer buildup during greeting)
    const audioStream = new AudioStream(track, AGENT_SAMPLE_RATE, 1);
    (async () => {
      for await (const frame of audioStream) {
        t_lastAudioPacket = ms();

        const samples = new Int16Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength / 2);
        const rms = computeRMS(samples);
        const vadThreshold = noiseFloor * VAD_THRESHOLD_FACTOR;

        if (rms > vadThreshold) {
          lastSpeechTime = ms();
          if (!player.isSpeaking() && !heardUserSpeech) {
            heardUserSpeech = true;
            // Discard any echo text that accumulated before user spoke
            currentUtterance = '';
            partialUtterance = '';
          }
          if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
        } else {
          noiseFloor = noiseFloor * (1 - VAD_NOISE_ALPHA) + rms * VAD_NOISE_ALPHA;
          if (noiseFloor < VAD_FLOOR_MIN) noiseFloor = VAD_FLOOR_MIN;
          if (noiseFloor > VAD_FLOOR_MAX) noiseFloor = VAD_FLOOR_MAX;

          const silenceDuration = ms() - lastSpeechTime;
          const pendingText = (currentUtterance + ' ' + (partialUtterance || '')).trim();

          if (silenceDuration >= VAD_SILENCE_MS && pendingText && !isProcessing && !commitTimer && !player.isSpeaking() && heardUserSpeech) {
            console.log(`[vad] Silence detected (${silenceDuration.toFixed(0)}ms, RMS=${rms.toFixed(0)}, floor=${noiseFloor.toFixed(0)}, thresh=${vadThreshold.toFixed(0)})`);
            const wordCount = pendingText.split(/\s+/).length;
            const commitDelay = wordCount <= 2 ? COMMIT_DELAY_SHORT_MS : COMMIT_DELAY_LONG_MS;
            commitTimer = setTimeout(() => {
              commitTimer = null;
              const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
              currentUtterance = fullText;
              partialUtterance = '';
              console.log(`[vad] Commit delay elapsed (${commitDelay}ms, ${wordCount} words) — triggering response: "${fullText}"`);
              handleEndOfUtterance(player);
            }, commitDelay);
          }
        }

        // Only forward audio to STT when agent is not speaking
        if (!player.isSpeaking()) {
          try { sttClient.sendAudio(frame.data); } catch {}
        }
      }
    })(); // frame loop runs concurrently — don't await

    // Play greeting AFTER frame loop starts (frames consumed in real-time, no buffer buildup)
    console.log('[agent] Waiting for SIP call to be answered before greeting...');
    await callAnswered;
    await new Promise(r => setTimeout(r, 300));
    await playGreeting(player);
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
