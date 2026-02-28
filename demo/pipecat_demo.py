#!/usr/bin/env python3
"""
Low-Latency Dementia Care Voice Agent (Pipecat)
Speechmatics STT/TTS + OpenAI GPT-4o-mini (direct) + Backboard (memory only)

Usage:
  uv run python pipecat_demo.py                    # Start (browser at localhost:7860)
  RESET_ASSISTANT=1 uv run python pipecat_demo.py   # Reset + re-ingest patient profile
"""

import asyncio
import json
import os
import time
from pathlib import Path

import aiohttp
import requests
from dotenv import load_dotenv
from loguru import logger

print("Starting Dementia Care Voice Agent...")
print("Loading models (first run may take ~20s)\n")

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    TextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.speechmatics.stt import SpeechmaticsSTTService
from pipecat.services.speechmatics.tts import SpeechmaticsTTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams

logger.info("All components loaded")

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

SPEECHMATICS_API_KEY = os.getenv("SPEECHMATICS_API_KEY")
BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY")
OPENAI_API_KEY = os.getenv("OPEN_AI_API_KEY")  # Note: OPEN_AI_API_KEY in .env
BACKBOARD_URL = "https://app.backboard.io/api"

ASSISTANT_FILE = Path(__file__).parent / ".pipecat_assistant_id"
THREAD_FILE = Path(__file__).parent / ".pipecat_thread_id"
PATIENT_PROFILE_PATH = Path(__file__).parent / "patient_profile.md"

# Load patient profile for system prompt injection
PATIENT_CONTEXT = ""
if PATIENT_PROFILE_PATH.exists():
    PATIENT_CONTEXT = PATIENT_PROFILE_PATH.read_text()

SYSTEM_PROMPT = f"""You are Sarah, a warm, patient, and caring voice companion for Abhishek Thomas, a 50-year-old man living in Creteil, Ile-de-France, who has early-onset dementia.

PERSONALITY:
- Warm, gentle, encouraging — like a trusted friend
- Speak in short, simple sentences (this is a voice call)
- Keep responses to 2-3 sentences max
- Celebrate small things: "That sounds lovely!"
- Never clinical, robotic, or condescending

COMMUNICATION RULES:
- Always address him as "Abhishek"
- Ask ONE question at a time
- If he repeats himself, respond patiently as if hearing it the first time
- NEVER say "you already told me" or "don't you remember"
- Validate his emotions: "That sounds frustrating" / "I understand"
- If he's confused, gently redirect without correcting

KEY PEOPLE:
- Ayush: his primary caretaker
- Thamimul: his close family friend

CONVERSATION GOALS:
- Check how he's feeling (mood, physical comfort)
- Ask about his day naturally
- Gently check on meals, hydration, medication
- Engage with any memories or stories he shares

ALERT: If Abhishek mentions falls, severe pain, feeling lost, or wanting to hurt himself, calmly reassure him and say you will let Ayush know right away.

Remember: You are his companion, not his nurse. Keep it warm and natural.

--- PATIENT PROFILE & MEMORY ---
{PATIENT_CONTEXT}
"""

