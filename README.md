# Dementia Voice Agent

An AI-powered voice companion for dementia patients. The agent (Megan) calls patients, has natural conversations using Speechmatics STT/TTS, remembers everything via Backboard memory, performs real-time sentiment analysis, and alerts caretakers on WhatsApp when critical concerns are detected.

## Quickstart

```bash
# Stop + start (safe to run anytime — kills stale processes first)
./start.sh stop && ./start.sh

# Or just start (auto-kills existing instances)
./start.sh

# Stop all services
./start.sh stop
```

Once running:
- **Patient Portal:** http://localhost:5173
- **Caretaker Portal:** http://localhost:5173/?portal=caretaker
- **Backend API:** http://localhost:3000

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CARETAKER PORTAL                                │
│                  http://localhost:5173/?portal=caretaker                 │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐ │
│  │ Add Note │  │Call Patient│ │ Timeline │  │ Analytics │  │Download │ │
│  │ /Event   │  │  Button   │  │  View    │  │  Charts   │  │  PDF    │ │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └─────┬─────┘  └────┬────┘ │
└───────┼──────────────┼──────────────┼──────────────┼──────────────┼──────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     NODE.JS BACKEND (Express :3000)                      │
│                                                                         │
│  POST /api/caretaker/event  ──→  Backboard (memory: "Auto")            │
│  POST /api/call             ──→  LiveKit SipClient                      │
│  GET  /api/caretaker/timeline                                           │
│  GET  /api/caretaker/memories                                           │
│  GET  /api/caretaker/transcripts                                        │
│  GET  /api/caretaker/analytics/summary                                  │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               │  SipClient.createSipParticipant()
               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LIVEKIT CLOUD                                    │
│                  wss://hackathon-dwcw1rtk.livekit.cloud                 │
│                                                                         │
│  1. Creates a room                                                      │
│  2. Dials patient phone via SIP trunk                                   │
│  3. Auto-dispatches Python agent to the room                            │
└───────┬─────────────────────────────────┬───────────────────────────────┘
        │                                 │
        ▼                                 ▼
┌───────────────────┐     ┌───────────────────────────────────────────────┐
│  TWILIO SIP TRUNK │     │           PYTHON AGENT (Megan)                │
│                   │     │                                               │
│  Outbound calls   │     │  Speechmatics STT ──→ Backboard LLM          │
│  via PSTN to      │◄───►│  (speech-to-text)     (memory + GPT-4o-mini) │
│  patient's phone  │     │                            │                  │
│                   │     │  Speechmatics TTS ◄────────┘                  │
│  +12282408374     │     │  (text-to-speech, voice: "megan")             │
│  (caller ID)      │     │                                               │
└───────────────────┘     │  Real-time sentiment analysis:                │
                          │    positive / neutral / negative / CRITICAL   │
        ┌─────────────────│                                               │
        │                 │  On CRITICAL → WhatsApp alert to caretaker    │
        │                 │  On hang-up  → Summary saved to Backboard     │
        │                 └───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐     ┌───────────────────────────────────────────────┐
│  TWILIO WHATSAPP  │     │              BACKBOARD.IO                     │
│  Sandbox          │     │        (Memory + LLM + RAG)                   │
│                   │     │                                               │
│  Sends critical   │     │  Assistant: stores patient profile + memories │
│  alerts to        │     │  Thread: timeline of events + call sessions   │
│  caretaker phone  │     │  Documents: patient profile (stable facts)    │
│  +330768975661    │     │  Memories: auto-extracted facts from convos   │
│                   │     │                                               │
└───────────────────┘     └───────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     PATIENT'S MOBILE PHONE                              │
│                       +917202849884                                      │
│                                                                         │
│  Receives call → Talks to Megan → Conversation recorded + analyzed      │
│  Megan remembers past conversations, asks about their day,              │
│  checks on meals/medication, and alerts caretaker if concerned          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Demo Flow

