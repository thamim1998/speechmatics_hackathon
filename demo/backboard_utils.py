#!/usr/bin/env python3
"""
Backboard memory utilities.

Usage:
  uv run python backboard_utils.py <resource> <action>

Resources: memories, threads, documents

Actions:
  list          List all items
  count         Count items
  delete <id>   Delete a single item by ID
  wipe          Delete ALL items (with confirmation)
  wipe -y       Delete ALL items (skip confirmation)

Examples:
  uv run python backboard_utils.py memories list
  uv run python backboard_utils.py memories count
  uv run python backboard_utils.py memories delete abc-123
  uv run python backboard_utils.py memories wipe
  uv run python backboard_utils.py memories wipe -y

  uv run python backboard_utils.py threads list
  uv run python backboard_utils.py threads count
  uv run python backboard_utils.py threads delete abc-123
  uv run python backboard_utils.py threads wipe
  uv run python backboard_utils.py threads wipe -y

  uv run python backboard_utils.py documents list
  uv run python backboard_utils.py documents count
  uv run python backboard_utils.py documents delete abc-123
  uv run python backboard_utils.py documents wipe
  uv run python backboard_utils.py documents wipe -y

  uv run python backboard_utils.py all count        # Count everything
  uv run python backboard_utils.py all wipe          # Wipe everything
  uv run python backboard_utils.py all wipe -y       # Wipe everything (skip confirmation)

  uv run python backboard_utils.py reset             # Full reset: new assistant + re-upload patient profile
  uv run python backboard_utils.py reset -y          # Full reset (skip confirmation)
"""

import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY")
BACKBOARD_URL = "https://app.backboard.io/api"
ASSISTANT_FILE = Path(__file__).parent / ".livekit_assistant_id"


def get_assistant_id():
    if ASSISTANT_FILE.exists():
        return ASSISTANT_FILE.read_text().strip()
    print("No assistant found. Run the agent first to create one.")
    sys.exit(1)


def hdrs():
    return {"X-API-Key": BACKBOARD_API_KEY}


# ── Fetch helpers ──────────────────────────────────────────────────────────

def fetch_memories(aid):
    resp = requests.get(f"{BACKBOARD_URL}/assistants/{aid}/memories", headers=hdrs())
    resp.raise_for_status()
    return resp.json().get("memories", [])


def fetch_threads(aid):
    resp = requests.get(f"{BACKBOARD_URL}/assistants/{aid}/threads", headers=hdrs())
    resp.raise_for_status()
    data = resp.json()
    threads = data.get("threads", data) if isinstance(data, dict) else data
    return threads if isinstance(threads, list) else []


def fetch_documents(aid):
    resp = requests.get(f"{BACKBOARD_URL}/assistants/{aid}/documents", headers=hdrs())
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


# ── List ───────────────────────────────────────────────────────────────────

def list_memories():
    aid = get_assistant_id()
    memories = fetch_memories(aid)
    print(f"Total memories: {len(memories)}\n")
    for i, m in enumerate(memories, 1):
        content = m["content"][:100]
        created = m["created_at"][:16]
        mid = m["id"][:8]
        print(f"  {i:>3}. [{created}] ({mid}...) {content}")


def list_threads():
    aid = get_assistant_id()
    threads = fetch_threads(aid)
    print(f"Total threads: {len(threads)}\n")
    for i, t in enumerate(threads, 1):
        tid = t.get("thread_id") or t.get("id", "?")
        created = str(t.get("created_at", ""))[:16]
        print(f"  {i:>3}. [{created}] {tid}")


def list_documents():
    aid = get_assistant_id()
    docs = fetch_documents(aid)
    print(f"Total documents: {len(docs)}\n")
    for i, d in enumerate(docs, 1):
        did = d.get("document_id", "?")
        filename = d.get("filename", "unknown")
        status = d.get("status", "?")
        summary = d.get("summary", "")[:120]
        print(f"  {i:>3}. {filename} ({status})")
        print(f"       ID: {did}")
        if summary:
            print(f"       Summary: {summary}...")
        print()


# ── Count ──────────────────────────────────────────────────────────────────

def count_memories():
    aid = get_assistant_id()
    print(f"Memories: {len(fetch_memories(aid))}")


def count_threads():
    aid = get_assistant_id()
    print(f"Threads: {len(fetch_threads(aid))}")


def count_documents():
    aid = get_assistant_id()
    print(f"Documents: {len(fetch_documents(aid))}")


def count_all():
    aid = get_assistant_id()
    print(f"Memories:  {len(fetch_memories(aid))}")
    print(f"Threads:   {len(fetch_threads(aid))}")
    print(f"Documents: {len(fetch_documents(aid))}")


# ── Delete single ──────────────────────────────────────────────────────────

