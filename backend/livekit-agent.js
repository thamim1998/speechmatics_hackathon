/**
 * LiveKit Outbound PSTN Calling Agent
 *
 * AI agent dials a real phone number via LiveKit Cloud + Twilio SIP trunk,
 * joins a LiveKit room, and speaks to the user in real time.
 *
 * Pipeline:
 *   LiveKit AudioStream (PCM 16kHz) → Speechmatics STT (real-time)
 *     → 0.7s silence timeout → Claude (streaming)
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
const UTTERANCE_SILENCE_MS = 500; // 0.5s silence triggers response
const AGENT_SAMPLE_RATE = 16000; // matches Speechmatics TTS output

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

// ─── Session State ─────────────────────────────────────────────
let messages = [];           // Claude conversation history [{role, content}]
let currentUtterance = '';   // Confirmed finals accumulated
let partialUtterance = '';   // Latest partial (tentative)
let isProcessing = false;    // Guard against concurrent responses
let utteranceTimer = null;

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

// ─── Audio I/O ─────────────────────────────────────────────────

/**
 * Send PCM 16kHz audio buffer to LiveKit via AudioSource.
 * LiveKit buffers and plays audio at the correct rate internally.
 * No need to wait — captureFrame queues the audio for playback.
 */
async function sendPcmToLiveKit(source, pcmBuffer) {
  const int16Data = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2,
  );

  const frame = new AudioFrame(int16Data, AGENT_SAMPLE_RATE, 1, int16Data.length);
  await source.captureFrame(frame);
}

// ─── Voice Pipeline ────────────────────────────────────────────

async function playGreeting(agentSource) {
  console.log('[pipeline] Playing greeting');
  messages.push({ role: 'assistant', content: GREETING });

  try {
    const pcmAudio = await synthesizeSpeech(GREETING);
    console.log(`[pipeline] Greeting TTS returned ${pcmAudio.length} bytes (${(pcmAudio.length / 2 / AGENT_SAMPLE_RATE).toFixed(1)}s)`);
    await sendPcmToLiveKit(agentSource, pcmAudio);
    console.log('[pipeline] Greeting played');
  } catch (err) {
    console.error('[pipeline] Greeting TTS failed:', err.message);
  }
}

async function handleEndOfUtterance(agentSource) {
  if (isProcessing) return;

  const userText = currentUtterance.trim();
  if (!userText) return;

  isProcessing = true;
  currentUtterance = '';
  partialUtterance = '';

  console.log(`[pipeline] Caller said: "${userText}"`);
  messages.push({ role: 'user', content: userText });

  try {
    // Stream Claude response, TTS each sentence as it completes
    let buffer = '';
    const ttsQueue = [];
    let ttsRunning = false;

    const processTtsQueue = async () => {
      if (ttsRunning) return;
      ttsRunning = true;
      while (ttsQueue.length > 0) {
        const sentence = ttsQueue.shift();
        try {
          console.log(`[pipeline] TTS sentence: "${sentence}"`);
          const pcmAudio = await synthesizeSpeech(sentence);
          await sendPcmToLiveKit(agentSource, pcmAudio);
        } catch (err) {
          console.error('[pipeline] Sentence TTS failed:', err.message);
        }
      }
      ttsRunning = false;
    };

    const enqueueSentence = (sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) return;
      ttsQueue.push(trimmed);
      processTtsQueue();
    };

    const responseText = await generateResponseStreaming(messages, (chunk) => {
      buffer += chunk;
      // Split on sentence boundaries: . ! ? followed by space or end
      const match = buffer.match(/^(.*?[.!?])\s+(.*)$/s);
      if (match) {
        enqueueSentence(match[1]);
        buffer = match[2];
      }
    });

    // Flush remaining text
    if (buffer.trim()) {
      enqueueSentence(buffer);
    }

    // Wait for all TTS to finish
    while (ttsQueue.length > 0 || ttsRunning) {
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[pipeline] Counsellor: "${responseText}"`);
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
        // Reset silence timer — user is still speaking
        if (utteranceTimer) clearTimeout(utteranceTimer);
        utteranceTimer = setTimeout(() => {
          const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
          currentUtterance = fullText;
          partialUtterance = '';
          console.log(`[stt] Silence timeout — triggering response (utterance: "${fullText}")`);
          handleEndOfUtterance(agentSource);
        }, UTTERANCE_SILENCE_MS);
      },
      onFinal: (text) => {
        console.log(`[stt] Final: "${text}"`);
        if (text.trim()) {
          currentUtterance += (currentUtterance ? ' ' : '') + text;
        }
        partialUtterance = '';
        if (utteranceTimer) clearTimeout(utteranceTimer);
        utteranceTimer = setTimeout(() => {
          console.log(`[stt] Silence timeout — triggering response (utterance: "${currentUtterance}")`);
          handleEndOfUtterance(agentSource);
        }, UTTERANCE_SILENCE_MS);
      },
      onEndOfUtterance: () => {
        const fullText = (currentUtterance + ' ' + (partialUtterance || '')).trim();
        currentUtterance = fullText;
        partialUtterance = '';
        console.log(`[stt] EndOfUtterance — utterance: "${fullText}", isProcessing: ${isProcessing}`);
        if (utteranceTimer) clearTimeout(utteranceTimer);
        handleEndOfUtterance(agentSource);
      },
    });

    // Connect STT, then wait for SIP call to be answered before greeting
    await connectSTTForLiveKit(sttClient);
    console.log('[agent] Waiting for SIP call to be answered before greeting...');
    await callAnswered;
    await new Promise(r => setTimeout(r, 300));
    await playGreeting(agentSource);

    // Stream phone audio to Speechmatics STT
    const audioStream = new AudioStream(track, AGENT_SAMPLE_RATE, 1);
    for await (const frame of audioStream) {
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
