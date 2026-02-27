/**
 * AudioWorklet processor: captures mic audio, resamples to 8kHz,
 * encodes to mulaw, and posts 160-byte (20ms) chunks to the main thread.
 *
 * Mulaw encode matches the alawmulaw npm package used server-side.
 */

// Exponent lookup table — identical to the alawmulaw library.
// Maps (biasedSample >> 7) to the segment exponent (0-7).
const ENCODE_TABLE = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7
];
const BIAS = 0x84; // 132
const CLIP = 32635;

class MulawProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampleRatio = sampleRate / 8000;
    this.resampleOffset = 0;
    this.buffer = new Uint8Array(160);
    this.bufferPos = 0;
  }

  /**
   * Encode a Float32 sample [-1, 1] to 8-bit mulaw.
   * Algorithm mirrors alawmulaw.mulaw.encodeSample exactly.
   */
  static encodeMulaw(floatSample) {
    // Scale float to int16 range
    let sample = Math.round(Math.max(-1, Math.min(1, floatSample)) * 32767);

    // Get sign bit and convert to magnitude
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;

    // Add bias then clip (same order as alawmulaw)
    sample += BIAS;
    if (sample > CLIP) sample = CLIP;

    // Exponent from table, mantissa from shifted sample
    const exponent = ENCODE_TABLE[(sample >> 7) & 0xFF];
    const mantissa = (sample >> (exponent + 3)) & 0x0F;

    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono channel
    const ratio = this.resampleRatio;

    for (let i = 0; i < channelData.length; i++) {
      this.resampleOffset += 1;
      if (this.resampleOffset >= ratio) {
        this.resampleOffset -= ratio;

        this.buffer[this.bufferPos++] = MulawProcessor.encodeMulaw(channelData[i]);

        if (this.bufferPos >= 160) {
          // Post the completed 20ms chunk
          this.port.postMessage(this.buffer.slice());
          this.bufferPos = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('mulaw-processor', MulawProcessor);
