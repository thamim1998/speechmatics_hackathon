/**
 * LiveKit Outbound PSTN Calling Agent
 *
 * AI agent dials a real phone number via LiveKit Cloud + Twilio SIP trunk,
 * joins a LiveKit room, and speaks to the user in real time.
 *
 * Pipeline:
 *   LiveKit AudioStream (PCM 16kHz) → Speechmatics STT (real-time)
 *     → 0.5s silence timeout → Backboard LLM (streaming)
 *     → sentence-by-sentence Speechmatics TTS → LiveKit AudioSource
 *
 * Features:
 *   - Backboard LLM with memory (replaces Claude)
 *   - Real-time keyword sentiment analysis
 *   - WhatsApp alerts on CRITICAL sentiment
 *   - Post-call Speechmatics batch sentiment + summary
 *   - Caretaker API event pushes
 *   - Session tracking with timing metrics
 *
 * Usage:
 *   node livekit-agent.js +33XXXXXXXXX
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
import { createSTTClient, synthesizeSpeech, synthesizeSpeechStreaming, createWavBuffer, submitBatchAnalysis, pollBatchJob } from './speechmatics.js';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import { generateResponseStreaming, GREETING_FALLBACK, GREETING_PROMPT, getFullSystemPrompt } from './counsellor.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { bootstrapBackboard } from './backboard/bootstrap.js';
import { CaretakerStore } from './backboard/caretakerStore.js';
import { BackboardClient } from './backboard/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────
const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  SIP_TRUNK_ID,
  SPEECHMATICS_API_KEY,
  BACKBOARD_API_KEY,
  CARETAKER_PHONE,
} = process.env;

const PHONE_NUMBER = process.argv[2];
const ROOM_NAME = `call-${Date.now()}`;
const AGENT_SAMPLE_RATE = 16000; // matches Speechmatics TTS output

// ─── Pipeline Tuning Constants ──────────────────────────────────
const FLUSH_CHARS_MIN   = 50;    // min chars before considering a buffer flush
const FLUSH_TIMEOUT_MS  = 250;   // max ms between flushes
const TTS_BATCH_TARGET  = 120;   // ideal chars per TTS call (~1s speech) — smaller = faster first audio
const TTS_BATCH_MIN     = 30;    // min chars for punctuation-triggered flush
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

// ─── Terminal Colors ─────────────────────────────────────────────
const C = {
  RED: '\x1b[91m', GREEN: '\x1b[92m', YELLOW: '\x1b[93m',
  MAGENTA: '\x1b[95m', CYAN: '\x1b[96m', BOLD: '\x1b[1m',
  DIM: '\x1b[2m', RESET: '\x1b[0m', BG_RED: '\x1b[41m', WHITE: '\x1b[97m',
};

// ─── Sentiment Analysis ──────────────────────────────────────────
const CRITICAL_WORDS = [
  'fall', 'fell', 'hurt myself', 'emergency', 'help me', "can't breathe",
  'chest pain', 'blood', 'bleeding', 'die', 'dying', 'kill', 'suicide',
  'lost', "don't know where",
];
const NEGATIVE_WORDS = [
  'sad', 'hurt', 'pain', 'angry', 'frustrated', 'confused', 'scared',
  'afraid', 'worried', 'anxious', 'lonely', 'tired', 'bad', 'terrible',
  'depressed', 'cry', 'crying', 'sick', 'dizzy', 'weak', 'forget', 'forgot',
  'upset', 'unhappy', 'miss', 'missing', 'headache', 'ache',
];
const POSITIVE_WORDS = [
  'happy', 'good', 'great', 'wonderful', 'nice', 'love', 'enjoy',
  'beautiful', 'fun', 'laugh', 'smile', 'better', 'fine', 'well',
  'amazing', 'pleased', 'grateful', 'thankful', 'excited',
  'delicious', 'lovely', 'calm', 'relaxed', 'comfortable',
];

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  const crit = CRITICAL_WORDS.filter(w => lower.includes(w)).length;
  if (crit > 0) return { sentiment: 'CRITICAL', confidence: Math.min(0.7 + crit * 0.1, 0.99) };
  const neg = NEGATIVE_WORDS.filter(w => lower.includes(w)).length;
  const pos = POSITIVE_WORDS.filter(w => lower.includes(w)).length;
  if (neg > pos) return { sentiment: 'negative', confidence: Math.min(0.4 + neg * 0.1, 0.95) };
  if (pos > neg) return { sentiment: 'positive', confidence: Math.min(0.4 + pos * 0.1, 0.95) };
  return { sentiment: 'neutral', confidence: 0.5 };
}

function sentimentBadge(sentiment, confidence) {
  const pct = `${(confidence * 100).toFixed(0)}%`;
  if (sentiment === 'CRITICAL') return `${C.BG_RED}${C.WHITE}${C.BOLD} !! CRITICAL (${pct}) !! ${C.RESET}`;
  if (sentiment === 'negative') return `${C.RED}[NEGATIVE ${pct}]${C.RESET}`;
  if (sentiment === 'positive') return `${C.GREEN}[POSITIVE ${pct}]${C.RESET}`;
  return `${C.YELLOW}[NEUTRAL ${pct}]${C.RESET}`;
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Session Tracker ─────────────────────────────────────────────
class SessionTracker {
  constructor() {
    this.startTime = performance.now();
    this.startDate = new Date();
    this.messages = [];
    this.exchangeTimes = [];
    this._llmStart = 0;
    this._llmFirstToken = 0;
  }

  logUserMessage(text) {
    const elapsed = (performance.now() - this.startTime) / 1000;
    const { sentiment, confidence } = analyzeSentiment(text);
    const badge = sentimentBadge(sentiment, confidence);
    console.log(`\n  ${C.DIM}[${fmtTime(elapsed)}]${C.RESET} ${C.CYAN}Patient:${C.RESET} ${text}`);
    console.log(`  ${' '.repeat(9)}${badge}`);

    this.messages.push({
      timestamp: new Date().toISOString(),
      elapsed_s: Math.round(elapsed * 10) / 10,
      speaker: 'patient',
      text,
      sentiment,
      confidence: Math.round(confidence * 100) / 100,
    });

    if (sentiment === 'CRITICAL') {
      console.log(`\n  ${C.BG_RED}${C.WHITE}${C.BOLD}  !! ALERT: Critical concern - notifying caretaker !!  ${C.RESET}\n`);
    }

    return { sentiment, confidence };
  }

  llmStart() {
    this._llmStart = performance.now();
    this._llmFirstToken = 0;
  }

  llmFirstToken() {
    if (!this._llmFirstToken) {
      this._llmFirstToken = performance.now();
    }
  }

  logAssistantMessage(text) {
    const elapsed = (performance.now() - this.startTime) / 1000;
    const llmTotal = this._llmStart ? (performance.now() - this._llmStart) / 1000 : 0;
    const ttfb = this._llmFirstToken && this._llmStart ? (this._llmFirstToken - this._llmStart) / 1000 : llmTotal;

    // Don't run sentiment on Megan's messages — only patient messages matter
    console.log(`  ${C.DIM}[${fmtTime(elapsed)}]${C.RESET} ${C.MAGENTA}Megan:${C.RESET} ${text}`);
    console.log(`  ${C.DIM}  LLM: ${llmTotal.toFixed(1)}s total, TTFB: ${ttfb.toFixed(1)}s${C.RESET}`);

    this.messages.push({
      timestamp: new Date().toISOString(),
      elapsed_s: Math.round(elapsed * 10) / 10,
      speaker: 'megan',
      text,
      sentiment: 'neutral',
      confidence: 0,
      llm_total_s: Math.round(llmTotal * 100) / 100,
      llm_ttfb_s: Math.round(ttfb * 100) / 100,
    });

    this.exchangeTimes.push({
      exchange: this.exchangeTimes.length + 1,
      llm: Math.round(llmTotal * 100) / 100,
      ttfb: Math.round(ttfb * 100) / 100,
    });
  }

  getSessionReport() {
    const duration = (performance.now() - this.startTime) / 1000;
    const patientMsgs = this.messages.filter(m => m.speaker === 'patient');
    const pos = patientMsgs.filter(m => m.sentiment === 'positive').length;
    const neg = patientMsgs.filter(m => m.sentiment === 'negative').length;
    const neu = patientMsgs.filter(m => m.sentiment === 'neutral').length;
    const crit = patientMsgs.filter(m => m.sentiment === 'CRITICAL').length;

    let overall = 'neutral';
    if (crit > 0) overall = 'CRITICAL';
    else if (neg > pos) overall = 'negative';
    else if (pos > neg) overall = 'positive';

    const n = this.exchangeTimes.length;
    return {
      date: this.startDate.toISOString().slice(0, 10),
      time: this.startDate.toTimeString().slice(0, 8),
      day: this.startDate.toLocaleDateString('en-US', { weekday: 'long' }),
      duration_s: Math.round(duration * 10) / 10,
      exchanges: n,
      overall_sentiment: overall,
      sentiment_counts: { positive: pos, neutral: neu, negative: neg, critical: crit },
      avg_ttfb_s: n ? Math.round((this.exchangeTimes.reduce((s, e) => s + e.ttfb, 0) / n) * 100) / 100 : 0,
      avg_llm_total_s: n ? Math.round((this.exchangeTimes.reduce((s, e) => s + e.llm, 0) / n) * 100) / 100 : 0,
      messages: this.messages,
      exchange_timing: this.exchangeTimes,
    };
  }

  printSummary(caretakerSummary) {
    const report = this.getSessionReport();
    const n = report.exchanges;

    console.log(`\n${C.BOLD}${'='.repeat(60)}${C.RESET}`);
    console.log(`${C.BOLD}  SESSION SUMMARY${C.RESET}`);
    console.log(`${C.BOLD}${'='.repeat(60)}${C.RESET}`);
    console.log(`  Date:              ${report.day}, ${report.date}`);
    console.log(`  Time:              ${report.time}`);
    console.log(`  Duration:          ${fmtTime(report.duration_s)} (${report.duration_s.toFixed(1)}s)`);
    console.log(`  Exchanges:         ${n}`);

    if (this.exchangeTimes.length > 0) {
      console.log(`  Avg TTFB:          ${report.avg_ttfb_s.toFixed(1)}s`);
      console.log(`  Avg LLM total:     ${report.avg_llm_total_s.toFixed(1)}s`);
      const fastest = Math.min(...this.exchangeTimes.map(e => e.ttfb));
      const slowest = Math.max(...this.exchangeTimes.map(e => e.ttfb));
      console.log(`  Fastest TTFB:      ${fastest.toFixed(1)}s`);
      console.log(`  Slowest TTFB:      ${slowest.toFixed(1)}s`);

      console.log(`\n  ${C.BOLD}Exchange Timing:${C.RESET}`);
      console.log(`  ${'-'.repeat(35)}`);
      console.log(`  ${'#'.padStart(3)}  ${'TTFB'.padStart(7)}  ${'LLM Total'.padStart(10)}`);
      console.log(`  ${'---'.padStart(3)}  ${'-------'.padStart(7)}  ${'----------'.padStart(10)}`);
      for (const e of this.exchangeTimes) {
        console.log(`  ${String(e.exchange).padStart(3)}  ${(e.ttfb.toFixed(1) + 's').padStart(7)}  ${(e.llm.toFixed(1) + 's').padStart(10)}`);
      }
      console.log(`  ${'AVG'.padStart(3)}  ${(report.avg_ttfb_s.toFixed(1) + 's').padStart(7)}  ${(report.avg_llm_total_s.toFixed(1) + 's').padStart(10)}`);
    }

    // Message sentiment
    const patientMsgs = this.messages.filter(m => m.speaker === 'patient');
    if (patientMsgs.length > 0) {
      const sc = report.sentiment_counts;
      console.log(`\n  ${C.BOLD}Patient Sentiment Overview:${C.RESET}`);
      console.log(`  ${'-'.repeat(56)}`);
      if (sc.critical > 0) console.log(`  ${C.BG_RED}${C.WHITE}${C.BOLD}  CRITICAL: ${sc.critical}  ${C.RESET}  !! Alert caretaker !!`);
      console.log(`  ${C.GREEN}  Positive: ${String(sc.positive).padStart(3)}${C.RESET}  ${'#'.repeat(sc.positive)}`);
      console.log(`  ${C.YELLOW}  Neutral:  ${String(sc.neutral).padStart(3)}${C.RESET}  ${'#'.repeat(sc.neutral)}`);
      console.log(`  ${C.RED}  Negative: ${String(sc.negative).padStart(3)}${C.RESET}  ${'#'.repeat(sc.negative)}`);

      const overall = report.overall_sentiment;
      let mood;
      if (overall === 'CRITICAL') mood = `${C.BG_RED}${C.WHITE}${C.BOLD} ALERT - CRITICAL CONCERNS ${C.RESET}`;
      else if (overall === 'negative') mood = `${C.RED}${C.BOLD} Patient seems DOWN ${C.RESET}`;
      else if (overall === 'positive') mood = `${C.GREEN}${C.BOLD} Patient in GOOD spirits ${C.RESET}`;
      else mood = `${C.YELLOW}${C.BOLD} Patient mood NEUTRAL ${C.RESET}`;
      console.log(`\n  Overall Mood: ${mood}`);
    }

    if (caretakerSummary) {
      console.log(`\n  ${C.BOLD}Caretaker Summary:${C.RESET}`);
      console.log(`  ${'-'.repeat(56)}`);
      for (const line of caretakerSummary.split('\n')) {
        console.log(`  ${line}`);
      }
    }

    console.log(`${C.BOLD}${'='.repeat(60)}${C.RESET}`);
  }
}

// ─── Backboard State ─────────────────────────────────────────────
let backboardThreadId = null;  // set during main() after bootstrap
let caretakerStore = null;     // CaretakerStore instance
const tracker = new SessionTracker();

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
let messages = [];           // Backboard conversation history [{role, content}]
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

// Short backchannels — only played if LLM takes too long (>FILLER_DELAY_MS)
const BRIDGE_FILLERS = [
  "Mhm.",
  "Hmm.",
  "Mm.",
  "Right.",
];

const FILLER_DELAY_MS = 600; // only play filler if LLM TTFB exceeds this

const CACHE_WARMUP_PHRASES = [
  GREETING_FALLBACK,
  ...BRIDGE_FILLERS,
  "That sounds really difficult.",
  "Tell me more about that.",
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
  const pcm = await synthesizeSpeech(text, 'megan', { signal });
  ttsCache.set(key, pcm);
  return pcm;
}

async function warmTtsCache() {
  console.log(`[cache] Pre-warming TTS cache with ${CACHE_WARMUP_PHRASES.length} phrases...`);
  const t0 = ms();
  const results = await Promise.allSettled(
    CACHE_WARMUP_PHRASES.map(async (phrase) => {
      const pcm = await synthesizeSpeech(phrase, 'megan');
      ttsCache.set(phrase.toLowerCase().trim(), pcm);
    }),
  );
  const hits = results.filter(r => r.status === 'fulfilled').length;
  logLatency(`Cache warmup (${hits}/${CACHE_WARMUP_PHRASES.length} phrases)`, t0, ms());
}

// ─── Voice Pipeline ────────────────────────────────────────────

/**
 * Pre-generate the personalized greeting (LLM + TTS) while the phone is ringing.
 * Returns { text, pcmAudio } ready to play instantly on answer.
 */