CUSTOM_VOCAB = [
    {"content": "Abhishek", "sounds_like": ["ab-hee-shek", "ab-ee-shek"]},
    {"content": "Ayush", "sounds_like": ["ah-yoosh", "ai-yush"]},
    {"content": "Thamimul", "sounds_like": ["tah-mee-mul", "tamimul"]},
    {"content": "Creteil", "sounds_like": ["kret-eye", "cret-ay"]},
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


# ── Conversation Tracker (sits in pipeline, logs + saves to Backboard) ──────

class ConversationTracker(FrameProcessor):
    """Tracks conversation for sentiment, timing, and saves to Backboard memory.

    Sits AFTER the LLM in the pipeline. Sees:
    - LLMFullResponseStartFrame (response begins)
    - TextFrame chunks (response text)
    - LLMFullResponseEndFrame (response done)

    Gets user text from the shared LLMContext object.
    """

    def __init__(self, backboard_api_key, backboard_thread_id, llm_context, **kwargs):
        super().__init__(**kwargs)
        self.bb_api_key = backboard_api_key
        self.bb_thread_id = backboard_thread_id
        self.llm_context = llm_context  # shared context to read user messages
        self._session = None

        self.conversation_log = []
        self.exchange_times = []
        self.start_time = time.time()
        self._current_user_text = ""
        self._current_assistant_text = ""
        self._llm_start_time = None
        self._llm_first_token_time = None
        self._collecting_response = False
        self._last_seen_msg_count = 0

    async def _ensure_session(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # Track LLM response start — extract user text from shared context
        if isinstance(frame, LLMFullResponseStartFrame):
            self._collecting_response = True
            self._current_assistant_text = ""
            self._llm_start_time = time.time()
            self._llm_first_token_time = None

            # Get latest user message from shared context
            msgs = self.llm_context.get_messages()
            if len(msgs) > self._last_seen_msg_count:
                for msg in reversed(msgs):
                    if msg.get("role") == "user":
                        self._current_user_text = msg.get("content", "")
                        break
                self._last_seen_msg_count = len(msgs)

                if self._current_user_text:
                    elapsed = time.time() - self.start_time
                    sentiment, confidence = analyze_sentiment(self._current_user_text)
                    badge = sentiment_badge(sentiment, confidence)
                    print(f"\n  {C.DIM}[{fmt_time(elapsed)}]{C.RESET} {C.CYAN}Patient:{C.RESET} {self._current_user_text}")
                    print(f"  {' ' * 9}{badge}")
                    self.conversation_log.append({
                        "time": elapsed, "speaker": "patient", "text": self._current_user_text,
                        "sentiment": sentiment, "confidence": confidence,
                    })
                    if sentiment == "CRITICAL":
                        print(f"\n  {C.BG_RED}{C.WHITE}{C.BOLD}  !! ALERT: Critical concern - notifying Ayush !!  {C.RESET}\n")

        # Capture LLM text chunks
        elif isinstance(frame, TextFrame) and self._collecting_response:
            if self._llm_first_token_time is None:
                self._llm_first_token_time = time.time()
            self._current_assistant_text += frame.text

        # Track LLM response end + save to Backboard
        elif isinstance(frame, LLMFullResponseEndFrame) and self._collecting_response:
            self._collecting_response = False
            if self._current_assistant_text:
                llm_end = time.time()
                llm_duration = llm_end - self._llm_start_time if self._llm_start_time else 0
                ttfb = (self._llm_first_token_time - self._llm_start_time) if self._llm_first_token_time and self._llm_start_time else llm_duration

                elapsed = time.time() - self.start_time
                sentiment, confidence = analyze_sentiment(self._current_assistant_text)
                badge = sentiment_badge(sentiment, confidence)

                print(f"  {C.DIM}[{fmt_time(elapsed)}]{C.RESET} {C.MAGENTA}Sarah:{C.RESET} {self._current_assistant_text}")
                print(f"  {' ' * 9}{badge}")
                print(f"  {C.DIM}  LLM: {llm_duration:.1f}s total, TTFB: {ttfb:.1f}s{C.RESET}")

                self.conversation_log.append({
                    "time": elapsed, "speaker": "sarah", "text": self._current_assistant_text,
                    "sentiment": sentiment, "confidence": confidence,
                })
                self.exchange_times.append({
                    "exchange": len(self.exchange_times) + 1,
                    "llm": llm_duration, "ttfb": ttfb,
                })

                # Save exchange to Backboard async (non-blocking)
                asyncio.create_task(self._save_to_backboard(
                    self._current_user_text,
                    self._current_assistant_text,
                ))

        # Pass all frames through unchanged
        await self.push_frame(frame, direction)

    async def _save_to_backboard(self, user_text, assistant_text):
        """Save conversation exchange to Backboard for long-term memory."""
        if not self.bb_thread_id or not user_text:
            return
        try:
            await self._ensure_session()
            # Save user message
            data = aiohttp.FormData()
            data.add_field("content", f"Patient said: {user_text}")
            data.add_field("memory", "Auto")
            data.add_field("send_to_llm", "false")
            data.add_field("stream", "false")
            await self._session.post(
                f"{BACKBOARD_URL}/threads/{self.bb_thread_id}/messages",
                data=data,
                headers={"X-API-Key": self.bb_api_key},
            )
            # Save assistant response
            data2 = aiohttp.FormData()
            data2.add_field("content", f"Sarah responded: {assistant_text}")
            data2.add_field("memory", "Auto")
            data2.add_field("send_to_llm", "false")
            data2.add_field("stream", "false")
            await self._session.post(
                f"{BACKBOARD_URL}/threads/{self.bb_thread_id}/messages",
                data=data2,
                headers={"X-API-Key": self.bb_api_key},
            )
            logger.debug("Saved exchange to Backboard memory")
        except Exception as e:
            logger.warning(f"Failed to save to Backboard: {e}")

    async def generate_summary(self):
        """Generate a caretaker summary using Backboard after session ends."""
        if not self.bb_thread_id or not self.conversation_log:
            return None
        try:
            await self._ensure_session()
            # Ask Backboard to summarize the session
            summary_prompt = (
                "Please provide a brief caretaker summary of this conversation session with patient Abhishek Thomas. "
                "Include: 1) Overall mood, 2) Topics discussed, 3) Any concerns or alerts, "
                "4) Medication/meal status if mentioned, 5) Recommendations for caretaker Ayush."
            )
            data = aiohttp.FormData()
            data.add_field("content", summary_prompt)
            data.add_field("memory", "Auto")
            data.add_field("send_to_llm", "true")
            data.add_field("stream", "false")
            async with self._session.post(
                f"{BACKBOARD_URL}/threads/{self.bb_thread_id}/messages",
                data=data,
                headers={"X-API-Key": self.bb_api_key},
            ) as resp:
                result = await resp.json()
                return (
                    result.get("content")
                    or result.get("message", {}).get("content")
                    or result.get("text")
                )
        except Exception as e:
            logger.warning(f"Failed to generate summary: {e}")
            return None

    async def cleanup(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def print_summary(self):
        session_duration = time.time() - self.start_time
        n = len(self.exchange_times)

        print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")
        print(f"{C.BOLD}  SESSION SUMMARY{C.RESET}")
        print(f"{C.BOLD}{'=' * 60}{C.RESET}")
        print(f"  Total Duration:    {fmt_time(session_duration)} ({session_duration:.1f}s)")
        print(f"  Exchanges:         {n}")

        if self.exchange_times:
            avg_llm = sum(e["llm"] for e in self.exchange_times) / n
            avg_ttfb = sum(e["ttfb"] for e in self.exchange_times) / n
            fastest = min(e["ttfb"] for e in self.exchange_times)
            slowest = max(e["ttfb"] for e in self.exchange_times)

            print(f"  Avg LLM total:     {avg_llm:.1f}s")
            print(f"  Avg TTFB:          {avg_ttfb:.1f}s")
            print(f"  Fastest TTFB:      {fastest:.1f}s")
            print(f"  Slowest TTFB:      {slowest:.1f}s")

            print(f"\n  {C.BOLD}Exchange Timing:{C.RESET}")
            print(f"  {'-' * 35}")
            print(f"  {'#':>3}  {'TTFB':>7}  {'LLM Total':>10}")
            print(f"  {'---':>3}  {'-------':>7}  {'----------':>10}")
            for e in self.exchange_times:
                print(f"  {e['exchange']:>3}  {e['ttfb']:>6.1f}s  {e['llm']:>9.1f}s")
            print(f"  {'AVG':>3}  {avg_ttfb:>6.1f}s  {avg_llm:>9.1f}s")

        # Sentiment
        patient_msgs = [m for m in self.conversation_log if m["speaker"] == "patient"]
        if patient_msgs:
            pos = sum(1 for m in patient_msgs if m["sentiment"] == "positive")
            neg = sum(1 for m in patient_msgs if m["sentiment"] == "negative")
            neu = sum(1 for m in patient_msgs if m["sentiment"] == "neutral")
            crit = sum(1 for m in patient_msgs if m["sentiment"] == "CRITICAL")

            print(f"\n  {C.BOLD}Message-by-Message Sentiment:{C.RESET}")
            print(f"  {'-' * 56}")
            for entry in self.conversation_log:
                t = fmt_time(entry["time"])
                badge = sentiment_badge(entry["sentiment"], entry["confidence"])
                speaker_color = C.CYAN if entry["speaker"] == "patient" else C.MAGENTA
                speaker_label = "Patient" if entry["speaker"] == "patient" else "Sarah  "
                text_preview = entry["text"][:50] + ("..." if len(entry["text"]) > 50 else "")
                print(f"  {C.DIM}[{t}]{C.RESET} {speaker_color}{speaker_label}{C.RESET} {badge}")
                print(f"         {C.DIM}\"{text_preview}\"{C.RESET}")

            print(f"\n  {C.BOLD}Patient Sentiment Overview:{C.RESET}")
            print(f"  {'-' * 56}")
            if crit > 0:
                print(f"  {C.BG_RED}{C.WHITE}{C.BOLD}  CRITICAL: {crit}  {C.RESET}  !! Alert caretaker Ayush !!")
            print(f"  {C.GREEN}  Positive: {pos:>3}{C.RESET}  {'#' * pos}")
            print(f"  {C.YELLOW}  Neutral:  {neu:>3}{C.RESET}  {'#' * neu}")
            print(f"  {C.RED}  Negative: {neg:>3}{C.RESET}  {'#' * neg}")

            if crit > 0:
                mood = f"{C.BG_RED}{C.WHITE}{C.BOLD} ALERT - CRITICAL CONCERNS {C.RESET}"
            elif neg > pos:
                mood = f"{C.RED}{C.BOLD} Patient seems DOWN {C.RESET}"
            elif pos > neg:
                mood = f"{C.GREEN}{C.BOLD} Patient in GOOD spirits {C.RESET}"
            else:
                mood = f"{C.YELLOW}{C.BOLD} Patient mood NEUTRAL {C.RESET}"
            print(f"\n  Overall Mood: {mood}")

        # Generate caretaker summary via Backboard
        print(f"\n  {C.CYAN}Generating caretaker summary via Backboard...{C.RESET}")
        summary = await self.generate_summary()
        if summary:
            print(f"\n  {C.BOLD}Caretaker Summary (for Ayush):{C.RESET}")
            print(f"  {'-' * 56}")
            for line in summary.split('\n'):
                print(f"  {line}")
        else:
            print(f"  {C.DIM}(Could not generate summary){C.RESET}")

        print(f"\n  {C.GREEN}Conversation saved to Backboard memory.{C.RESET}")
        print(f"  {C.DIM}Backboard thread: {self.bb_thread_id}{C.RESET}")
        print(f"  {C.DIM}View memories at: https://app.backboard.io{C.RESET}")
        print(f"{C.BOLD}{'=' * 60}{C.RESET}")


# ── Backboard Setup ─────────────────────────────────────────────────────────

def setup_backboard(force_reset=False):
    """Create Backboard assistant for memory storage (LLM handled by OpenAI directly)."""
    headers = {"X-API-Key": BACKBOARD_API_KEY}

    if ASSISTANT_FILE.exists() and not force_reset:
        assistant_id = ASSISTANT_FILE.read_text().strip()
        logger.info(f"Loaded Backboard assistant: {assistant_id}")
        return assistant_id

    logger.info("Creating Backboard assistant (memory store)...")
    resp = requests.post(
        f"{BACKBOARD_URL}/assistants",
        json={
            "name": "Memory Store - Abhishek Thomas",
            "system_prompt": "You are a memory assistant that stores and recalls information about patient Abhishek Thomas for his caretaker Ayush.",
            "llm_provider": "openai",
            "llm_model_name": "gpt-4o-mini",
        },
        headers={**headers, "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    assistant_id = resp.json().get("assistant_id") or resp.json().get("id")
    logger.info(f"Backboard assistant created: {assistant_id}")
    ASSISTANT_FILE.write_text(assistant_id)

    # Ingest patient profile
    if PATIENT_PROFILE_PATH.exists():
        logger.info("Ingesting patient profile into Backboard memory...")
        profile_text = PATIENT_PROFILE_PATH.read_text()
        t_resp = requests.post(
            f"{BACKBOARD_URL}/assistants/{assistant_id}/threads", headers=headers,
        )
        t_resp.raise_for_status()
        thread_id = t_resp.json().get("thread_id") or t_resp.json().get("id")

        chunk_size = 3000
        chunks = [profile_text[i:i + chunk_size] for i in range(0, len(profile_text), chunk_size)]
        for i, chunk in enumerate(chunks):
            logger.info(f"Ingesting chunk {i + 1}/{len(chunks)}...")
            requests.post(
                f"{BACKBOARD_URL}/threads/{thread_id}/messages",
                data={"content": chunk, "memory": "Auto", "send_to_llm": "false", "stream": "false"},
                headers=headers,
            )
            time.sleep(0.5)
        logger.info("Patient profile ingested into Backboard!")

    return assistant_id


def create_backboard_thread(assistant_id):
    """Create a new Backboard thread for this conversation session."""
    headers = {"X-API-Key": BACKBOARD_API_KEY}
    resp = requests.post(
        f"{BACKBOARD_URL}/assistants/{assistant_id}/threads",
        headers=headers,
    )
    resp.raise_for_status()
    thread_id = resp.json().get("thread_id") or resp.json().get("id")
    logger.info(f"Backboard memory thread: {thread_id}")
    return thread_id


# ── Pipecat Bot ─────────────────────────────────────────────────────────────

async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    logger.info("Starting voice agent")

    force_reset = os.getenv("RESET_ASSISTANT", "").lower() in ("1", "true", "yes")
    assistant_id = setup_backboard(force_reset=force_reset)
    bb_thread_id = create_backboard_thread(assistant_id)

    # Speechmatics STT (streaming, with custom vocab)
    stt = SpeechmaticsSTTService(
        api_key=SPEECHMATICS_API_KEY,
        params=SpeechmaticsSTTService.InputParams(
            language="en",
            additional_vocab=CUSTOM_VOCAB,
        ),
    )

    # OpenAI GPT-4o-mini (direct, fast streaming)
    llm = OpenAILLMService(
        api_key=OPENAI_API_KEY,
        model="gpt-4o-mini",
    )

    # Speechmatics TTS (streaming)
    aio_session = aiohttp.ClientSession()
    tts = SpeechmaticsTTSService(
        api_key=SPEECHMATICS_API_KEY,
        voice_id="sarah",
        aiohttp_session=aio_session,
    )

    # Conversation context
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
    ]
    context = LLMContext(messages)

    # Conversation tracker (sentiment + saves to Backboard async)
    tracker = ConversationTracker(
        backboard_api_key=BACKBOARD_API_KEY,
        backboard_thread_id=bb_thread_id,
        llm_context=context,
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    # The streaming pipeline
    #   STT → user_agg → LLM → tracker → TTS → output → assistant_agg
    #                             ↑ sees LLMContextFrame (user text) + TextFrames (response)
    #                               logs sentiment, timing, saves to Backboard async
    pipeline = Pipeline([
        transport.input(),       # Browser mic audio in
        stt,                     # Speechmatics STT (streaming)
        user_aggregator,         # Collect full user utterance
        llm,                     # OpenAI GPT-4o-mini (direct streaming)
        tracker,                 # Log sentiment + save to Backboard async
        tts,                     # Speechmatics TTS (streaming)
        transport.output(),      # Browser speaker audio out
        assistant_aggregator,    # Track assistant responses
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")
        print(f"\n  {C.GREEN}{C.BOLD}Client connected! Conversation starting...{C.RESET}\n")
        messages.append({"role": "system", "content": "Greet Abhishek warmly. Say hello, introduce yourself as Sarah, and ask how he is doing today."})
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        print(f"\n  {C.YELLOW}Client disconnected.{C.RESET}")
        await tracker.print_summary()
        await tracker.cleanup()
        await aio_session.close()
        await task.cancel()

    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)
    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    transport_params = {
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    }
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