def delete_memory(memory_id):
    aid = get_assistant_id()
    resp = requests.delete(f"{BACKBOARD_URL}/assistants/{aid}/memories/{memory_id}", headers=hdrs())
    resp.raise_for_status()
    print(f"Deleted memory: {memory_id}")


def delete_thread(thread_id):
    aid = get_assistant_id()
    resp = requests.delete(f"{BACKBOARD_URL}/threads/{thread_id}", headers=hdrs())
    resp.raise_for_status()
    print(f"Deleted thread: {thread_id}")


def delete_document(document_id):
    aid = get_assistant_id()
    resp = requests.delete(f"{BACKBOARD_URL}/assistants/{aid}/documents/{document_id}", headers=hdrs())
    resp.raise_for_status()
    print(f"Deleted document: {document_id}")


# ── Wipe all ───────────────────────────────────────────────────────────────

def _confirm(resource_name, count):
    if count == 0:
        print(f"No {resource_name} to delete.")
        return False
    answer = input(f"Delete ALL {count} {resource_name}? This cannot be undone. (yes/no): ").strip().lower()
    return answer == "yes"


def wipe_memories(skip_confirm=False):
    aid = get_assistant_id()
    memories = fetch_memories(aid)
    total = len(memories)

    if total == 0:
        print("No memories to delete.")
        return

    print(f"Found {total} memories.")
    if not skip_confirm and not _confirm("memories", total):
        print("Cancelled.")
        return

    deleted = 0
    failed = 0
    for m in memories:
        mid = m["id"]
        content = m["content"][:60]
        try:
            r = requests.delete(f"{BACKBOARD_URL}/assistants/{aid}/memories/{mid}", headers=hdrs())
            r.raise_for_status()
            deleted += 1
            print(f"  [{deleted}/{total}] Deleted: {content}")
        except Exception:
            failed += 1
            print(f"  [{deleted + failed}/{total}] FAILED: {content}")

    print(f"\nMemories — Deleted: {deleted}, Failed: {failed}")


def wipe_threads(skip_confirm=False):
    aid = get_assistant_id()
    threads = fetch_threads(aid)
    total = len(threads)

    if total == 0:
        print("No threads to delete.")
        return

    print(f"Found {total} threads.")
    if not skip_confirm and not _confirm("threads", total):
        print("Cancelled.")
        return

    deleted = 0
    failed = 0
    for t in threads:
        tid = t.get("thread_id") or t.get("id")
        try:
            r = requests.delete(f"{BACKBOARD_URL}/threads/{tid}", headers=hdrs())
            r.raise_for_status()
            deleted += 1
            print(f"  [{deleted}/{total}] Deleted thread: {tid}")
        except Exception:
            failed += 1
            print(f"  [{deleted + failed}/{total}] FAILED thread: {tid}")

    print(f"\nThreads — Deleted: {deleted}, Failed: {failed}")


def wipe_documents(skip_confirm=False):
    aid = get_assistant_id()
    docs = fetch_documents(aid)
    total = len(docs)

    if total == 0:
        print("No documents to delete.")
        return

    print(f"Found {total} documents.")
    if not skip_confirm and not _confirm("documents", total):
        print("Cancelled.")
        return

    deleted = 0
    failed = 0
    for d in docs:
        did = d.get("document_id", d.get("id"))
        filename = d.get("filename", "?")
        try:
            r = requests.delete(f"{BACKBOARD_URL}/assistants/{aid}/documents/{did}", headers=hdrs())
            r.raise_for_status()
            deleted += 1
            print(f"  [{deleted}/{total}] Deleted: {filename}")
        except Exception:
            failed += 1
            print(f"  [{deleted + failed}/{total}] FAILED: {filename}")

    print(f"\nDocuments — Deleted: {deleted}, Failed: {failed}")


def wipe_all(skip_confirm=False):
    aid = get_assistant_id()
    m_count = len(fetch_memories(aid))
    t_count = len(fetch_threads(aid))
    d_count = len(fetch_documents(aid))
    total = m_count + t_count + d_count

    if total == 0:
        print("Nothing to delete.")
        return

    print(f"Found: {m_count} memories, {t_count} threads, {d_count} documents")
    if not skip_confirm:
        answer = input(f"Delete EVERYTHING ({total} items)? This cannot be undone. (yes/no): ").strip().lower()
        if answer != "yes":
            print("Cancelled.")
            return

    if m_count > 0:
        print(f"\n--- Wiping {m_count} memories ---")
        wipe_memories(skip_confirm=True)
    if t_count > 0:
        print(f"\n--- Wiping {t_count} threads ---")
        wipe_threads(skip_confirm=True)
    if d_count > 0:
        print(f"\n--- Wiping {d_count} documents ---")
        wipe_documents(skip_confirm=True)

    print("\nAll done.")


# ── Full Reset ─────────────────────────────────────────────────────────────

PATIENT_PROFILE_PATH = Path(__file__).parent / "patient_profile.md"