async function prepareGreeting() {
  let greetingText = GREETING_FALLBACK;

  if (backboardThreadId) {
    try {
      const t0 = ms();
      let llmGreeting = '';
      await generateResponseStreaming(
        [{ role: 'user', content: GREETING_PROMPT }],
        (chunk) => { llmGreeting += chunk; },
        { threadId: backboardThreadId },
      );
      if (llmGreeting.trim()) {
        greetingText = llmGreeting.trim();
        console.log(`[greeting] LLM greeting (${ms() - t0}ms): "${greetingText}"`);
      }
    } catch (err) {
      console.warn(`[greeting] LLM failed, using fallback: ${err.message}`);
    }
  }

  const t0 = ms();
  const pcmAudio = await cachedSynthesizeSpeech(greetingText);
  logLatency('Greeting TTS', t0, ms());
  console.log(`[greeting] Ready: "${greetingText}" (${(pcmAudio.length / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s audio)`);
  return { text: greetingText, pcmAudio };
}

/**
 * Play a pre-generated greeting immediately.
 */
async function playGreeting(player, { text, pcmAudio }) {
  console.log('[pipeline] Playing greeting');
  messages.push({ role: 'assistant', content: text });
  try {
    const audio = pcmAudio || await cachedSynthesizeSpeech(text);
    player.enqueue(audio);
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

  // ── Sentiment analysis ──
  const sentimentResult = tracker.logUserMessage(userText);

  // ── WhatsApp alert on CRITICAL ──
  if (sentimentResult.sentiment === 'CRITICAL' && CARETAKER_PHONE) {
    const alertText = `ALERT: Patient expressed critical concern: "${userText.slice(0, 100)}"`;
    sendWhatsAppMessage(alertText, CARETAKER_PHONE).catch(err =>
      console.error('[whatsapp] Alert failed:', err.message)
    );
    if (caretakerStore) {
      caretakerStore.addCaretakerEvent({
        type: 'incident',
        text: alertText,
        data: { incidentType: 'critical_speech', severity: 5, description: userText },
        tags: ['auto-detected', 'voice-agent'],
      }).catch(err => console.error('[caretaker] Incident push failed:', err.message));
    }
  }

  messages.push({ role: 'user', content: userText });

  // ── Session tracker: LLM start ──
  tracker.llmStart();

  try {
    // ── Conditional bridge filler: only if LLM TTFB > FILLER_DELAY_MS ──
    let fillerPlayed = false;
    const fillerTimer = setTimeout(() => {
      const filler = BRIDGE_FILLERS[bridgeIndex++ % BRIDGE_FILLERS.length];
      const fillerPcm = ttsCache.get(filler.toLowerCase().trim());
      if (fillerPcm && !signal.aborted) {
        console.log(`  [bridge] "${filler}" (LLM slow, >${FILLER_DELAY_MS}ms)`);
        player.enqueue(fillerPcm);
        fillerPlayed = true;
      }
    }, FILLER_DELAY_MS);

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
        const stream = await synthesizeSpeechStreaming(trimmed, 'megan', { signal });
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
        clearTimeout(fillerTimer); // cancel filler — LLM responded in time
        logLatency('LLM TTFT (first token)', t_llmStart, t_llmFirstToken);
        tracker.llmFirstToken();
      }
      buffer += chunk;

      // Flush rules: char threshold OR punctuation + min chars
      if (buffer.length >= FLUSH_CHARS_MIN) {
        flushBuffer();
      } else if (/[.!?,]/.test(chunk) && buffer.length >= TTS_BATCH_MIN) {
        flushBuffer();
      }
    }, { signal, threadId: backboardThreadId });

    clearInterval(flushInterval);
    clearTimeout(fillerTimer);

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
          // Fallback: if streaming returned 0 bytes, use non-streaming TTS
          if (totalBytes === 0 && !signal.aborted) {
            console.warn(`  [fallback] S${idx}: stream returned 0 bytes, retrying non-streaming`);
            try {
              const fallbackPcm = await synthesizeSpeech(sentence, 'megan', { signal });
              player.enqueue(fallbackPcm);
              totalBytes = fallbackPcm.length;
              chunks.push(fallbackPcm);
            } catch (fbErr) {
              console.error(`  [fallback] S${idx}: non-streaming TTS also failed:`, fbErr.message);
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
    tracker.logAssistantMessage(responseText);
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

// ─── Audio Recording Buffer ──────────────────────────────────────
const recordedFrames = []; // Buffer[] of raw PCM frames for post-call batch analysis

async function main() {
  const httpUrl = LIVEKIT_URL.replace('wss://', 'https://');

  // ── Backboard bootstrap + TTS cache warmup — run in parallel, don't block call ──
  let bbState;
  const backboardReady = (async () => {
    try {
      console.log('[backboard] Bootstrapping Backboard assistant...');
      bbState = await bootstrapBackboard();
      console.log(`[backboard] Assistant: ${bbState.assistant_id}`);

      // Create a FRESH thread for this call session
      const bbClient = new BackboardClient(BACKBOARD_API_KEY);
      const callThread = await bbClient.createThread(bbState.assistant_id);
      backboardThreadId = callThread.thread_id || callThread.id;
      console.log(`[backboard] Call thread: ${backboardThreadId}`);

      // Create CaretakerStore for event pushes
      if (BACKBOARD_API_KEY) {
        caretakerStore = new CaretakerStore({ apiKey: BACKBOARD_API_KEY, threadId: bbState.thread_id });
      }

      // Upload patient profile as document on first run (if no documents exist yet)
      const existingDocs = await bbClient.listDocuments(bbState.assistant_id);
      if (existingDocs.length === 0) {
        const profilePath = path.join(__dirname, 'patient_profile.md');
        if (fs.existsSync(profilePath)) {
          console.log('[backboard] Uploading patient profile document...');
          const profileBuf = fs.readFileSync(profilePath);
          const doc = await bbClient.uploadDocument(bbState.assistant_id, 'patient_profile.md', profileBuf);
          console.log(`[backboard] Patient profile uploaded: ${doc.document_id || doc.id}`);
        }
      }

      // Fetch existing memories for context
      const memories = await bbClient.listMemories(bbState.assistant_id);
      if (memories.length > 0) {
        console.log(`[backboard] Loaded ${memories.length} memories from past sessions`);
      }
    } catch (err) {
      console.error('[backboard] Bootstrap failed (continuing without memory):', err.message);
    }
  })();

  // Pre-generate greeting after Backboard is ready (runs during ringing)
  const greetingReady = backboardReady.then(() => prepareGreeting()).catch((err) => {
    console.warn(`[greeting] Prepare failed, using fallback: ${err.message}`);
    return { text: GREETING_FALLBACK, pcmAudio: null };
  });

  // Pre-warm TTS cache in parallel with Backboard bootstrap + room setup
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

  room.on(RoomEvent.ParticipantDisconnected, async (participant) => {
    console.log(`[room] Participant disconnected: ${participant.identity}`);
    if (participant.identity === 'phone-user') {
      console.log('[agent] Phone user hung up. Running post-call analysis...');

      const report = tracker.getSessionReport();

      if (report.exchanges === 0 && report.messages.length === 0) {
        console.log(`${C.DIM}  No exchanges — skipping summary.${C.RESET}`);
        process.exit(0);
      }

      // ── Speechmatics batch analysis (sentiment + summary) ──
      let batchResult = null;
      if (recordedFrames.length > 0) {
        try {
          console.log(`[batch] Preparing audio for batch analysis (${recordedFrames.length} frames)...`);
          const pcmData = Buffer.concat(recordedFrames);
          const wavBuffer = createWavBuffer(pcmData);
          console.log(`[batch] WAV buffer: ${(wavBuffer.length / 1024 / 1024).toFixed(1)}MB, submitting...`);
          const jobId = await submitBatchAnalysis(wavBuffer);
          console.log(`[batch] Job submitted: ${jobId}, polling...`);
          batchResult = await pollBatchJob(jobId);
          console.log('[batch] Batch analysis complete.');
        } catch (err) {
          console.error('[batch] Batch analysis failed:', err.message);
        }
      }

      // ── Generate caretaker summary via Backboard ──
      let caretakerSummary = null;
      if (bbState?.assistant_id && backboardThreadId) {
        try {
          console.log(`${C.CYAN}[summary] Generating caretaker summary...${C.RESET}`);
          const bbClient = new BackboardClient(BACKBOARD_API_KEY);

          // Create a thread for the summary
          const summaryThread = await bbClient.createThread(bbState.assistant_id);
          const summaryTid = summaryThread.thread_id || summaryThread.id;

          // Build transcript
          const transcript = report.messages.map(m =>
            `[${m.elapsed_s.toFixed(0)}s] ${m.speaker}: ${m.text} [${m.sentiment}]`
          ).join('\n');

          const summaryPrompt = [
            'Generate a brief caretaker summary about this conversation with the patient.',
            `Date: ${report.day}, ${report.date} at ${report.time}`,
            `Duration: ${report.duration_s.toFixed(0)} seconds`,
            `Overall sentiment: ${report.overall_sentiment}`,
            '',
            `Conversation:\n${transcript}`,
            '',
            'Include: 1) Overall mood 2) Topics discussed 3) Any concerns 4) Recommendations for the caretaker',
          ].join('\n');

          const summaryRes = await bbClient.addMessage({
            threadId: summaryTid,
            content: summaryPrompt,
            send_to_llm: true,
            stream: false,
            memory: 'Auto',
          });

          caretakerSummary = summaryRes.content || summaryRes.message?.content || summaryRes.text || 'Could not generate summary';

          // Save summary to Backboard for next-session memory
          const summaryText = `Session on ${report.day}, ${report.date} at ${report.time}. Duration: ${report.duration_s.toFixed(0)}s. Overall sentiment: ${report.overall_sentiment}. Caretaker summary: ${caretakerSummary}`;
          const memoryThread = await bbClient.createThread(bbState.assistant_id);
          await bbClient.addMessage({
            threadId: memoryThread.thread_id || memoryThread.id,
            content: summaryText,
            send_to_llm: false,
            memory: 'Auto',
          });
          console.log('[summary] Summary saved to Backboard memory.');
        } catch (err) {
          console.error('[summary] Caretaker summary failed:', err.message);
        }
      }

      // ── Push events to caretaker API ──
      if (caretakerStore) {
        try {
          // Mood event
          await caretakerStore.addCaretakerEvent({
            type: 'mood',
            data: { mood: report.overall_sentiment, severity: report.overall_sentiment === 'CRITICAL' ? 5 : report.overall_sentiment === 'negative' ? 3 : 1 },
            tags: ['voice-agent', 'auto-detected'],
          });

          // Session note
          const noteText = [
            caretakerSummary || '',
            batchResult?.summary ? `\nSpeechmatics summary: ${JSON.stringify(batchResult.summary)}` : '',
          ].filter(Boolean).join('\n');

          if (noteText) {
            await caretakerStore.addCaretakerEvent({
              type: 'note',
              text: noteText,
              tags: ['voice-agent', 'session-summary'],
            });
          }
          console.log('[caretaker] Events pushed successfully.');
        } catch (err) {
          console.error('[caretaker] Event push failed:', err.message);
        }
      }

      // ── Print session summary ──
      tracker.printSummary(caretakerSummary);

      if (batchResult) {
        console.log(`\n  ${C.BOLD}Speechmatics Batch Analysis:${C.RESET}`);
        if (batchResult.sentiment_analysis) {
          console.log(`  Sentiment segments: ${JSON.stringify(batchResult.sentiment_analysis).slice(0, 200)}...`);
        }
        if (batchResult.summary) {
          console.log(`  Summary: ${JSON.stringify(batchResult.summary).slice(0, 300)}`);
        }
      }

      console.log(`\n${C.GREEN}Session complete.${C.RESET}`);
      process.exit(0);
    }
  });

  // Promise that resolves when the SIP call is answered
  let callAnsweredResolve;
  const callAnswered = new Promise(r => { callAnsweredResolve = r; });

  // 3. When phone user's audio arrives, wire up the real STT → Backboard → TTS pipeline
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

        // Record audio for post-call batch analysis
        recordedFrames.push(Buffer.from(frame.data));

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

    // Play greeting AFTER call is answered — greeting was pre-generated during ringing
    console.log('[agent] Waiting for SIP call to be answered before greeting...');
    await callAnswered;
    await new Promise(r => setTimeout(r, 300));
    const greeting = await greetingReady;
    await playGreeting(player, greeting);
  });

  await room.connect(LIVEKIT_URL, agentToken, { autoSubscribe: true });
  console.log(`[agent] Connected to room as "ai-agent"`);

  // Publish the agent audio track
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(agentTrack, publishOptions);
  console.log(`[agent] Audio track published as MICROPHONE source`);

  // Don't wait for TTS cache — dial immediately, cache warms in background
  // Cache hits will be available by the time greeting plays
  cacheWarmup.catch(() => {}); // suppress unhandled rejection

  // 4. Dial the phone number (agent is already in the room waiting)
  console.log(`[sip] Dialing ${PHONE_NUMBER} via trunk ${SIP_TRUNK_ID}...`);
  const sipClient = new SipClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  try {
    const sipParticipant = await sipClient.createSipParticipant(
      SIP_TRUNK_ID,
      PHONE_NUMBER,
      ROOM_NAME,
      {
        participantIdentity: 'phone-user',
        participantName: 'Phone User',
        playDialtone: true,
        waitUntilAnswered: true,
      },
    );

    console.log(`[sip] Call answered! SIP participant:`, sipParticipant.participantIdentity);

    // Signal that the call is answered — greeting can now play
    callAnsweredResolve();
  } catch (err) {
    console.error(`[sip] Call failed (not answered or rejected):`, err.message);
    process.exit(1);
  }

  // Keep alive — ignore SIGINT while post-call analysis is running
  let isShuttingDown = false;
  console.log('[agent] Agent is running. Press Ctrl+C to exit.');
  process.on('SIGINT', async () => {
    if (isShuttingDown) {
      console.log('\n[agent] Force exit.');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log('\n[agent] Shutting down (press Ctrl+C again to force)...');
    await room.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
