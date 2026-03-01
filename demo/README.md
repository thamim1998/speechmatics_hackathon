# Dementia Care Voice Agent

A voice companion for dementia patients powered by **Speechmatics** (STT/TTS), **Backboard** (persistent memory + RAG), and **LiveKit** (real-time voice infrastructure).

The agent acts as "Sarah", a warm and patient companion who checks in on the patient, tracks mood and sentiment, and generates caretaker summaries after each session.

---

## Prerequisites

- **Python** 3.11 or 3.12
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** package manager
- A microphone and speakers (for voice mode)

Install uv if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## API Keys

Create a `.env` file in the **project root** (one level above this `demo/` folder):

```bash
# .env (in project root)

# Speechmatics - for STT and TTS
SPEECHMATICS_API_KEY=your_speechmatics_api_key

# Backboard - for persistent memory, RAG, and LLM routing
BACKBOARD_API_KEY=your_backboard_api_key

# LiveKit - for real-time voice rooms (livekit_agent.py dev mode)
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret

# OpenAI - ONLY needed for pipecat_demo.py (optional)
# OPEN_AI_API_KEY=your_openai_api_key
```

| Key | Required For | Where to Get |
|-----|-------------|--------------|
| `SPEECHMATICS_API_KEY` | All demos | [speechmatics.com](https://www.speechmatics.com/) |
| `BACKBOARD_API_KEY` | All demos | [backboard.io](https://app.backboard.io/) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | `livekit_agent.py dev` mode only | [livekit.io](https://livekit.io/) |
| `OPEN_AI_API_KEY` | `pipecat_demo.py` only (optional) | [platform.openai.com](https://platform.openai.com/) |

**You do NOT need an OpenAI API key** for the LiveKit agent or standalone demo — Backboard handles LLM routing internally.

---

## Quick Start

```bash
cd demo/
uv sync
```

That's it. `uv sync` creates a `.venv`, installs all dependencies (including the local `livekit-plugins-backboard` package), and locks versions.

---

## Running the Demos

### 1. LiveKit Agent (Recommended)

Uses **Speechmatics STT/TTS** + **Backboard LLM plugin** (memory + RAG + LLM routing all handled by Backboard).

```bash
# Local mic/speaker test (no LiveKit server needed)
uv run python livekit_agent.py console

# Connect to LiveKit Cloud (use with LiveKit Playground)
uv run python livekit_agent.py dev

# Reset Backboard assistant and re-upload patient profile
RESET_ASSISTANT=1 uv run python livekit_agent.py console
```

**Stack**: Speechmatics STT -> Backboard LLM (with memory + RAG) -> Speechmatics TTS

### 2. Standalone Demo (No LiveKit)

Direct voice conversation using Speechmatics WebSocket STT + Backboard for LLM + memory.

```bash
# Voice mode (push-to-talk with mic)
uv run python demo.py

# Text-only mode (type messages)
uv run python demo.py --text

# Reset assistant
uv run python demo.py --reset
```

### 3. Pipecat Demo (WebRTC in Browser)

Uses **Pipecat** framework with browser-based WebRTC. Opens at `localhost:7860`.

```bash
uv run python pipecat_demo.py
```

**Note**: This demo uses OpenAI directly for the LLM (not Backboard), but still saves conversation memory to Backboard in the background.

---

## How It Works

### Architecture

```
Patient (mic) -> Speechmatics STT -> Backboard LLM -> Speechmatics TTS -> Patient (speaker)
                                         |
                                    Memory + RAG
                                    (patient profile,
                                     past conversations)
```

### Backboard Plugin (`livekit-plugins-backboard`)

A custom LiveKit Agents plugin that routes LLM calls through [Backboard.io](https://app.backboard.io/). Located in `packages/livekit-plugins-backboard/`.

What Backboard provides:
- **Persistent memory** — remembers details across conversations
- **RAG** — retrieves relevant info from uploaded documents (patient profile)
- **Thread management** — each session gets its own conversation thread
- **LLM routing** — sends requests to OpenAI/other providers via Backboard's API

Usage in code:

```python
from livekit.plugins import backboard

session = AgentSession(
    llm=backboard.LLM(
        assistant_id="your-assistant-id",
        llm_provider="openai",
        model_name="gpt-4o-mini",
        memory="auto",
    ),
    stt=speechmatics.STT(language="en"),
    tts=speechmatics.TTS(voice="sarah"),
)
```

### Sentiment Tracking

Every patient message is analyzed for sentiment in real-time:
- **Positive** — patient is in good spirits
- **Neutral** — normal conversation
- **Negative** — patient seems down
- **Critical** — mentions of falls, pain, self-harm, being lost (triggers caretaker alert)

### Session Reports

After each conversation, the agent:
1. Prints a full session summary with per-message sentiment
2. Shows LLM latency and timing metrics
3. Generates a caretaker summary via Backboard
4. Saves the conversation to Backboard memory for future sessions

---

## Project Structure

```
demo/
├── livekit_agent.py          # LiveKit agent (recommended)
├── demo.py                   # Standalone voice/text demo
├── pipecat_demo.py           # Pipecat WebRTC demo
├── patient_profile.md        # Patient info (uploaded to Backboard)
├── pyproject.toml            # Dependencies
├── uv.lock                   # Locked versions
└── packages/
    └── livekit-plugins-backboard/   # Custom Backboard plugin for LiveKit
        └── livekit/plugins/backboard/
            ├── __init__.py
            ├── llm.py               # LLM + streaming implementation
            ├── session.py           # Thread/session management
            └── version.py
```

---

## Troubleshooting

**`uv: command not found`**
Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`

**`BACKBOARD_API_KEY not found`**
Make sure your `.env` file is in the project root (parent of `demo/`), not inside `demo/`.

**`RESET_ASSISTANT=1` — when to use**
Run with this if you changed `patient_profile.md` and want to re-upload it to Backboard, or if you want a fresh assistant.

**Audio issues**
Make sure your mic/speakers are working. The agent uses `sounddevice` which requires a working audio setup. On Linux you may need `pulseaudio` or `pipewire`.