def full_reset(skip_confirm=False):
    """Create a brand new assistant, upload patient profile, clean slate."""
    if not skip_confirm:
        answer = input(
            "Full reset: creates a NEW assistant, uploads patient profile, "
            "abandons all old data.\nContinue? (yes/no): "
        ).strip().lower()
        if answer != "yes":
            print("Cancelled.")
            return

    # Wipe memories on old assistant (if exists)
    if ASSISTANT_FILE.exists():
        old_aid = ASSISTANT_FILE.read_text().strip()
        print(f"\nWiping memories on old assistant ({old_aid[:8]}...)...")
        try:
            memories = fetch_memories(old_aid)
            for m in memories:
                try:
                    requests.delete(
                        f"{BACKBOARD_URL}/assistants/{old_aid}/memories/{m['id']}",
                        headers=hdrs(),
                    )
                except Exception:
                    pass
            print(f"  Deleted {len(memories)} memories.")
        except Exception:
            print("  Could not wipe old memories (may not exist).")

    # Remove cached assistant IDs
    removed = []
    for f in [".livekit_assistant_id", ".assistant_id", ".pipecat_assistant_id"]:
        p = Path(__file__).parent / f
        if p.exists():
            p.unlink()
            removed.append(f)
    if removed:
        print(f"\nRemoved cached IDs: {', '.join(removed)}")

    # Create new assistant
    print("\nCreating new Backboard assistant...")
    resp = requests.post(
        f"{BACKBOARD_URL}/assistants",
        json={
            "name": "Dementia Care Memory Store",
            "system_prompt": (
                "You store and recall memories about a dementia patient from their "
                "voice companion sessions. When asked for a summary, include date, "
                "time, mood, topics discussed, and any concerns."
            ),
            "llm_provider": "openai",
            "llm_model_name": "gpt-4o-mini",
        },
        headers={**hdrs(), "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    new_aid = resp.json().get("assistant_id") or resp.json().get("id")
    ASSISTANT_FILE.write_text(new_aid)
    print(f"  New assistant: {new_aid}")

    # Upload patient profile
    if PATIENT_PROFILE_PATH.exists():
        print(f"\nUploading {PATIENT_PROFILE_PATH.name}...")
        with open(PATIENT_PROFILE_PATH, "rb") as f:
            resp = requests.post(
                f"{BACKBOARD_URL}/assistants/{new_aid}/documents",
                files={"file": ("patient_profile.md", f, "text/markdown")},
                headers=hdrs(),
            )
        resp.raise_for_status()
        doc_id = resp.json().get("document_id")
        print(f"  Uploaded: {doc_id}")
    else:
        print(f"\n  Warning: {PATIENT_PROFILE_PATH} not found, skipped upload.")

    # Verify
    print(f"\n--- New assistant state ---")
    print(f"  Memories:  {len(fetch_memories(new_aid))}")
    print(f"  Threads:   {len(fetch_threads(new_aid))}")
    print(f"  Documents: {len(fetch_documents(new_aid))}")
    print(f"\nFull reset complete. Ready for demo.")


# ── CLI ────────────────────────────────────────────────────────────────────

COMMANDS = {
    "memories": {
        "list": list_memories,
        "count": count_memories,
        "delete": delete_memory,
        "wipe": wipe_memories,
    },
    "threads": {
        "list": list_threads,
        "count": count_threads,
        "delete": delete_thread,
        "wipe": wipe_threads,
    },
    "documents": {
        "list": list_documents,
        "count": count_documents,
        "delete": delete_document,
        "wipe": wipe_documents,
    },
    "all": {
        "count": count_all,
        "wipe": wipe_all,
    },
}

if __name__ == "__main__":
    if not BACKBOARD_API_KEY:
        print("BACKBOARD_API_KEY not found in .env")
        sys.exit(1)

    args = sys.argv[1:]

    if len(args) < 2 or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        sys.exit(0)

    resource = args[0]

    # Handle reset as a standalone command
    if resource == "reset":
        full_reset(skip_confirm="-y" in args)
        sys.exit(0)

    if len(args) < 2:
        print(__doc__)
        sys.exit(1)

    action = args[1]

    if resource not in COMMANDS:
        print(f"Unknown resource: {resource}")
        print(f"Available: {', '.join(COMMANDS.keys())}, reset")
        sys.exit(1)

    if action not in COMMANDS[resource]:
        print(f"Unknown action '{action}' for {resource}")
        print(f"Available: {', '.join(COMMANDS[resource].keys())}")
        sys.exit(1)

    fn = COMMANDS[resource][action]

    if action == "delete":
        if len(args) < 3:
            print(f"Usage: backboard_utils.py {resource} delete <id>")
            sys.exit(1)
        fn(args[2])
    elif action == "wipe":
        fn(skip_confirm="-y" in args)
    else:
        fn()
