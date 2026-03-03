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


def send_whatsapp_alert(message):
    """Send a WhatsApp message to the caretaker via Twilio."""
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CARETAKER_PHONE]):
        logger.warning("Twilio WhatsApp not configured — skipping alert")
        return
    try:
        to = f"whatsapp:{CARETAKER_PHONE}"
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            data={
                "From": TWILIO_WHATSAPP_FROM,
                "To": to,
                "Body": message,
            },
        )
        if resp.ok:
            logger.info(f"WhatsApp alert sent to {CARETAKER_PHONE}")
        else:
            logger.error(f"WhatsApp alert failed: {resp.status_code} {resp.text[:200]}")
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
        badge = sentiment_badge(sentiment, confidence)
        print(f"\n  {C.DIM}[{fmt_time(elapsed)}]{C.RESET} {C.CYAN}Patient:{C.RESET} {text}")
        print(f"  {' ' * 9}{badge}")

        self.messages.append({
            "timestamp": datetime.now().isoformat(),
            "elapsed_s": round(elapsed, 1),
            "speaker": "patient",
            "text": text,
            "sentiment": sentiment,
            "confidence": round(confidence, 2),
        })

        if sentiment == "CRITICAL":
            print(f"\n  {C.BG_RED}{C.WHITE}{C.BOLD}  !! ALERT: Critical concern - notifying caretaker !!  {C.RESET}\n")
            send_whatsapp_alert(
                f"🚨 CRITICAL ALERT from Megan (Voice Agent)\n\n"
                f"Patient said: \"{text[:200]}\"\n\n"
                f"Sentiment: CRITICAL ({confidence:.0%} confidence)\n"
                f"Time: {datetime.now().strftime('%H:%M:%S')}\n\n"
                f"Please check on the patient immediately."
            )

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
        badge = sentiment_badge(sentiment, confidence)

        print(f"  {C.DIM}[{fmt_time(elapsed)}]{C.RESET} {C.MAGENTA}Megan:{C.RESET} {text}")
        print(f"  {' ' * 9}{badge}")
        print(f"  {C.DIM}  LLM: {llm_total:.1f}s total, TTFB: {ttfb:.1f}s{C.RESET}")

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

        print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")
        print(f"{C.BOLD}  SESSION SUMMARY{C.RESET}")
        print(f"{C.BOLD}{'=' * 60}{C.RESET}")
        print(f"  Date:              {report['day']}, {report['date']}")
        print(f"  Time:              {report['time']}")
        print(f"  Duration:          {fmt_time(report['duration_s'])} ({report['duration_s']:.1f}s)")
        print(f"  Exchanges:         {n}")

        if self.exchange_times:
            print(f"  Avg TTFB:          {report['avg_ttfb_s']:.1f}s")
            print(f"  Avg LLM total:     {report['avg_llm_total_s']:.1f}s")
            fastest = min(e["ttfb"] for e in self.exchange_times)
            slowest = max(e["ttfb"] for e in self.exchange_times)
            print(f"  Fastest TTFB:      {fastest:.1f}s")
            print(f"  Slowest TTFB:      {slowest:.1f}s")

            print(f"\n  {C.BOLD}Exchange Timing:{C.RESET}")
            print(f"  {'-' * 35}")
            print(f"  {'#':>3}  {'TTFB':>7}  {'LLM Total':>10}")
            print(f"  {'---':>3}  {'-------':>7}  {'----------':>10}")
            for e in self.exchange_times:
                print(f"  {e['exchange']:>3}  {e['ttfb']:>6.1f}s  {e['llm']:>9.1f}s")
            print(f"  {'AVG':>3}  {report['avg_ttfb_s']:>6.1f}s  {report['avg_llm_total_s']:>9.1f}s")

        # Message sentiment
        patient_msgs = [m for m in self.messages if m["speaker"] == "patient"]
        if patient_msgs:
            sc = report["sentiment_counts"]
            print(f"\n  {C.BOLD}Message-by-Message Sentiment:{C.RESET}")
            print(f"  {'-' * 56}")
            for entry in self.messages:
                t = fmt_time(entry["elapsed_s"])
                badge = sentiment_badge(entry["sentiment"], entry["confidence"])
                speaker_color = C.CYAN if entry["speaker"] == "patient" else C.MAGENTA
                speaker_label = "Patient" if entry["speaker"] == "patient" else "Megan  "
                text_preview = entry["text"][:50] + ("..." if len(entry["text"]) > 50 else "")
                print(f"  {C.DIM}[{t}]{C.RESET} {speaker_color}{speaker_label}{C.RESET} {badge}")
                print(f"         {C.DIM}\"{text_preview}\"{C.RESET}")

            print(f"\n  {C.BOLD}Patient Sentiment Overview:{C.RESET}")
            print(f"  {'-' * 56}")
            if sc["critical"] > 0:
                print(f"  {C.BG_RED}{C.WHITE}{C.BOLD}  CRITICAL: {sc['critical']}  {C.RESET}  !! Alert caretaker !!")
            print(f"  {C.GREEN}  Positive: {sc['positive']:>3}{C.RESET}  {'#' * sc['positive']}")
            print(f"  {C.YELLOW}  Neutral:  {sc['neutral']:>3}{C.RESET}  {'#' * sc['neutral']}")
            print(f"  {C.RED}  Negative: {sc['negative']:>3}{C.RESET}  {'#' * sc['negative']}")

            overall = report["overall_sentiment"]
            if overall == "CRITICAL":
                mood = f"{C.BG_RED}{C.WHITE}{C.BOLD} ALERT - CRITICAL CONCERNS {C.RESET}"
            elif overall == "negative":
                mood = f"{C.RED}{C.BOLD} Patient seems DOWN {C.RESET}"
            elif overall == "positive":
                mood = f"{C.GREEN}{C.BOLD} Patient in GOOD spirits {C.RESET}"
            else:
                mood = f"{C.YELLOW}{C.BOLD} Patient mood NEUTRAL {C.RESET}"
            print(f"\n  Overall Mood: {mood}")

        if caretaker_summary:
            print(f"\n  {C.BOLD}Caretaker Summary:{C.RESET}")
            print(f"  {'-' * 56}")
            for line in caretaker_summary.split("\n"):
                print(f"  {line}")

        print(f"{C.BOLD}{'=' * 60}{C.RESET}")


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
        user_text = new_message.text_content if isinstance(new_message.text_content, str) else str(new_message.text_content)
        if user_text:
            tracker.log_user_message(user_text)


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
            print(f"  {C.DIM}[METRICS] LLM TTFT: {ttft:.3f}s, duration: {duration:.2f}s, tokens/s: {tokens_per_s:.1f}{C.RESET}" if ttft else f"  {C.DIM}[METRICS] LLM: {metrics}{C.RESET}")
        elif name == "TTSMetrics":
            ttfb = getattr(metrics, "ttfb", None)
            duration = getattr(metrics, "duration", None)
            print(f"  {C.DIM}[METRICS] TTS TTFB: {ttfb:.3f}s, duration: {duration:.2f}s{C.RESET}" if ttfb else f"  {C.DIM}[METRICS] TTS: {metrics}{C.RESET}")
        elif name == "EOUMetrics":
            eou_delay = getattr(metrics, "end_of_utterance_delay", None)
            transcription_delay = getattr(metrics, "transcription_delay", None)
            print(f"  {C.DIM}[METRICS] EOU delay: {eou_delay:.3f}s, transcription delay: {transcription_delay:.3f}s{C.RESET}" if eou_delay else f"  {C.DIM}[METRICS] EOU: {metrics}{C.RESET}")

    session.on("metrics_collected", on_metrics_collected)

    # Track assistant messages for session report
    def on_conversation_item(event):
        item = event.item
        if item.role == "assistant":
            text = item.text_content if isinstance(item.text_content, str) else str(item.text_content)
            if text:
                tracker.log_assistant_message(text)

    session.on("conversation_item_added", on_conversation_item)

    # Start
    print(f"\n  {C.GREEN}{C.BOLD}Session starting...{C.RESET}")
    await session.start(room=ctx.room, agent=CareAgent())

    # When session ends (room closes), generate summary and save
    @ctx.add_shutdown_callback
    async def on_shutdown():
        report = tracker.get_session_report()
        if report["exchanges"] == 0 and not report["messages"]:
            print(f"\n  {C.DIM}No exchanges — skipping summary.{C.RESET}")
            return

        # Generate caretaker summary via Backboard
        print(f"\n  {C.CYAN}Generating caretaker summary...{C.RESET}")
        summary = await generate_caretaker_summary(bb_assistant_id, report)

        # Print summary
        tracker.print_summary(caretaker_summary=summary)

        # Save summary to Backboard (for next session memory)
        print(f"\n  {C.CYAN}Saving to Backboard memory...{C.RESET}")
        await save_summary_to_backboard(bb_assistant_id, report, summary)

        print(f"\n  {C.GREEN}Session complete.{C.RESET}")


if __name__ == "__main__":
    cli.run_app(server)
