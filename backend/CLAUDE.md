# AI Counsellor Voice Agent

## What This Is
A real-time voice AI counsellor with two calling backends:
1. **Twilio pipeline** (`index.js`) — WebSocket media stream, mulaw audio
2. **LiveKit pipeline** (`livekit-agent.js`) — LiveKit Cloud + SIP trunk, PCM audio

Both use Speechmatics STT, Claude (streaming), and Speechmatics TTS with the same low-latency sentence-by-sentence design. Includes a browser test harness (`/test.html`) for zero-cost local testing via the Twilio pipeline.

## Architecture

### Twilio Pipeline (index.js)
```
Phone call → Twilio → WebSocket (/media-stream) → Server
                                                     ├─ mulaw audio → Speechmatics STT (mulaw, 8kHz)
                                                     ├─ transcript text → Claude (streaming)
                                                     └─ response text → Speechmatics TTS (PCM 16kHz) → mulaw 8kHz → Twilio → Phone
```

### LiveKit Pipeline (livekit-agent.js)
```
Agent creates LiveKit room → dials phone via SIP trunk
Phone user joins room → AudioStream (PCM 16kHz) → Speechmatics STT (pcm_s16le, 16kHz)
                                                  → 0.7s silence timeout → Claude (streaming)
                                                  → Speechmatics TTS (PCM 16kHz) → AudioSource → LiveKit → Phone
```

Key difference: LiveKit uses PCM throughout (no mulaw conversion needed). The agent's `AudioSource` runs at 16kHz to match TTS output directly.

Browser test harness uses the Twilio WebSocket path, speaking the exact Twilio protocol (connected → start → media → stop).

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, Twilio WebSocket handler, voice pipeline (streaming TTS per sentence) |
| `livekit-agent.js` | Standalone LiveKit agent — dials phone via SIP, real STT/Claude/TTS pipeline |
| `counsellor.js` | Claude system prompt, `generateResponse` / `generateResponseStreaming` |
| `session.js` | In-memory session store, Firestore transcript persistence |
| `speechmatics.js` | STT client (real-time WebSocket), TTS (REST), `pcm16kToMulaw8k` conversion |
| `whatsapp.js` | WhatsApp messaging via Twilio |
| `public/test.html` | Browser test harness — self-contained HTML+CSS+JS |
| `public/audio-processor.js` | AudioWorklet — mic capture, 48kHz→8kHz resample, mulaw encode |

## Audio Formats

### Twilio pipeline
- **Twilio sends/receives**: mulaw (G.711 u-law), 8kHz, mono, 160-byte chunks (20ms)
- **Speechmatics STT**: mulaw, 8kHz
- **Speechmatics TTS**: PCM 16-bit signed LE, 16kHz → downsampled to mulaw 8kHz by `pcm16kToMulaw8k`
- **Mulaw codec**: Must match the `alawmulaw` npm package exactly

### LiveKit pipeline
- **LiveKit AudioStream**: PCM 16-bit, 16kHz, mono (configured via `new AudioStream(track, 16000, 1)`)
- **Speechmatics STT**: `pcm_s16le`, 16kHz (connected via `connectSTTForLiveKit`)
- **Speechmatics TTS**: PCM 16-bit signed LE, 16kHz → sent directly as `AudioFrame`s to LiveKit
- **Agent AudioSource**: 16kHz, 1 channel — matches TTS output, no resampling needed

## Voice Pipeline — Low Latency Design
1. User stops speaking → **0.7s silence timeout** triggers response (not relying on Speechmatics EndOfUtterance)
2. Claude streams response via `generateResponseStreaming`
3. As each sentence completes (splits on `.` `!` `?`), it's immediately sent to TTS
4. TTS audio is sent while Claude is still generating the next sentence
5. `partialUtterance` tracks tentative STT text separately from confirmed `currentUtterance` (finals only)
6. `isProcessing` guard prevents concurrent responses

## Environment Variables (`.env`)
```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
CLAUDE_API_KEY=sk-ant-...
SPEECHMATICS_API_KEY=...
NGROK_AUTHTOKEN=...

# LiveKit (for livekit-agent.js)
LIVEKIT_URL=wss://xxx.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
SIP_TRUNK_ID=...
```

## Running
```bash
# Terminal 1: ngrok tunnel (must match publicUrl in index.js)
ngrok http 3000

# Terminal 2: server (Twilio pipeline)
node index.js

# Browser test (no Twilio cost):
# Open http://localhost:3000/test.html

# Twilio call:
curl -X POST http://localhost:3000/api/call \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+33...", "contactName": "...", "relationship": "..."}'

# LiveKit call (standalone agent, no Express server needed):
node livekit-agent.js +33XXXXXXXXX

# LiveKit call via API (spawns livekit-agent.js as child process):
curl -X POST http://localhost:3000/api/livekit-call \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+33..."}'
```

## Important Patterns

- **Session cleanup is idempotent**: `destroySession` checks `if (!session) return` — safe to call multiple times
- **Test calls use `TEST-` prefix** on callSid for Firestore distinction
- **Transcript events** (`{event: 'transcript', ...}`) are sent over WebSocket — Twilio silently ignores unknown event types, browser test page renders them
- **Mic gate in test.html**: Doesn't send audio until greeting mark event + 1s delay, preventing echo from triggering false STT
- **Silence timeout** (not EndOfUtterance) triggers response — EndOfUtterance doesn't reliably fire with browser audio streams
- **LiveKit greeting timing**: Greeting plays after `TrackSubscribed` (phone answered), not on room connect (still ringing)
- **LiveKit unique rooms**: Each call creates `call-${Date.now()}` to avoid room conflicts

## Common Issues
- **Model not found (404)**: Check model ID in `counsellor.js` — use `claude-haiku-4-5` or `claude-sonnet-4-6` (no date suffix)
- **No response after speaking**: Check server logs for `[stt] Final:` lines. If none appear, audio isn't reaching STT. If finals appear but no silence timeout, the 0.7s pause wasn't detected
- **Garbled audio in test harness**: The mulaw encode/decode must match the `alawmulaw` npm package exactly — uses `ENCODE_TABLE` (256-entry) for encode and `decodeTable[exp] + (mant << (exp+3))` for decode
- **ngrok URL mismatch**: The `publicUrl` in `index.js` must match the running ngrok tunnel
- **LiveKit agent responds during ringing**: Should not happen now — pipeline only starts on `TrackSubscribed` (after answer). If it does, check that `createSipParticipant` has `playDialtone: true`
- **LiveKit STT format mismatch**: LiveKit agent uses `pcm_s16le` at 16kHz (not mulaw). If STT returns garbage, verify `connectSTTForLiveKit` config
