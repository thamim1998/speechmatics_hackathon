# AI Counsellor Voice Agent

## What This Is
A real-time voice AI counsellor that takes phone calls via Twilio, transcribes speech with Speechmatics STT, generates empathetic responses with Claude, and speaks them back via Speechmatics TTS. Includes a browser-based test harness (`/test.html`) that bypasses Twilio for zero-cost local testing.

## Architecture

```
Phone call → Twilio → WebSocket (/media-stream) → Server
                                                     ├─ mulaw audio → Speechmatics STT (real-time WebSocket)
                                                     ├─ transcript text → Claude (streaming)
                                                     └─ response text → Speechmatics TTS (REST) → mulaw → Twilio → Phone
```

Browser test harness uses the same WebSocket path, speaking the exact Twilio protocol (connected → start → media → stop).

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, WebSocket handler, voice pipeline (streaming TTS per sentence) |
| `counsellor.js` | Claude system prompt, `generateResponse` / `generateResponseStreaming` |
| `session.js` | In-memory session store, Firestore transcript persistence |
| `speechmatics.js` | STT client (real-time WebSocket), TTS (REST), `pcm16kToMulaw8k` conversion |
| `public/test.html` | Browser test harness — self-contained HTML+CSS+JS |
| `public/audio-processor.js` | AudioWorklet — mic capture, 48kHz→8kHz resample, mulaw encode |

## Audio Format
- **Twilio sends/receives**: mulaw (G.711 μ-law), 8kHz, mono, 160-byte chunks (20ms)
- **Speechmatics STT expects**: mulaw, 8kHz
- **Speechmatics TTS returns**: PCM 16-bit signed LE, 16kHz → downsampled to mulaw 8kHz by `pcm16kToMulaw8k`
- **Mulaw codec**: Must match the `alawmulaw` npm package exactly (encode table + decode table)

## Voice Pipeline — Low Latency Design
1. User stops speaking → **0.7s silence timeout** triggers response (not relying on Speechmatics EndOfUtterance)
2. Claude streams response via `generateResponseStreaming`
3. As each sentence completes (splits on `.` `!` `?`), it's immediately sent to TTS
4. TTS audio is sent to Twilio while Claude is still generating the next sentence
5. `partialUtterance` tracks tentative STT text separately from confirmed `currentUtterance` (finals only)

## Environment Variables (`.env`)
```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
CLAUDE_API_KEY=sk-ant-...
SPEECHMATICS_API_KEY=...
NGROK_AUTHTOKEN=...
```

## Running
```bash
# Terminal 1: ngrok tunnel (must match publicUrl in index.js)
ngrok http 3000

# Terminal 2: server
node index.js

# Browser test (no Twilio cost):
# Open http://localhost:3000/test.html

# Real Twilio call:
curl -X POST http://localhost:3000/api/call \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+33...", "contactName": "...", "relationship": "..."}'
```

## Important Patterns

- **Session cleanup is idempotent**: `destroySession` checks `if (!session) return` — safe to call multiple times
- **Test calls use `TEST-` prefix** on callSid for Firestore distinction
- **Transcript events** (`{event: 'transcript', ...}`) are sent over WebSocket — Twilio silently ignores unknown event types, browser test page renders them
- **Mic gate in test.html**: Doesn't send audio until greeting mark event + 1s delay, preventing echo from triggering false STT
- **Silence timeout** (not EndOfUtterance) triggers response — EndOfUtterance doesn't reliably fire with browser audio streams

## Common Issues
- **Model not found (404)**: Check model ID in `counsellor.js` — use `claude-haiku-4-5` or `claude-sonnet-4-6` (no date suffix)
- **No response after speaking**: Check server logs for `[stt] Final:` lines. If none appear, audio isn't reaching STT. If finals appear but no silence timeout, the 0.7s pause wasn't detected
- **Garbled audio in test harness**: The mulaw encode/decode must match the `alawmulaw` npm package exactly — uses `ENCODE_TABLE` (256-entry) for encode and `decodeTable[exp] + (mant << (exp+3))` for decode
- **ngrok URL mismatch**: The `publicUrl` in `index.js` must match the running ngrok tunnel
