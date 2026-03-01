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
      encoding: 'mulaw',
      sample_rate: 8000,
    },
  });

  console.log('[stt] Connected to Speechmatics real-time');
}

// ─── TTS (REST API) ─────────────────────────────────────────────

export async function synthesizeSpeech(text, voice = 'sarah', { signal } = {}) {
  const url = `${TTS_BASE_URL}/${voice}?output_format=pcm_16000`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`TTS failed (${response.status}): ${errText}`);
  }

  // Returns raw PCM 16-bit signed LE at 16kHz
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Streaming TTS — returns a ReadableStream of PCM chunks instead of buffering.
 * Used by the LiveKit pipeline for lower time-to-first-audio on cache misses.
 */
export async function synthesizeSpeechStreaming(text, voice = 'sarah', { signal } = {}) {
  const url = `${TTS_BASE_URL}/${voice}?output_format=pcm_16000`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`TTS failed (${response.status}): ${errText}`);
  }

  return response.body; // ReadableStream of PCM chunks
}

// ─── Batch Analysis (Post-Call Sentiment + Summary) ─────────────

const BATCH_BASE_URL = 'https://asr.api.speechmatics.com/v2';

/**
 * Create a WAV buffer from raw PCM data.
 * 44-byte WAV header + PCM payload. No external library needed.
 */
export function createWavBuffer(pcmData, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4); // file size - 8
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);            // sub-chunk size
  buffer.writeUInt16LE(1, 20);             // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, headerSize);

  return buffer;
}

/**
 * Submit audio to Speechmatics batch API for transcription + sentiment + summary.
 * @param {Buffer} wavBuffer - WAV audio buffer
 * @returns {Promise<string>} job ID
 */
export async function submitBatchAnalysis(wavBuffer) {
  const form = new FormData();

  const config = {
    type: 'transcription',
    transcription_config: {
      language: 'en',
      operating_point: 'enhanced',
      diarization: 'speaker',
    },
    sentiment_analysis_config: {},
    summarization_config: {},
  };

  form.set('config', JSON.stringify(config));
  form.set('data_file', new Blob([wavBuffer], { type: 'audio/wav' }), 'recording.wav');

  const res = await fetch(`${BATCH_BASE_URL}/jobs/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SPEECHMATICS_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Batch submit failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Poll a batch job until completion and return the full transcript result.
 * @param {string} jobId
 * @param {number} timeout - max wait in seconds
 * @param {number} interval - poll interval in seconds
 * @returns {Promise<Object>} full transcript JSON (includes sentiment_analysis, summary, etc.)
 */
export async function pollBatchJob(jobId, timeout = 120, interval = 3) {
  const headers = { 'Authorization': `Bearer ${SPEECHMATICS_API_KEY}` };
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const statusRes = await fetch(`${BATCH_BASE_URL}/jobs/${jobId}`, { headers });
    if (!statusRes.ok) {
      throw new Error(`Batch status check failed (${statusRes.status})`);
    }

    const statusData = await statusRes.json();
    const jobStatus = statusData.job?.status;

    if (jobStatus === 'done') {
      // Fetch the full transcript
      const transcriptRes = await fetch(
        `${BATCH_BASE_URL}/jobs/${jobId}/transcript?format=json-v2`,
        { headers },
      );
      if (!transcriptRes.ok) {
        throw new Error(`Batch transcript fetch failed (${transcriptRes.status})`);
      }
      return transcriptRes.json();
    }

    if (jobStatus === 'rejected' || jobStatus === 'deleted') {
      throw new Error(`Batch job ${jobStatus}: ${JSON.stringify(statusData)}`);
    }

    // Wait before polling again
    await new Promise(r => setTimeout(r, interval * 1000));
  }

  throw new Error(`Batch job timed out after ${timeout}s`);
}

// ─── Audio Conversion ───────────────────────────────────────────

export function pcm16kToMulaw8k(pcmBuffer) {
  const sampleCount = pcmBuffer.length / 2;
  const samples16k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples16k[i] = pcmBuffer.readInt16LE(i * 2);
  }

  const downsampledCount = Math.floor(sampleCount / 2);
  const samples8k = new Int16Array(downsampledCount);
  for (let i = 0; i < downsampledCount; i++) {
    samples8k[i] = samples16k[i * 2];
  }

  const mulawBytes = alawmulaw.mulaw.encode(samples8k);
  return Buffer.from(mulawBytes);
}

