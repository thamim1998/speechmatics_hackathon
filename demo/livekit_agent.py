#!/usr/bin/env python3
"""
Dementia Care Voice Agent (LiveKit)
Speechmatics STT/TTS + Backboard Memory + OpenAI GPT-4o-mini

Usage:
  uv run python livekit_agent.py console        # Local mic/speaker test
  uv run python livekit_agent.py dev             # LiveKit Cloud + playground
  RESET_ASSISTANT=1 uv run python livekit_agent.py console   # Reset memory
"""

import os
import time
from datetime import datetime
from pathlib import Path

import aiohttp
import requests
from dotenv import load_dotenv
from loguru import logger

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

SPEECHMATICS_API_KEY = os.getenv("SPEECHMATICS_API_KEY")
BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY")
BACKBOARD_URL = "https://app.backboard.io/api"

# Twilio WhatsApp (for CRITICAL alerts)
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")  # Twilio sandbox
CARETAKER_PHONE = os.getenv("CARETAKER_PHONE")

# LiveKit env vars are read automatically by the SDK:
# LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET

ASSISTANT_FILE = Path(__file__).parent / ".livekit_assistant_id"
PATIENT_PROFILE_PATH = Path(__file__).parent / "patient_profile.md"


def send_whatsapp_alert(patient_text, sentiment_confidence):
    """Send a WhatsApp CRITICAL alert to the caretaker via Twilio.
    Uses Appointment Reminders template: {{1}} = date, {{2}} = time.
    We repurpose: {{1}} = "CRITICAL ALERT - check patient", {{2}} = what patient said.
    """
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CARETAKER_PHONE]):
        logger.warning("Twilio WhatsApp not configured — skipping alert")
        return
    try:
        import json as _json
        to = f"whatsapp:{CARETAKER_PHONE}"
        url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
        auth = (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        content_sid = os.getenv("TWILIO_CONTENT_SID", "HXb5b62575e6e4ff6129ad7c8efe1f983e")

        # Clean the patient text — no emojis, no newlines, short
        clean_text = patient_text.replace("\n", " ").strip()[:60]

        resp = requests.post(url, auth=auth, data={
            "From": TWILIO_WHATSAPP_FROM,
            "To": to,
            "ContentSid": content_sid,
            "ContentVariables": _json.dumps({
                "1": "CRITICAL ALERT - check on patient now",
                "2": clean_text,
            }),
        })

        result = resp.json()
        status = result.get("status", "unknown")
        sid = result.get("sid", "")
        error_code = result.get("error_code")
        error_msg = result.get("error_message", "")

        if resp.ok:
            logger.info(f"WhatsApp alert SENT — SID: {sid}, status: {status}, to: {CARETAKER_PHONE}")
        else:
            logger.error(f"WhatsApp alert failed: {resp.status_code} — {error_code}: {error_msg}")
            # Log full response for debugging
            logger.error(f"Response: {result}")
    except Exception as e:
        logger.error(f"WhatsApp alert error: {e}")

SYSTEM_PROMPT = """You are Megan, a warm, patient, and caring voice companion for a person living with dementia.

PERSONALITY:
- Warm, gentle, encouraging — like a trusted friend
- Speak in short, simple sentences (this is a voice call)
- Keep responses to 2-3 sentences max
- Celebrate small things: "That sounds lovely!"
- Never clinical, robotic, or condescending
- Use gentle humor when appropriate

COMMUNICATION RULES:
- Address the person by their first name (from the context provided below)
- Ask ONE question at a time
- Give them time to respond — be patient with pauses
- If they repeat themselves, respond patiently as if hearing it the first time
- NEVER say "you already told me" or "don't you remember"
- Validate their emotions: "That sounds frustrating" / "I understand"
- If they're confused, gently redirect without correcting
- Use yes/no or simple-choice questions when possible
- Never quiz or test them — keep everything as casual conversation

CONVERSATION GOALS:
- Check how they're feeling (mood, physical comfort)
- Ask about their day naturally
- Gently check on meals, hydration, medication
- Engage with any memories or stories they share
- Provide companionship and reduce feelings of isolation
- Focus on what they CAN do, not what they've lost

ALERTS:
If the person mentions falls, severe pain, feeling lost, wanting to hurt themselves, not eating/drinking, or being very confused — calmly reassure them and say you will let their caretaker know right away.

Remember: You are their companion, not their nurse. Keep it warm and natural. The patient's profile, key people, preferences, and any memories from past conversations are provided below.
"""

from livekit.plugins.speechmatics.stt import AdditionalVocabEntry

CUSTOM_VOCAB = [
    AdditionalVocabEntry(content="Abhishek", sounds_like=["ab-hee-shek", "ab-ee-shek"]),
    AdditionalVocabEntry(content="Ayush", sounds_like=["aaah-yuuoosh", "aaaayoush"]),
    AdditionalVocabEntry(content="Thamimul", sounds_like=["tah-mee-mul", "tamimul"]),
    AdditionalVocabEntry(content="Creteil", sounds_like=["kret-eye", "cret-ay"]),
]


# ── Terminal Colors ─────────────────────────────────────────────────────────

class C:
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"
    BG_RED = "\033[41m"
    WHITE = "\033[97m"


# ── Sentiment ───────────────────────────────────────────────────────────────

CRITICAL_WORDS = [
    "fall", "fell", "hurt myself", "emergency", "help me", "can't breathe",
    "chest pain", "blood", "bleeding", "die", "dying", "kill", "suicide",
    "lost", "don't know where",
]
NEGATIVE_WORDS = [
    "sad", "hurt", "pain", "angry", "frustrated", "confused", "scared",
    "afraid", "worried", "anxious", "lonely", "tired", "bad", "terrible",
    "depressed", "cry", "crying", "sick", "dizzy", "weak", "forget", "forgot",
    "upset", "unhappy", "miss", "missing", "headache", "ache",
]
POSITIVE_WORDS = [
    "happy", "good", "great", "wonderful", "nice", "love", "enjoy",
    "beautiful", "fun", "laugh", "smile", "better", "fine", "well",
    "amazing", "pleased", "grateful", "thankful", "excited",
    "delicious", "lovely", "calm", "relaxed", "comfortable",
]


def analyze_sentiment(text):
    text_lower = text.lower()
    crit = sum(1 for w in CRITICAL_WORDS if w in text_lower)
    if crit > 0:
        return "CRITICAL", min(0.7 + crit * 0.1, 0.99)
    neg = sum(1 for w in NEGATIVE_WORDS if w in text_lower)
    pos = sum(1 for w in POSITIVE_WORDS if w in text_lower)
    if neg > pos:
        return "negative", min(0.4 + neg * 0.1, 0.95)
    elif pos > neg:
        return "positive", min(0.4 + pos * 0.1, 0.95)
    return "neutral", 0.5


def sentiment_badge(sentiment, confidence):
    if sentiment == "CRITICAL":
        return f"{C.BG_RED}{C.WHITE}{C.BOLD} !! CRITICAL ({confidence:.0%}) !! {C.RESET}"
    elif sentiment == "negative":
        return f"{C.RED}[NEGATIVE {confidence:.0%}]{C.RESET}"
    elif sentiment == "positive":
        return f"{C.GREEN}[POSITIVE {confidence:.0%}]{C.RESET}"
    return f"{C.YELLOW}[NEUTRAL {confidence:.0%}]{C.RESET}"


def fmt_time(seconds):
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


# ── Session Tracker ─────────────────────────────────────────────────────────

class SessionTracker:
    """Tracks conversation metadata, sentiment, timing for post-session reports."""

    def __init__(self):
        self.start_time = time.time()
        self.start_datetime = datetime.now()
        self.messages = []
        self.exchange_times = []
        self._llm_start = None
        self._llm_first_token = None

    def log_user_message(self, text):
        elapsed = time.time() - self.start_time
        sentiment, confidence = analyze_sentiment(text)
        if sentiment == "CRITICAL":
            badge = f"\033[41m\033[97m\033[1m !! CRITICAL {confidence:.0%} !! \033[0m"
        elif sentiment == "negative":
            badge = f"\033[91m[NEGATIVE {confidence:.0%}]\033[0m"
        elif sentiment == "positive":
            badge = f"\033[92m[POSITIVE {confidence:.0%}]\033[0m"
        else:
            badge = f"\033[93m[NEUTRAL {confidence:.0%}]\033[0m"
        logger.opt(colors=True).info(f"[{fmt_time(elapsed)}] \033[96m🗣️ Patient:\033[0m {text}  {badge}")

        self.messages.append({
            "timestamp": datetime.now().isoformat(),
            "elapsed_s": round(elapsed, 1),
            "speaker": "patient",
            "text": text,
            "sentiment": sentiment,
            "confidence": round(confidence, 2),
        })

        if sentiment == "CRITICAL":
            logger.opt(colors=True).warning(f"\033[41m\033[97m\033[1m !! CRITICAL CONCERN — NOTIFYING CARETAKER !! \033[0m")
            send_whatsapp_alert(text, confidence)

    def llm_start(self):
        self._llm_start = time.time()
        self._llm_first_token = None

    def llm_first_token(self):
        if self._llm_first_token is None:
            self._llm_first_token = time.time()

    def log_assistant_message(self, text):
        elapsed = time.time() - self.start_time
        llm_total = (time.time() - self._llm_start) if self._llm_start else 0
        ttfb = (self._llm_first_token - self._llm_start) if self._llm_first_token and self._llm_start else llm_total

        sentiment, confidence = analyze_sentiment(text)
        if sentiment == "positive":
            badge = f"\033[92m[POSITIVE {confidence:.0%}]\033[0m"
        elif sentiment == "negative":
            badge = f"\033[91m[NEGATIVE {confidence:.0%}]\033[0m"
        else:
            badge = f"\033[93m[NEUTRAL {confidence:.0%}]\033[0m"

        logger.opt(colors=True).info(f"[{fmt_time(elapsed)}] \033[95m🤖 Megan:\033[0m {text}  {badge}  \033[2mLLM: {llm_total:.1f}s, TTFB: {ttfb:.1f}s\033[0m")

        self.messages.append({
            "timestamp": datetime.now().isoformat(),
            "elapsed_s": round(elapsed, 1),
            "speaker": "megan",
            "text": text,
            "sentiment": sentiment,
            "confidence": round(confidence, 2),
            "llm_total_s": round(llm_total, 2),
            "llm_ttfb_s": round(ttfb, 2),
        })

        self.exchange_times.append({
            "exchange": len(self.exchange_times) + 1,
            "llm": round(llm_total, 2),
            "ttfb": round(ttfb, 2),
        })

    def get_session_report(self):
        """Build the full session report dict for Firebase."""
        duration = time.time() - self.start_time
        patient_msgs = [m for m in self.messages if m["speaker"] == "patient"]
        pos = sum(1 for m in patient_msgs if m["sentiment"] == "positive")
        neg = sum(1 for m in patient_msgs if m["sentiment"] == "negative")
        neu = sum(1 for m in patient_msgs if m["sentiment"] == "neutral")
        crit = sum(1 for m in patient_msgs if m["sentiment"] == "CRITICAL")

        if crit > 0:
            overall = "CRITICAL"
        elif neg > pos:
            overall = "negative"
        elif pos > neg:
            overall = "positive"
        else:
            overall = "neutral"

        return {
            "date": self.start_datetime.strftime("%Y-%m-%d"),
            "time": self.start_datetime.strftime("%H:%M:%S"),
            "day": self.start_datetime.strftime("%A"),
            "duration_s": round(duration, 1),
            "exchanges": len(self.exchange_times),
            "overall_sentiment": overall,
            "sentiment_counts": {
                "positive": pos, "neutral": neu,
                "negative": neg, "critical": crit,
            },
            "avg_ttfb_s": round(sum(e["ttfb"] for e in self.exchange_times) / max(len(self.exchange_times), 1), 2),
            "avg_llm_total_s": round(sum(e["llm"] for e in self.exchange_times) / max(len(self.exchange_times), 1), 2),
            "messages": self.messages,
            "exchange_timing": self.exchange_times,
        }

    def print_summary(self, caretaker_summary=None):
        report = self.get_session_report()
        n = report["exchanges"]
        R, G, Y, M, CN, B, D, RST = C.RED, C.GREEN, C.YELLOW, C.MAGENTA, C.CYAN, C.BOLD, C.DIM, C.RESET
        BG_R, W = C.BG_RED, C.WHITE

        logger.opt(colors=True).info(f"{B}{'=' * 60}{RST}")
        logger.opt(colors=True).info(f"{B}  SESSION SUMMARY{RST}")
        logger.opt(colors=True).info(f"{B}{'=' * 60}{RST}")
        logger.info(f"Date: {report['day']}, {report['date']}  |  Time: {report['time']}")
        logger.info(f"Duration: {fmt_time(report['duration_s'])} ({report['duration_s']:.1f}s)  |  Exchanges: {n}")

        if self.exchange_times:
            logger.info(f"Avg TTFB: {report['avg_ttfb_s']:.1f}s  |  Avg LLM: {report['avg_llm_total_s']:.1f}s")
            fastest = min(e["ttfb"] for e in self.exchange_times)
            slowest = max(e["ttfb"] for e in self.exchange_times)
            logger.info(f"Fastest TTFB: {fastest:.1f}s  |  Slowest TTFB: {slowest:.1f}s")

            logger.opt(colors=True).info(f"{B}--- Exchange Timing ---{RST}")
            for e in self.exchange_times:
                logger.opt(colors=True).info(f"  #{e['exchange']}  TTFB: {D}{e['ttfb']:.1f}s{RST}  LLM: {D}{e['llm']:.1f}s{RST}")

        # Message sentiment
        patient_msgs = [m for m in self.messages if m["speaker"] == "patient"]
        if patient_msgs:
            sc = report["sentiment_counts"]
            logger.opt(colors=True).info(f"{B}--- Message-by-Message Sentiment ---{RST}")
            for entry in self.messages:
                t = fmt_time(entry["elapsed_s"])
                if entry["speaker"] == "patient":
                    speaker = f"{CN}🗣️ Patient{RST}"
                else:
                    speaker = f"{M}🤖 Megan{RST}"
                text_preview = entry["text"][:60] + ("..." if len(entry["text"]) > 60 else "")
                s = entry["sentiment"]
                if s == "CRITICAL":
                    badge = f"{BG_R}{W}{B} CRITICAL {entry['confidence']:.0%} {RST}"
                elif s == "negative":
                    badge = f"{R}[NEGATIVE {entry['confidence']:.0%}]{RST}"
                elif s == "positive":
                    badge = f"{G}[POSITIVE {entry['confidence']:.0%}]{RST}"
                else:
                    badge = f"{Y}[NEUTRAL {entry['confidence']:.0%}]{RST}"
                logger.opt(colors=True).info(f"[{t}] {speaker}: {D}\"{text_preview}\"{RST}  {badge}")

            logger.opt(colors=True).info(f"{B}--- Patient Sentiment Overview ---{RST}")
            if sc["critical"] > 0:
                logger.opt(colors=True).warning(f"{BG_R}{W}{B} CRITICAL: {sc['critical']} — Alert caretaker! {RST}")
            logger.opt(colors=True).info(f"{G}Positive: {sc['positive']}{RST}  |  {Y}Neutral: {sc['neutral']}{RST}  |  {R}Negative: {sc['negative']}{RST}")

            overall = report["overall_sentiment"]
            if overall == "CRITICAL":
                mood = f"{BG_R}{W}{B} ALERT - CRITICAL CONCERNS {RST}"
            elif overall == "negative":
                mood = f"{R}{B}Patient seems DOWN{RST}"
            elif overall == "positive":
                mood = f"{G}{B}Patient in GOOD spirits{RST}"
            else:
                mood = f"{Y}{B}Patient mood NEUTRAL{RST}"
            logger.opt(colors=True).info(f"Overall Mood: {mood}")

        if caretaker_summary:
            logger.opt(colors=True).info(f"{B}--- Caretaker Summary ---{RST}")
            for line in caretaker_summary.split("\n"):
                if line.strip():
                    logger.info(line.strip())

        logger.opt(colors=True).info(f"{B}{'=' * 60}{RST}")


# ── Backboard (Memory Only) ────────────────────────────────────────────────

def setup_backboard(force_reset=False):
    headers = {"X-API-Key": BACKBOARD_API_KEY}

    # 1. Resolve assistant_id: env var → file → create new
    env_assistant_id = os.getenv("BACKBOARD_ASSISTANT_ID")

    if env_assistant_id and not force_reset:
        logger.info(f"Using BACKBOARD_ASSISTANT_ID from env: {env_assistant_id}")
        # Still write to file for backwards compat
        ASSISTANT_FILE.write_text(env_assistant_id)
        return env_assistant_id

    if ASSISTANT_FILE.exists() and not force_reset:
        assistant_id = ASSISTANT_FILE.read_text().strip()
        logger.info(f"Loaded Backboard assistant from file: {assistant_id}")
        return assistant_id

    logger.info("Creating Backboard memory assistant...")
    resp = requests.post(
        f"{BACKBOARD_URL}/assistants",
        json={
            "name": "Dementia Care Memory Store",
            "system_prompt": "You store and recall memories about a dementia patient from their voice companion sessions. When asked for a summary, include date, time, mood, topics discussed, and any concerns.",
            "llm_provider": "openai",
            "llm_model_name": "gpt-4o-mini",
        },
        headers={**headers, "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    assistant_id = resp.json().get("assistant_id") or resp.json().get("id")
    logger.info(f"Backboard assistant: {assistant_id}")
    ASSISTANT_FILE.write_text(assistant_id)

    # Upload patient profile as a document
    if PATIENT_PROFILE_PATH.exists():
        logger.info("Uploading patient profile document...")
        with open(PATIENT_PROFILE_PATH, "rb") as f:
            resp = requests.post(
                f"{BACKBOARD_URL}/assistants/{assistant_id}/documents",
                files={"file": ("patient_profile.md", f, "text/markdown")},
                headers=headers,
            )
        resp.raise_for_status()
        doc_id = resp.json().get("document_id")
        logger.info(f"Patient profile uploaded as document: {doc_id}")

    return assistant_id


async def save_summary_to_backboard(assistant_id, report, caretaker_summary):
    """Save caretaker summary to Backboard so the agent remembers it next time.
    Uses shared BACKBOARD_THREAD_ID so caretaker portal can see call sessions."""
    import json as _json
    headers = {"X-API-Key": BACKBOARD_API_KEY}
    async with aiohttp.ClientSession() as session:
        # Use shared thread if available, otherwise create one
        tid = os.getenv("BACKBOARD_THREAD_ID")
        if not tid:
            async with session.post(
                f"{BACKBOARD_URL}/assistants/{assistant_id}/threads",
                headers=headers,
            ) as resp:
                data = await resp.json()
                tid = data.get("thread_id") or data.get("id")

        # Build transcript for the message content
        transcript_lines = []
        for m in report.get("messages", []):
            transcript_lines.append(
                f"[{m['elapsed_s']:.0f}s] {m['speaker']}: {m['text']}"
            )
        transcript_text = "\n".join(transcript_lines)

        # Save the summary with structured metadata
        summary_text = (
            f"Call Session on {report['day']}, {report['date']} at {report['time']}.\n"
            f"Duration: {report['duration_s']:.0f}s. "
            f"Overall sentiment: {report['overall_sentiment']}.\n\n"
            f"Caretaker summary:\n{caretaker_summary}\n\n"
            f"Transcript:\n{transcript_text}"
        )

        metadata = _json.dumps({
            "source": "agent",
            "type": "call_session",
            "custom_timestamp": report.get("messages", [{}])[0].get("timestamp", datetime.now().isoformat()) if report.get("messages") else datetime.now().isoformat(),
            "data": {
                "date": report["date"],
                "time": report["time"],
                "day": report["day"],
                "duration_s": report["duration_s"],
                "exchanges": report["exchanges"],
                "overall_sentiment": report["overall_sentiment"],
                "sentiment_counts": report["sentiment_counts"],
                "avg_ttfb_s": report.get("avg_ttfb_s", 0),
            },
        })

        form = aiohttp.FormData()
        form.add_field("content", summary_text)
        form.add_field("memory", "Auto")
        form.add_field("send_to_llm", "false")
        form.add_field("stream", "false")
        form.add_field("metadata", metadata)
        await session.post(
            f"{BACKBOARD_URL}/threads/{tid}/messages",
            data=form, headers=headers,
        )
        logger.info(f"Summary saved to Backboard (thread {tid})")


async def generate_caretaker_summary(assistant_id, report):
    """Ask Backboard to generate a summary using its memory."""
    headers = {"X-API-Key": BACKBOARD_API_KEY}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{BACKBOARD_URL}/assistants/{assistant_id}/threads",
            headers=headers,
        ) as resp:
            data = await resp.json()
            tid = data.get("thread_id") or data.get("id")

        # Build transcript for summary
        transcript = "\n".join(
            f"[{m['elapsed_s']:.0f}s] {m['speaker']}: {m['text']} [{m['sentiment']}]"
            for m in report["messages"]
        )

        prompt = (
            f"Generate a brief caretaker summary about this conversation with the patient.\n"
            f"Date: {report['day']}, {report['date']} at {report['time']}\n"
            f"Duration: {report['duration_s']:.0f} seconds\n"
            f"Overall sentiment: {report['overall_sentiment']}\n\n"
            f"Conversation:\n{transcript}\n\n"
            f"Include: 1) Overall mood 2) Topics discussed 3) Any concerns 4) Recommendations for the caretaker"
        )

        form = aiohttp.FormData()
        form.add_field("content", prompt)
        form.add_field("memory", "Auto")
        form.add_field("send_to_llm", "true")
        form.add_field("stream", "false")

        async with session.post(
            f"{BACKBOARD_URL}/threads/{tid}/messages",
            data=form, headers=headers,
        ) as resp:
            result = await resp.json()
            return (
                result.get("content")
                or result.get("message", {}).get("content")
                or result.get("text")
                or "Could not generate summary"
            )


# ── LiveKit Agent ──────────────────────────────────────────────────────────

from livekit.agents import AgentSession, Agent
from livekit.plugins import speechmatics, backboard, silero

# Shared state
tracker = SessionTracker()
bb_assistant_id = None


class CareAgent(Agent):
    def __init__(self, instructions=SYSTEM_PROMPT):
        super().__init__(
            instructions=instructions,
        )

    async def on_enter(self):
        """Greet the patient when connected."""
        await self.session.generate_reply(
            instructions="Greet the patient warmly by their first name (from the profile). Introduce yourself as Megan and ask how they are doing today."
        )

    async def on_user_turn_completed(self, turn_ctx, new_message):
        """Called after user finishes speaking."""
        try:
            user_text = new_message.text_content if isinstance(new_message.text_content, str) else str(new_message.text_content)
            if user_text and user_text != "None":
                tracker.log_user_message(user_text)
        except Exception as e:
            logger.error(f"on_user_turn_completed error: {e}")


# ── Entrypoint ─────────────────────────────────────────────────────────────

from livekit.agents import AgentServer, cli

server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx):
    global bb_assistant_id, tracker

    # Reset tracker for new session
    tracker = SessionTracker()

    # Setup Backboard assistant (creates + uploads profile on first run)
    force_reset = os.getenv("RESET_ASSISTANT", "").lower() in ("1", "true", "yes")
    bb_assistant_id = setup_backboard(force_reset=force_reset)

    # Build session — Backboard plugin handles LLM + memory + RAG natively
    session = AgentSession(
        stt=speechmatics.STT(
            language="en",
            additional_vocab=CUSTOM_VOCAB,
        ),
        llm=backboard.LLM(
            assistant_id=bb_assistant_id,
            api_key=BACKBOARD_API_KEY,
            llm_provider="openai",
            model_name="gpt-4o-mini",
            memory="auto",
        ),
        tts=speechmatics.TTS(
            voice="megan",
            api_key=SPEECHMATICS_API_KEY,
        ),
        vad=silero.VAD.load(),
    )

    # Track LLM timing via agent state changes
    def on_agent_state_changed(event):
        new_state = event.new_state if hasattr(event, "new_state") else str(event)
        old_state = event.old_state if hasattr(event, "old_state") else ""
        logger.debug(f"[STATE] {old_state} → {new_state}")
        if new_state == "thinking":
            tracker.llm_start()
        elif new_state == "speaking" and old_state == "thinking":
            tracker.llm_first_token()

    session.on("agent_state_changed", on_agent_state_changed)

    # SDK metrics logging for detailed pipeline breakdown
    def on_metrics_collected(event):
        metrics = event.metrics if hasattr(event, "metrics") else event
        name = type(metrics).__name__
        if name == "LLMMetrics":
            ttft = getattr(metrics, "ttft", None)
            duration = getattr(metrics, "duration", None)
            tokens_per_s = getattr(metrics, "tokens_per_second", None)
            if ttft:
                logger.debug(f"[METRICS] LLM TTFT: {ttft:.3f}s, duration: {duration:.2f}s, tokens/s: {tokens_per_s:.1f}")
        elif name == "TTSMetrics":
            ttfb = getattr(metrics, "ttfb", None)
            duration = getattr(metrics, "duration", None)
            if ttfb:
                logger.debug(f"[METRICS] TTS TTFB: {ttfb:.3f}s, duration: {duration:.2f}s")
        elif name == "EOUMetrics":
            eou_delay = getattr(metrics, "end_of_utterance_delay", None)
            transcription_delay = getattr(metrics, "transcription_delay", None)
            if eou_delay:
                logger.debug(f"[METRICS] EOU delay: {eou_delay:.3f}s, transcription: {transcription_delay:.3f}s")

    session.on("metrics_collected", on_metrics_collected)

    # Track assistant messages for session report
    def on_conversation_item(event):
        try:
            item = event.item
            if item.role == "assistant":
                text = item.text_content if isinstance(item.text_content, str) else str(item.text_content)
                if text and text != "None":
                    tracker.log_assistant_message(text)
        except Exception as e:
            logger.error(f"on_conversation_item error: {e}")

    session.on("conversation_item_added", on_conversation_item)

    # Also track user input transcription in real-time
    def on_user_input_transcribed(event):
        transcript = getattr(event, "transcript", "") or ""
        is_final = getattr(event, "is_final", False)
        if transcript.strip():
            if is_final:
                logger.opt(colors=True).info(f"\033[96m[STT FINAL]\033[0m {transcript}")
            else:
                logger.opt(colors=True).debug(f"\033[2m[STT partial] {transcript}\033[0m")

    session.on("user_input_transcribed", on_user_input_transcribed)

    # Start
    logger.info("=" * 60)
    logger.info("🎙️  SESSION STARTING — Waiting for patient...")
    logger.info("=" * 60)
    await session.start(room=ctx.room, agent=CareAgent())

    # When session ends (room closes), generate summary and save
    @ctx.add_shutdown_callback
    async def on_shutdown():
        import asyncio as _asyncio
        report = tracker.get_session_report()
        if report["exchanges"] == 0 and not report["messages"]:
            logger.info("No exchanges — skipping summary.")
            return

        # Print local summary FIRST (instant — before process timeout)
        tracker.print_summary()

        # Try Backboard API with 7s timeout (process gets killed at 10s)
        try:
            summary = await _asyncio.wait_for(
                generate_caretaker_summary(bb_assistant_id, report),
                timeout=7.0,
            )
            logger.info(f"Caretaker Summary: {summary}")
            await _asyncio.wait_for(
                save_summary_to_backboard(bb_assistant_id, report, summary),
                timeout=7.0,
            )
            logger.info("Summary saved to Backboard.")
        except _asyncio.TimeoutError:
            logger.warning("Backboard API timed out — local summary printed above.")
        except Exception as e:
            logger.error(f"Summary save failed: {e}")

        logger.info("Session complete.")


if __name__ == "__main__":
    cli.run_app(server)
