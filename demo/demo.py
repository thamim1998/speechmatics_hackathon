#!/usr/bin/env python3
"""
Dementia Care Voice Agent Demo
Speechmatics (STT + TTS + Sentiment) + Backboard (LLM + Memory)

Usage:
  uv run demo.py          # Voice mode (mic + speaker)
  uv run demo.py --text   # Text-only mode (type messages)
  uv run demo.py --reset  # Reset assistant (re-ingest patient profile)
"""

import asyncio
import io
import json
import os
import struct
import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np
import requests
import sounddevice as sd
import websockets
from dotenv import load_dotenv

# ── Config ──────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).parent.parent / ".env")

SPEECHMATICS_API_KEY = os.getenv("SPEECHMATICS_API_KEY")
BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY")

BACKBOARD_URL = "https://app.backboard.io/api"
TTS_URL = "https://preview.tts.speechmatics.com/generate"
SM_JWT_URL = "https://mp.speechmatics.com/v1/api_keys"
SM_RT_URL = "wss://eu2.rt.speechmatics.com/v2"
SM_BATCH_URL = "https://asr.api.speechmatics.com/v2"

SAMPLE_RATE = 16000
VOICE = "sarah"
ASSISTANT_FILE = Path(__file__).parent / ".assistant_id"

SYSTEM_PROMPT = """You are Sarah, a warm, patient, and caring voice companion for Abhishek Thomas, a 50-year-old man living in Creteil, Ile-de-France, who has early-onset dementia.

PERSONALITY:
- Warm, gentle, encouraging — like a trusted friend
- Speak in short, simple sentences (this is a voice call)
- Keep responses to 2-3 sentences max
- Celebrate small things: "That sounds lovely!"
- Use gentle humor when appropriate
- Never clinical, robotic, or condescending

COMMUNICATION RULES:
- Always address him as "Abhishek"
- Ask ONE question at a time
- Give him time to respond — never rush
- If he repeats himself, respond patiently as if hearing it the first time
- NEVER say "you already told me" or "don't you remember"
- NEVER quiz or test him on facts, dates, or names
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
- Note any concerns (confusion, pain, sadness) for caretaker report

ALERT: If Abhishek mentions falls, severe pain, feeling lost, or wanting to hurt himself, calmly reassure him and say you will let Ayush know right away.

Remember: You are his companion, not his nurse. Keep it warm and natural."""

PATIENT_PROFILE_PATH = Path(__file__).parent / "patient_profile.md"

# Custom vocabulary for better STT recognition
CUSTOM_VOCAB = [
    {"content": "Abhishek", "sounds_like": ["ab-hee-shek", "ab-ee-shek", "abhishek"]},
    {"content": "Ayush", "sounds_like": ["ah-yoosh", "ai-yush"]},
    {"content": "Thamimul", "sounds_like": ["tah-mee-mul", "tamimul", "thamimool"]},
    {"content": "Creteil", "sounds_like": ["kret-eye", "cret-ay", "cretay"]},
    {"content": "dementia"},
    {"content": "donepezil", "sounds_like": ["donna-pez-ill", "done-pezil"]},
    {"content": "memantine", "sounds_like": ["mem-an-teen"]},
]


# ── Terminal Colors ─────────────────────────────────────────────────────────

class C:
    """ANSI color codes for terminal output."""
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"
    BG_RED = "\033[41m"
    BG_GREEN = "\033[42m"
    BG_YELLOW = "\033[43m"
    WHITE = "\033[97m"


# ── Sentiment Analysis ──────────────────────────────────────────────────────

CRITICAL_WORDS = [
    "fall", "fell", "hurt myself", "emergency", "help me", "can't breathe",
    "chest pain", "blood", "bleeding", "die", "dying", "kill", "suicide",
    "harm myself", "lost", "don't know where", "can't find",
]

NEGATIVE_WORDS = [
    "sad", "hurt", "pain", "angry", "frustrated", "confused", "scared",
    "afraid", "worried", "anxious", "lonely", "tired", "bad", "terrible",
    "awful", "horrible", "depressed", "cry", "crying", "sick", "dizzy",
    "weak", "forget", "forgot", "can't remember", "don't remember",
    "upset", "unhappy", "miserable", "miss", "missing", "hate",
    "uncomfortable", "cold", "hungry", "thirsty", "headache", "ache",
]

