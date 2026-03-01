#!/usr/bin/env python3
"""
Dial out to a phone number and connect to the dementia care agent.

Usage:
  uv run python dial.py +330768975661
  uv run python dial.py +330768975661 --from +12282408374
"""

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from livekit import api

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

SIP_TRUNK_ID = "ST_UEGtvbzwRuwi"
DEFAULT_FROM = "+12282408374"


async def dial(phone_number: str, from_number: str = DEFAULT_FROM):
    lk = api.LiveKitAPI(
        os.getenv("LIVEKIT_URL"),
        os.getenv("LIVEKIT_API_KEY"),
        os.getenv("LIVEKIT_API_SECRET"),
    )

    print(f"Dialing {phone_number} from {from_number}...")
    print(f"SIP Trunk: {SIP_TRUNK_ID}")

    try:
        participant = await lk.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                sip_trunk_id=SIP_TRUNK_ID,
                sip_call_to=phone_number,
                sip_number=from_number,
                room_name=f"call-{phone_number.replace('+', '')}",
                participant_identity=f"phone-{phone_number.replace('+', '')}",
                participant_name="Patient",
            )
        )
        print(f"Call connected!")
        print(f"  Room: call-{phone_number.replace('+', '')}")
        print(f"  Participant: {participant.participant_identity}")
        print(f"  SIP Call ID: {participant.sip_call_id}")
        print(f"\nThe agent will join automatically via the dispatch rule.")
        print("Press Ctrl+C to hang up.")

        # Keep alive until interrupted
        while True:
            await asyncio.sleep(1)

    except KeyboardInterrupt:
        print("\nHanging up...")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await lk.aclose()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: uv run python dial.py <phone_number>")
        print("Example: uv run python dial.py +330768975661")
        sys.exit(1)

    phone = sys.argv[1]
    from_num = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--from" else DEFAULT_FROM

    asyncio.run(dial(phone, from_num))
