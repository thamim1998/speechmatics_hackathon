# Dementia Voice Agent — Backend

## What This Is
Node.js Express backend that:
1. Creates LiveKit SIP calls (outbound phone dialing)
2. Manages Backboard memory/threads for the caretaker portal
3. Serves caretaker API endpoints (timeline, events, analytics, transcripts)

The Python agent (`demo/livekit_agent.py`) handles the actual voice conversation — LiveKit Cloud dispatches it automatically when a SIP participant joins a room.

## Architecture

```
Frontend (React :5173)
  └─ /api/call → Backend (Express :3000)
                   └─ LiveKit SipClient → creates SIP participant → LiveKit Cloud
                                           └─ dispatches Python agent
                                               └─ Speechmatics STT/TTS + Backboard LLM
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server — `/api/call` (LiveKit SIP), mounts caretaker routes |
| `routes/caretaker.js` | Caretaker API — events, timeline, analytics, transcripts |
| `backboard/bootstrap.js` | Creates/loads shared Backboard assistant + thread |
| `backboard/client.js` | Backboard HTTP client (messages, threads, documents) |
| `backboard/caretakerStore.js` | CaretakerStore — add events, get timeline |
| `backboard/analytics.js` | Summarize timeline into analytics |
| `backboard/state.js` | Persist Backboard IDs to `data/backboard.json` |
| `backboard/profileState.js` | Patient profile state management |
| `backboard/patientDocument.js` | Build patient profile document for Backboard |

## Environment Variables (from root `../.env`)

```
BACKBOARD_API_KEY=...
BACKBOARD_ASSISTANT_ID=...   # shared with Python agent
BACKBOARD_THREAD_ID=...      # shared with Python agent (optional, bootstrap creates)
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
SIP_TRUNK_ID=ST_...          # from LiveKit SIP trunk setup
CARETAKER_PHONE=+33...       # caretaker WhatsApp number
```

## Running

```bash
# Install deps
npm install

# Start (reads ../.env)
node index.js

# Dev mode with auto-reload
npm run dev
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/call` | Initiate outbound phone call via LiveKit SIP |
| GET | `/api/caretaker/status` | Health check |
| POST | `/api/caretaker/event` | Add caretaker event (note, sleep, mood, etc.) |
| GET | `/api/caretaker/timeline` | Get all timeline messages |
| GET | `/api/caretaker/transcripts` | Get call session transcripts (from Python agent) |
| GET | `/api/caretaker/analytics/summary` | Analytics summary |