POSITIVE_WORDS = [
    "happy", "good", "great", "wonderful", "nice", "love", "enjoy",
    "beautiful", "fun", "laugh", "smile", "better", "fine", "well",
    "fantastic", "amazing", "pleased", "grateful", "thankful", "excited",
    "delicious", "tasty", "lovely", "calm", "relaxed", "comfortable",
    "peaceful", "warm", "cozy", "remember", "friend", "family",
]


def analyze_sentiment(text):
    """Quick keyword-based sentiment for real-time display."""
    text_lower = text.lower()

    # Check critical first
    crit = sum(1 for w in CRITICAL_WORDS if w in text_lower)
    if crit > 0:
        return "CRITICAL", min(0.7 + crit * 0.1, 0.99)

    neg = sum(1 for w in NEGATIVE_WORDS if w in text_lower)
    pos = sum(1 for w in POSITIVE_WORDS if w in text_lower)

    if neg > pos:
        return "negative", min(0.4 + neg * 0.1, 0.95)
    elif pos > neg:
        return "positive", min(0.4 + pos * 0.1, 0.95)
    else:
        return "neutral", 0.5


def sentiment_badge(sentiment, confidence):
    """Return a colored sentiment badge string."""
    if sentiment == "CRITICAL":
        return f"{C.BG_RED}{C.WHITE}{C.BOLD} !! CRITICAL ({confidence:.0%}) !! {C.RESET}"
    elif sentiment == "negative":
        return f"{C.RED}[NEGATIVE {confidence:.0%}]{C.RESET}"
    elif sentiment == "positive":
        return f"{C.GREEN}[POSITIVE {confidence:.0%}]{C.RESET}"
    else:
        return f"{C.YELLOW}[NEUTRAL {confidence:.0%}]{C.RESET}"


def format_time(seconds):
    """Format elapsed seconds as mm:ss."""
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


# ── Backboard Client ────────────────────────────────────────────────────────