1. **Caretaker adds context** — Opens caretaker portal, adds a note (e.g., "Patient drank water and received a gift of an orange glass today")
2. **Caretaker initiates call** — Clicks "Call Patient", enters phone number, call goes through LiveKit → Twilio → patient's phone rings
3. **Megan talks to patient** — Uses Speechmatics STT/TTS + Backboard memory. Knows about the orange glass because the note was saved to memory
4. **Real-time sentiment analysis** — Every utterance is analyzed. Terminal shows colored sentiment badges
5. **CRITICAL alert** — If patient says "I fell down" or "I'm in pain", agent sends WhatsApp alert to caretaker immediately
6. **Post-call summary** — When call ends, agent generates a caretaker summary via Backboard LLM and saves it to the shared thread
7. **Caretaker reviews** — Refreshes portal to see call session in timeline, updated analytics charts, new patient memories
8. **PDF download** — Clicks "Download Transcripts" for a formatted PDF report with sentiment data

## Backboard Utilities

Manage Backboard memory, threads, and documents from the CLI:

```bash
cd demo

# List what the agent knows
uv run python backboard_utils.py memories list
uv run python backboard_utils.py threads list
uv run python backboard_utils.py documents list

# Count everything
uv run python backboard_utils.py all count

# Delete specific items
uv run python backboard_utils.py memories delete <id>
uv run python backboard_utils.py threads delete <id>
uv run python backboard_utils.py documents delete <id>

# Wipe all memories (with confirmation)
uv run python backboard_utils.py memories wipe

# Wipe everything (memories + threads + documents)
uv run python backboard_utils.py all wipe

# Full reset — new assistant, re-upload patient profile, clean slate
uv run python backboard_utils.py reset
```

## Project Structure

```
speechmatics_hackathon/
├── start.sh                 # Start/stop all services
├── .env                     # Single source of truth for all keys
├── demo/
│   ├── livekit_agent.py     # Python voice agent (Megan)
│   ├── patient_profile.md   # Patient info (uploaded to Backboard)
│   └── backboard_utils.py   # CLI tool for managing Backboard data
├── backend/
│   ├── index.js             # Express server + LiveKit SIP calling
│   ├── routes/caretaker.js  # Caretaker API endpoints
│   └── backboard/           # Backboard client, store, analytics
├── frontend/
│   └── src/
│       ├── App.tsx           # Patient portal
│       └── features/caretaker/
│           ├── CaretakerPortal.tsx  # Caretaker portal UI
│           └── api/caretakerApi.ts  # API client
└── updates/                  # Change logs
```

## Environment Variables

All services read from the root `.env` file:

| Variable | Used By | Purpose |
|----------|---------|---------|
| `BACKBOARD_API_KEY` | Agent + Backend | Backboard authentication |
| `BACKBOARD_ASSISTANT_ID` | Agent + Backend | Shared memory assistant |
| `BACKBOARD_THREAD_ID` | Agent + Backend | Shared timeline thread |
| `SPEECHMATICS_API_KEY` | Agent | STT + TTS |
| `LIVEKIT_URL` | Agent + Backend | LiveKit Cloud endpoint |
| `LIVEKIT_API_KEY` | Agent + Backend | LiveKit auth |
| `LIVEKIT_API_SECRET` | Agent + Backend | LiveKit auth |
| `SIP_TRUNK_ID` | Backend | LiveKit outbound SIP trunk |
| `SIP_FROM_NUMBER` | Backend | Caller ID for outbound calls |
| `OPENAI_API_KEY` | Backboard | LLM routing (GPT-4o-mini) |
| `TWILIO_ACCOUNT_SID` | Agent | WhatsApp alerts |
| `TWILIO_AUTH_TOKEN` | Agent | WhatsApp alerts |
| `TWILIO_WHATSAPP_FROM` | Agent | Twilio sandbox number |
| `CARETAKER_PHONE` | Agent | Caretaker WhatsApp number |

## Tech Stack

- **Voice AI:** Speechmatics (STT + TTS)
- **Memory & LLM:** Backboard.io (RAG + GPT-4o-mini)
- **Real-time:** LiveKit Cloud (WebRTC rooms + SIP)
- **Telephony:** Twilio (SIP trunk + WhatsApp sandbox)
- **Backend:** Node.js + Express
- **Frontend:** React 19 + TypeScript + Vite + Recharts
- **Agent:** Python + LiveKit Agents SDK + Silero VAD

## Team

Built at Speechmatics Hackathon 2026 by Abhishek, Thamim, and Ayush.
