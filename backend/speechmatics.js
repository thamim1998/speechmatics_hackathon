import { RealtimeClient } from '@speechmatics/real-time-client';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import alawmulaw from 'alawmulaw';

const SPEECHMATICS_API_KEY = process.env.SPEECHMATICS_API_KEY;
const TTS_BASE_URL = 'https://preview.tts.speechmatics.com/generate';

// ─── STT (Real-time WebSocket) ──────────────────────────────────

export function createSTTClient({ onPartial, onFinal, onEndOfUtterance }) {
  const client = new RealtimeClient();

  client.addEventListener('receiveMessage', ({ data }) => {
    switch (data.message) {
      case 'AddPartialTranscript': {
        const text = data.metadata?.transcript || data.results?.map(r => r.alternatives?.[0]?.content).join(' ') || '';
        if (text && onPartial) onPartial(text);
        break;
      }
      case 'AddTranscript': {
        const text = data.metadata?.transcript || data.results?.map(r => r.alternatives?.[0]?.content).join(' ') || '';
        if (text && onFinal) onFinal(text);
        break;
      }
      case 'EndOfUtterance': {
        if (onEndOfUtterance) onEndOfUtterance();
        break;
      }
    }
  });

  client.addEventListener('receiveError', ({ data }) => {
    console.error('[stt] Error:', data);
  });

  return client;
}

export async function connectSTT(client) {
  const jwt = await createSpeechmaticsJWT({
    type: 'rt',
    apiKey: SPEECHMATICS_API_KEY,
    ttl: 300, // 5 minutes
  });

  await client.start(jwt, {
    transcription_config: {
      language: 'en',
      enable_partials: true,
      max_delay: 2,
    },
    audio_format: {
      type: 'raw',
      encoding: 'mulaw',
      sample_rate: 8000,
    },
  });

  console.log('[stt] Connected to Speechmatics real-time');
}

// ─── TTS (REST API) ─────────────────────────────────────────────

export async function synthesizeSpeech(text, voice = 'sarah') {
  const url = `${TTS_BASE_URL}/${voice}?output_format=pcm_16000`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`TTS failed (${response.status}): ${errText}`);
  }

  // Returns raw PCM 16-bit signed LE at 16kHz
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Audio Conversion ───────────────────────────────────────────

export function pcm16kToMulaw8k(pcmBuffer) {
  // Read PCM 16-bit signed LE samples
  const sampleCount = pcmBuffer.length / 2;
  const samples16k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples16k[i] = pcmBuffer.readInt16LE(i * 2);
  }

  // Downsample 16kHz → 8kHz (take every other sample)
  const downsampledCount = Math.floor(sampleCount / 2);
  const samples8k = new Int16Array(downsampledCount);
  for (let i = 0; i < downsampledCount; i++) {
    samples8k[i] = samples16k[i * 2];
  }

  // Encode to mulaw
  const mulawBytes = alawmulaw.mulaw.encode(samples8k);
  return Buffer.from(mulawBytes);
}