class BackboardClient:
    def __init__(self, api_key):
        self.api_key = api_key
        self.headers = {"X-API-Key": api_key}

    def create_assistant(self, name, system_prompt):
        resp = requests.post(
            f"{BACKBOARD_URL}/assistants",
            json={"name": name, "system_prompt": system_prompt},
            headers={**self.headers, "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        return resp.json()

    def create_thread(self, assistant_id):
        resp = requests.post(
            f"{BACKBOARD_URL}/assistants/{assistant_id}/threads",
            headers=self.headers,
        )
        resp.raise_for_status()
        return resp.json()

    def send_message(self, thread_id, content, memory="Auto", send_to_llm=True, stream=False):
        data = {
            "content": content,
            "memory": memory,
            "send_to_llm": str(send_to_llm).lower(),
            "stream": str(stream).lower(),
        }
        resp = requests.post(
            f"{BACKBOARD_URL}/threads/{thread_id}/messages",
            data=data,
            headers=self.headers,
        )
        resp.raise_for_status()
        return resp.json()


# ── Speechmatics TTS ────────────────────────────────────────────────────────

def synthesize_speech(text, voice=VOICE):
    """Convert text to speech using Speechmatics TTS. Returns PCM 16-bit LE at 16kHz."""
    resp = requests.post(
        f"{TTS_URL}/{voice}?output_format=pcm_16000",
        json={"text": text},
        headers={
            "Authorization": f"Bearer {SPEECHMATICS_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    return resp.content


def play_audio(pcm_data, sample_rate=SAMPLE_RATE):
    """Play PCM 16-bit LE audio through speakers."""
    if not pcm_data:
        return
    samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
    sd.play(samples, sample_rate, blocking=True)


def speak(text):
    """Synthesize and play text."""
    try:
        audio = synthesize_speech(text)
        play_audio(audio)
    except Exception as e:
        print(f"  (TTS error: {e})")


# ── Speechmatics STT (Real-time WebSocket) ──────────────────────────────────

def get_speechmatics_jwt():
    """Get a short-lived JWT for Speechmatics real-time API."""
    resp = requests.post(
        f"{SM_JWT_URL}?type=rt",
        headers={
            "Authorization": f"Bearer {SPEECHMATICS_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"ttl": 60},
    )
    resp.raise_for_status()
    return resp.json()["key_value"]


async def transcribe_audio(audio_int16):
    """Send pre-recorded audio to Speechmatics real-time STT and return transcript."""
    jwt = get_speechmatics_jwt()
    transcript_parts = []

    async with websockets.connect(
        f"{SM_RT_URL}?jwt={jwt}",
        ping_interval=30,
        ping_timeout=60,
    ) as ws:
        # Start recognition
        await ws.send(json.dumps({
            "message": "StartRecognition",
            "transcription_config": {
                "language": "en",
                "enable_partials": False,
                "max_delay": 2,
                "additional_vocab": CUSTOM_VOCAB,
            },
            "audio_format": {
                "type": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": SAMPLE_RATE,
            },
        }))

        # Wait for RecognitionStarted (skip Info messages)
        while True:
            msg = json.loads(await ws.recv())
            if msg["message"] == "RecognitionStarted":
                break
            elif msg["message"] in ("Info", "Warning"):
                continue
            else:
                raise RuntimeError(f"Unexpected message: {msg}")

        # Stream audio in chunks (100ms each)
        audio_bytes = audio_int16.tobytes()
        chunk_size = SAMPLE_RATE * 2 // 10  # 100ms of 16-bit audio = 3200 bytes
        for i in range(0, len(audio_bytes), chunk_size):
            await ws.send(audio_bytes[i : i + chunk_size])
            await asyncio.sleep(0.005)

        # Signal end of audio
        await ws.send(json.dumps({"message": "EndOfStream", "last_seq_no": 0}))

        # Collect final transcripts
        while True:
            msg = json.loads(await ws.recv())
            if msg["message"] == "AddTranscript":
                meta_transcript = msg.get("metadata", {}).get("transcript", "")
                if meta_transcript:
                    transcript_parts.append(meta_transcript)
                else:
                    for result in msg.get("results", []):
                        for alt in result.get("alternatives", []):
                            content = alt.get("content", "")
                            if content:
                                transcript_parts.append(content)
            elif msg["message"] == "EndOfTranscript":
                break
            elif msg["message"] in ("Info", "Warning"):
                continue
            elif msg["message"] == "Error":
                print(f"  STT Error: {msg.get('reason', 'unknown')}")
                break

    return " ".join(transcript_parts).strip()


# ── Speechmatics Batch Sentiment Analysis ────────────────────────────────────

def audio_to_wav_bytes(audio_int16, sample_rate=SAMPLE_RATE):
    """Convert int16 numpy array to WAV file bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int16.tobytes())
    buf.seek(0)
    return buf.read()


def submit_batch_sentiment_job(wav_bytes):
    """Submit audio to Speechmatics batch API with sentiment analysis."""
    config = json.dumps({
        "type": "transcription",
        "transcription_config": {
            "language": "en",
            "operating_point": "enhanced",
            "diarization": "speaker",
        },
        "sentiment_analysis_config": {},
        "summarization_config": {
            "content_type": "conversational",
            "summary_length": "detailed",
            "summary_type": "paragraphs",
        },
    })

    resp = requests.post(
        f"{SM_BATCH_URL}/jobs/",
        headers={"Authorization": f"Bearer {SPEECHMATICS_API_KEY}"},
        files={"data_file": ("session.wav", wav_bytes, "audio/wav")},
        data={"config": config},
    )
    resp.raise_for_status()
    return resp.json()["id"]


def poll_batch_job(job_id, timeout=120, interval=3):
    """Poll Speechmatics batch job until complete."""
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(
            f"{SM_BATCH_URL}/jobs/{job_id}",
            headers={"Authorization": f"Bearer {SPEECHMATICS_API_KEY}"},
        )
        resp.raise_for_status()
        status = resp.json().get("job", {}).get("status", "")

        if status == "done":
            # Fetch transcript with sentiment
            result = requests.get(
                f"{SM_BATCH_URL}/jobs/{job_id}/transcript?format=json-v2",
                headers={"Authorization": f"Bearer {SPEECHMATICS_API_KEY}"},
            )
            result.raise_for_status()
            return result.json()
        elif status == "rejected":
            raise RuntimeError(f"Batch job rejected: {resp.json()}")

        time.sleep(interval)

    raise TimeoutError(f"Batch job {job_id} timed out after {timeout}s")


# ── Audio Recording (Push-to-Talk) ──────────────────────────────────────────

def record_audio():
    """Record audio from microphone. Press Enter to start, Enter again to stop."""
    print(f"\n  Press ENTER to start speaking (or type 'quit' to exit)... ", end="", flush=True)
    user_input = input()
    if user_input.strip().lower() in ("quit", "exit", "q"):
        return None

    frames = []
    stop_event = threading.Event()

    def callback(indata, frame_count, time_info, status):
        if not stop_event.is_set():
            frames.append(indata.copy())

    print(f"  {C.RED}Recording...{C.RESET} Press ENTER when done.", flush=True)

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        callback=callback,
        blocksize=1024,
    )
    stream.start()
    input()  # Block until Enter
    stop_event.set()
    stream.stop()
    stream.close()

    if not frames:
        return np.array([], dtype=np.int16)

    return np.concatenate(frames).flatten()


# ── Setup ───────────────────────────────────────────────────────────────────

def setup_backboard(bb, force_reset=False):
    """Create Backboard assistant and ingest patient profile."""
    if ASSISTANT_FILE.exists() and not force_reset:
        assistant_id = ASSISTANT_FILE.read_text().strip()
        print(f"  Loaded existing assistant: {assistant_id}")
        return assistant_id

    print("  Creating Backboard assistant...")
    assistant = bb.create_assistant("Dementia Care - Abhishek Thomas", SYSTEM_PROMPT)
    assistant_id = assistant.get("assistant_id") or assistant.get("id")
    print(f"  Assistant created: {assistant_id}")

    ASSISTANT_FILE.write_text(assistant_id)

    if PATIENT_PROFILE_PATH.exists():
        print("  Ingesting patient profile into memory...")
        profile_text = PATIENT_PROFILE_PATH.read_text()

        thread = bb.create_thread(assistant_id)
        thread_id = thread.get("thread_id") or thread.get("id")

        chunk_size = 3000
        chunks = [profile_text[i : i + chunk_size] for i in range(0, len(profile_text), chunk_size)]

        for i, chunk in enumerate(chunks):
            print(f"  Ingesting chunk {i + 1}/{len(chunks)}...")
            bb.send_message(thread_id, chunk, memory="Auto", send_to_llm=False)
            time.sleep(0.5)

        print(f"  {C.GREEN}Patient profile ingested into memory!{C.RESET}")
    else:
        print(f"  {C.YELLOW}Warning: Patient profile not found at {PATIENT_PROFILE_PATH}{C.RESET}")

    return assistant_id


# ── Session Summary Display ─────────────────────────────────────────────────

def display_realtime_summary(conversation_log, session_duration, exchange_times=None):
    """Display per-message sentiment summary from the conversation."""
    num_exchanges = len(exchange_times) if exchange_times else 0

    print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")
    print(f"{C.BOLD}  SESSION SUMMARY (Real-time Analysis){C.RESET}")
    print(f"{C.BOLD}{'=' * 60}{C.RESET}")
    print(f"  Total Duration:    {format_time(session_duration)} ({session_duration:.1f}s)")
    print(f"  Exchanges:         {num_exchanges}")

    if exchange_times:
        avg_total = sum(e["total"] for e in exchange_times) / len(exchange_times)
        avg_stt = sum(e["stt"] for e in exchange_times) / len(exchange_times)
        avg_llm = sum(e["llm"] for e in exchange_times) / len(exchange_times)
        avg_tts = sum(e["tts"] for e in exchange_times) / len(exchange_times)
        avg_latency = sum(e["response_latency"] for e in exchange_times) / len(exchange_times)
        fastest = min(e["total"] for e in exchange_times)
        slowest = max(e["total"] for e in exchange_times)

        print(f"  Avg per exchange:  {avg_total:.1f}s")
        print(f"  Avg response time: {avg_latency:.1f}s {C.DIM}(STT + LLM, before TTS){C.RESET}")
        print(f"  Fastest exchange:  {fastest:.1f}s")
        print(f"  Slowest exchange:  {slowest:.1f}s")
        print()

        # Per-exchange timing breakdown
        print(f"  {C.BOLD}Exchange Timing Breakdown:{C.RESET}")
        print(f"  {'-' * 56}")
        print(f"  {'#':>3}  {'Record':>7}  {'STT':>6}  {'LLM':>6}  {'TTS':>6}  {'Total':>7}")
        print(f"  {'-' * 3}  {'-' * 7}  {'-' * 6}  {'-' * 6}  {'-' * 6}  {'-' * 7}")
        for e in exchange_times:
            print(
                f"  {e['exchange']:>3}  "
                f"{e['recording']:>6.1f}s  "
                f"{e['stt']:>5.1f}s  "
                f"{e['llm']:>5.1f}s  "
                f"{e['tts']:>5.1f}s  "
                f"{e['total']:>6.1f}s"
            )
        print(f"  {'-' * 3}  {'-' * 7}  {'-' * 6}  {'-' * 6}  {'-' * 6}  {'-' * 7}")
        print(
            f"  {'AVG':>3}  "
            f"{sum(e['recording'] for e in exchange_times) / len(exchange_times):>6.1f}s  "
            f"{avg_stt:>5.1f}s  "
            f"{avg_llm:>5.1f}s  "
            f"{avg_tts:>5.1f}s  "
            f"{avg_total:>6.1f}s"
        )

    print()

    # Per-message breakdown
    print(f"  {C.BOLD}Message-by-Message Sentiment:{C.RESET}")
    print(f"  {'-' * 56}")

    for entry in conversation_log:
        t = format_time(entry["time"])
        badge = sentiment_badge(entry["sentiment"], entry["confidence"])
        speaker_color = C.CYAN if entry["speaker"] == "patient" else C.MAGENTA
        speaker_label = "Patient" if entry["speaker"] == "patient" else "Sarah  "
        text_preview = entry["text"][:50] + ("..." if len(entry["text"]) > 50 else "")
        print(f"  {C.DIM}[{t}]{C.RESET} {speaker_color}{speaker_label}{C.RESET} {badge}")
        print(f"         {C.DIM}\"{text_preview}\"{C.RESET}")

    # Overall counts
    patient_msgs = [m for m in conversation_log if m["speaker"] == "patient"]
    if patient_msgs:
        pos = sum(1 for m in patient_msgs if m["sentiment"] == "positive")
        neg = sum(1 for m in patient_msgs if m["sentiment"] == "negative")
        neu = sum(1 for m in patient_msgs if m["sentiment"] == "neutral")
        crit = sum(1 for m in patient_msgs if m["sentiment"] == "CRITICAL")

        print(f"\n  {C.BOLD}Patient Sentiment Overview:{C.RESET}")
        print(f"  {'-' * 56}")
        if crit > 0:
            print(f"  {C.BG_RED}{C.WHITE}{C.BOLD}  CRITICAL: {crit}  {C.RESET}  !! Alert caretaker Ayush !!")
        print(f"  {C.GREEN}  Positive: {pos:>3}{C.RESET}  {'#' * pos}")
        print(f"  {C.YELLOW}  Neutral:  {neu:>3}{C.RESET}  {'#' * neu}")
        print(f"  {C.RED}  Negative: {neg:>3}{C.RESET}  {'#' * neg}")

        # Overall mood
        if crit > 0:
            overall = f"{C.BG_RED}{C.WHITE}{C.BOLD} ALERT - CRITICAL CONCERNS DETECTED {C.RESET}"
        elif neg > pos:
            overall = f"{C.RED}{C.BOLD} Patient seems to be feeling DOWN {C.RESET}"
        elif pos > neg:
            overall = f"{C.GREEN}{C.BOLD} Patient seems to be in GOOD spirits {C.RESET}"
        else:
            overall = f"{C.YELLOW}{C.BOLD} Patient mood is NEUTRAL {C.RESET}"

        print(f"\n  Overall Mood: {overall}")

    print(f"{C.BOLD}{'=' * 60}{C.RESET}")


def display_batch_sentiment(batch_result):
    """Display Speechmatics batch sentiment analysis results."""
    sa = batch_result.get("sentiment_analysis", {})
    summary_text = batch_result.get("summary", {}).get("content", "")
    segments = sa.get("segments", [])
    sa_summary = sa.get("summary", {})

    print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")
    print(f"{C.BOLD}  SPEECHMATICS POST-SESSION ANALYSIS{C.RESET}")
    print(f"{C.BOLD}{'=' * 60}{C.RESET}")

    # Per-segment sentiment from Speechmatics
    if segments:
        print(f"\n  {C.BOLD}Speechmatics Sentiment per Segment:{C.RESET}")
        print(f"  {'-' * 56}")
        for seg in segments:
            start = seg.get("start_time", 0)
            end = seg.get("end_time", 0)
            sentiment = seg.get("sentiment", "neutral")
            confidence = seg.get("confidence", 0)
            speaker = seg.get("speaker", "UU")
            text = seg.get("text", "")[:60]

            if sentiment == "negative":
                color = C.RED
            elif sentiment == "positive":
                color = C.GREEN
            else:
                color = C.YELLOW

            print(
                f"  {C.DIM}[{start:6.1f}s - {end:6.1f}s]{C.RESET} "
                f"{C.CYAN}{speaker:>3}{C.RESET} "
                f"{color}[{sentiment.upper():>8} {confidence:.0%}]{C.RESET}"
            )
            print(f"         {C.DIM}\"{text}\"{C.RESET}")

    # Overall sentiment counts
    overall = sa_summary.get("overall", {})
    speakers = sa_summary.get("speakers", [])

    if overall:
        pos_c = overall.get("positive_count", 0)
        neg_c = overall.get("negative_count", 0)
        neu_c = overall.get("neutral_count", 0)

        print(f"\n  {C.BOLD}Overall Sentiment (Speechmatics):{C.RESET}")
        print(f"  {'-' * 56}")
        print(f"  {C.GREEN}  Positive: {pos_c:>3}{C.RESET}  {'#' * min(pos_c, 40)}")
        print(f"  {C.YELLOW}  Neutral:  {neu_c:>3}{C.RESET}  {'#' * min(neu_c, 40)}")
        print(f"  {C.RED}  Negative: {neg_c:>3}{C.RESET}  {'#' * min(neg_c, 40)}")

    # Per-speaker breakdown
    if speakers:
        print(f"\n  {C.BOLD}Per-Speaker Sentiment:{C.RESET}")
        print(f"  {'-' * 56}")
        for sp in speakers:
            spk = sp.get("speaker", "UU")
            print(f"  Speaker {C.CYAN}{spk}{C.RESET}:")
            print(f"    {C.GREEN}Positive: {sp.get('positive_count', 0)}{C.RESET} | "
                  f"{C.YELLOW}Neutral: {sp.get('neutral_count', 0)}{C.RESET} | "
                  f"{C.RED}Negative: {sp.get('negative_count', 0)}{C.RESET}")

    # Conversation summary
    if summary_text:
        print(f"\n  {C.BOLD}Conversation Summary (Speechmatics):{C.RESET}")
        print(f"  {'-' * 56}")
        # Word-wrap the summary
        words = summary_text.split()
        line = "  "
        for word in words:
            if len(line) + len(word) + 1 > 58:
                print(line)
                line = "  " + word
            else:
                line += " " + word if line.strip() else "  " + word
        if line.strip():
            print(line)

    print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")


# ── Main Loops ──────────────────────────────────────────────────────────────

async def voice_loop(bb, thread_id):
    """Main voice conversation loop with sentiment tracking."""
    conversation_log = []
    audio_chunks = []
    exchange_times = []  # Per-exchange timing breakdown
    start_time = time.time()

    while True:
        # Record
        audio_data = record_audio()
        if audio_data is None:
            break

        if len(audio_data) < SAMPLE_RATE:  # Less than 1 second
            print("  (too short, try again)")
            continue

        # Save audio for post-session analysis
        audio_chunks.append(audio_data.copy())
        exchange_start = time.time()
        recording_duration = len(audio_data) / SAMPLE_RATE

        # STT
        elapsed = time.time() - start_time
        print(f"  {C.DIM}[{format_time(elapsed)}]{C.RESET} Transcribing...", flush=True)
        stt_start = time.time()
        try:
            text = await transcribe_audio(audio_data)
        except Exception as e:
            print(f"  STT error: {e}")
            continue
        stt_duration = time.time() - stt_start

        if not text:
            print("  (couldn't hear anything, try again)")
            continue

        # Sentiment analysis on patient's message
        sentiment, confidence = analyze_sentiment(text)
        badge = sentiment_badge(sentiment, confidence)

        elapsed = time.time() - start_time
        print(f"  {C.DIM}[{format_time(elapsed)}]{C.RESET} {C.CYAN}You:{C.RESET} {text}  {badge}")

        conversation_log.append({
            "time": elapsed,
            "speaker": "patient",
            "text": text,
            "sentiment": sentiment,
            "confidence": confidence,
        })

        # Critical alert
        if sentiment == "CRITICAL":
            print(f"\n  {C.BG_RED}{C.WHITE}{C.BOLD}  !! ALERT: Critical concern detected — notifying Ayush !!  {C.RESET}\n")

        # Send to Backboard
        print(f"  {C.DIM}[{format_time(time.time() - start_time)}]{C.RESET} Thinking...", flush=True)
        llm_start = time.time()
        try:
            response = bb.send_message(thread_id, text, memory="Auto", send_to_llm=True)
        except Exception as e:
            print(f"  Backboard error: {e}")
            continue
        llm_duration = time.time() - llm_start

        # Extract reply
        reply = (
            response.get("content")
            or response.get("message", {}).get("content")
            or response.get("text")
            or str(response)
        )

        # Sentiment on Sarah's response
        reply_sentiment, reply_confidence = analyze_sentiment(reply)
        reply_badge = sentiment_badge(reply_sentiment, reply_confidence)

        elapsed = time.time() - start_time
        print(f"  {C.DIM}[{format_time(elapsed)}]{C.RESET} {C.MAGENTA}Sarah:{C.RESET} {reply}  {reply_badge}")

        conversation_log.append({
            "time": elapsed,
            "speaker": "sarah",
            "text": reply,
            "sentiment": reply_sentiment,
            "confidence": reply_confidence,
        })

        # TTS
        tts_start = time.time()
        speak(reply)
        tts_duration = time.time() - tts_start

        exchange_total = time.time() - exchange_start

        # Log exchange timing
        exchange_times.append({
            "exchange": len(exchange_times) + 1,
            "recording": recording_duration,
            "stt": stt_duration,
            "llm": llm_duration,
            "tts": tts_duration,
            "total": exchange_total,
            "response_latency": stt_duration + llm_duration,  # time from stop talking to first audio
        })

        # Show per-exchange latency
        print(f"  {C.DIM}  latency: STT {stt_duration:.1f}s + LLM {llm_duration:.1f}s + TTS {tts_duration:.1f}s = {exchange_total:.1f}s total{C.RESET}")

    # Session ended
    session_duration = time.time() - start_time

    goodbye = "Goodbye Abhishek! Take care and have a wonderful day."
    print(f"\n  {C.MAGENTA}Sarah:{C.RESET} {goodbye}")
    speak(goodbye)

    # Display real-time summary
    if conversation_log:
        display_realtime_summary(conversation_log, session_duration, exchange_times)

    # Run Speechmatics batch sentiment analysis on full audio
    if audio_chunks:
        print(f"\n  {C.CYAN}Running Speechmatics post-session analysis...{C.RESET}")
        try:
            full_audio = np.concatenate(audio_chunks)
            wav_bytes = audio_to_wav_bytes(full_audio)
            print(f"  Submitting {len(full_audio) / SAMPLE_RATE:.1f}s of audio to Speechmatics batch...")
            job_id = submit_batch_sentiment_job(wav_bytes)
            print(f"  Job submitted: {job_id}. Waiting for results...")
            batch_result = poll_batch_job(job_id)
            display_batch_sentiment(batch_result)
        except Exception as e:
            print(f"  {C.YELLOW}Batch analysis error: {e}{C.RESET}")
            print(f"  {C.DIM}(Real-time analysis above is still valid){C.RESET}")


def text_loop(bb, thread_id):
    """Text-only conversation loop with sentiment tracking."""
    conversation_log = []
    exchange_times = []
    start_time = time.time()

    while True:
        elapsed = time.time() - start_time
        user_input = input(f"\n  {C.DIM}[{format_time(elapsed)}]{C.RESET} {C.CYAN}You:{C.RESET} ").strip()
        if not user_input or user_input.lower() in ("quit", "exit", "q"):
            break

        exchange_start = time.time()

        # Sentiment
        sentiment, confidence = analyze_sentiment(user_input)
        badge = sentiment_badge(sentiment, confidence)
        print(f"  {' ' * 9}{badge}")

        conversation_log.append({
            "time": elapsed,
            "speaker": "patient",
            "text": user_input,
            "sentiment": sentiment,
            "confidence": confidence,
        })

        if sentiment == "CRITICAL":
            print(f"\n  {C.BG_RED}{C.WHITE}{C.BOLD}  !! ALERT: Critical concern detected — notifying Ayush !!  {C.RESET}\n")

        # Backboard
        print(f"  {C.DIM}Thinking...{C.RESET}", flush=True)
        llm_start = time.time()
        try:
            response = bb.send_message(thread_id, user_input, memory="Auto", send_to_llm=True)
        except Exception as e:
            print(f"  Backboard error: {e}")
            continue
        llm_duration = time.time() - llm_start

        reply = (
            response.get("content")
            or response.get("message", {}).get("content")
            or response.get("text")
            or str(response)
        )

        reply_sentiment, reply_confidence = analyze_sentiment(reply)
        reply_badge = sentiment_badge(reply_sentiment, reply_confidence)

        elapsed = time.time() - start_time
        print(f"  {C.DIM}[{format_time(elapsed)}]{C.RESET} {C.MAGENTA}Sarah:{C.RESET} {reply}  {reply_badge}")

        conversation_log.append({
            "time": elapsed,
            "speaker": "sarah",
            "text": reply,
            "sentiment": reply_sentiment,
            "confidence": reply_confidence,
        })

        exchange_total = time.time() - exchange_start
        exchange_times.append({
            "exchange": len(exchange_times) + 1,
            "recording": 0,
            "stt": 0,
            "llm": llm_duration,
            "tts": 0,
            "total": exchange_total,
            "response_latency": llm_duration,
        })

        print(f"  {C.DIM}  latency: LLM {llm_duration:.1f}s = {exchange_total:.1f}s total{C.RESET}")

    # Summary
    session_duration = time.time() - start_time
    print(f"\n  {C.MAGENTA}Sarah:{C.RESET} Goodbye Abhishek! Take care and have a wonderful day.")

    if conversation_log:
        display_realtime_summary(conversation_log, session_duration, exchange_times)
        print(f"\n  {C.DIM}(Speechmatics batch analysis requires voice mode for audio){C.RESET}")


# ── Main ────────────────────────────────────────────────────────────────────

async def main():
    print(f"\n{C.BOLD}{'=' * 50}{C.RESET}")
    print(f"{C.BOLD}  Dementia Care Voice Agent Demo{C.RESET}")
    print(f"{C.BOLD}  Speechmatics (STT/TTS/Sentiment) + Backboard (Memory){C.RESET}")
    print(f"{C.BOLD}{'=' * 50}{C.RESET}\n")

    if not SPEECHMATICS_API_KEY:
        print(f"{C.RED}ERROR: SPEECHMATICS_API_KEY not found in .env{C.RESET}")
        sys.exit(1)
    if not BACKBOARD_API_KEY:
        print(f"{C.RED}ERROR: BACKBOARD_API_KEY not found in .env{C.RESET}")
        sys.exit(1)

    text_mode = "--text" in sys.argv
    force_reset = "--reset" in sys.argv

    # Setup
    bb = BackboardClient(BACKBOARD_API_KEY)
    assistant_id = setup_backboard(bb, force_reset=force_reset)

    # New conversation thread
    print("  Starting new conversation...")
    thread = bb.create_thread(assistant_id)
    thread_id = thread.get("thread_id") or thread.get("id")
    print(f"  Thread: {thread_id}")

    # Greeting
    greeting = "Hello Abhishek! It's Sarah. How are you doing today?"
    print(f"\n  {C.MAGENTA}Sarah:{C.RESET} {greeting}")

    if not text_mode:
        speak(greeting)
        print(f"\n  {C.DIM}[Voice mode — Press ENTER to record, ENTER to stop, 'quit' to exit]{C.RESET}")
        await voice_loop(bb, thread_id)
    else:
        print(f"\n  {C.DIM}[Text mode — type messages, 'quit' to exit]{C.RESET}")
        text_loop(bb, thread_id)

    print(f"\n  {C.GREEN}Session ended. Memories saved for next conversation.{C.RESET}\n")


if __name__ == "__main__":
    asyncio.run(main())
