#!/usr/bin/env node
/**
 * Backboard memory utilities (Node.js port of demo/backboard_utils.py).
 *
 * Usage:
 *   node backboard-utils.js <resource> <action> [options]
 *
 * Resources: memories, threads, documents
 *
 * Actions:
 *   list          List all items
 *   count         Count items
 *   delete <id>   Delete a single item by ID
 *   wipe          Delete ALL items (with confirmation)
 *   wipe -y       Delete ALL items (skip confirmation)
 *
 * Special:
 *   all count     Count everything
 *   all wipe      Wipe everything
 *   all wipe -y   Wipe everything (skip confirmation)
 *   reset         Full reset: new assistant + upload patient profile
 *   reset -y      Full reset (skip confirmation)
 *
 * Examples:
 *   node backboard-utils.js memories list
 *   node backboard-utils.js memories count
 *   node backboard-utils.js memories delete abc-123
 *   node backboard-utils.js threads wipe -y
 *   node backboard-utils.js documents list
 *   node backboard-utils.js all count
 *   node backboard-utils.js reset
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { BackboardClient } from './backboard/client.js';
import { loadBackboardState, saveBackboardState } from './backboard/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKBOARD_API_KEY = process.env.BACKBOARD_API_KEY;
if (!BACKBOARD_API_KEY) {
  console.error('BACKBOARD_API_KEY not found in .env');
  process.exit(1);
}

const client = new BackboardClient(BACKBOARD_API_KEY);

function getAssistantId() {
  const state = loadBackboardState();
  if (state?.assistant_id) return state.assistant_id;
  console.error('No assistant found. Run the agent first to create one.');
  process.exit(1);
}

async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ── List ───────────────────────────────────────────────────────────

async function listMemories() {
  const aid = getAssistantId();
  const memories = await client.listMemories(aid);
  console.log(`Total memories: ${memories.length}\n`);
  memories.forEach((m, i) => {
    const content = m.content?.slice(0, 100) || '';
    const created = (m.created_at || '').slice(0, 16);
    const mid = (m.id || '').slice(0, 8);
    console.log(`  ${String(i + 1).padStart(3)}. [${created}] (${mid}...) ${content}`);
  });
}

async function listThreads() {
  const aid = getAssistantId();
  const threads = await client.listThreads(aid);
  console.log(`Total threads: ${threads.length}\n`);
  threads.forEach((t, i) => {
    const tid = t.thread_id || t.id || '?';
    const created = String(t.created_at || '').slice(0, 16);
    console.log(`  ${String(i + 1).padStart(3)}. [${created}] ${tid}`);
  });
}

async function listDocuments() {
  const aid = getAssistantId();
  const docs = await client.listDocuments(aid);
  console.log(`Total documents: ${docs.length}\n`);
  docs.forEach((d, i) => {
    const did = d.document_id || '?';
    const filename = d.filename || 'unknown';
    const status = d.status || '?';
    const summary = (d.summary || '').slice(0, 120);
    console.log(`  ${String(i + 1).padStart(3)}. ${filename} (${status})`);
    console.log(`       ID: ${did}`);
    if (summary) console.log(`       Summary: ${summary}...`);
    console.log();
  });
}

// ── Count ──────────────────────────────────────────────────────────

async function countMemories() {
  const aid = getAssistantId();
  console.log(`Memories: ${(await client.listMemories(aid)).length}`);
}

async function countThreads() {
  const aid = getAssistantId();
  console.log(`Threads: ${(await client.listThreads(aid)).length}`);
}

async function countDocuments() {
  const aid = getAssistantId();
  console.log(`Documents: ${(await client.listDocuments(aid)).length}`);
}

async function countAll() {
  const aid = getAssistantId();
  const [m, t, d] = await Promise.all([
    client.listMemories(aid),
    client.listThreads(aid),
    client.listDocuments(aid),
  ]);
  console.log(`Memories:  ${m.length}`);
  console.log(`Threads:   ${t.length}`);
  console.log(`Documents: ${d.length}`);
}

// ── Delete single ──────────────────────────────────────────────────

async function deleteMemory(memoryId) {
  const aid = getAssistantId();
  await client.deleteMemory(aid, memoryId);
  console.log(`Deleted memory: ${memoryId}`);
}

async function deleteThread(threadId) {
  await client.deleteThread(threadId);
  console.log(`Deleted thread: ${threadId}`);
}

async function deleteDocument(documentId) {
  const aid = getAssistantId();
  await client.deleteDocument(aid, documentId);
  console.log(`Deleted document: ${documentId}`);
}

// ── Wipe all ───────────────────────────────────────────────────────

async function wipeMemories(skipConfirm = false) {
  const aid = getAssistantId();
  const memories = await client.listMemories(aid);
  if (memories.length === 0) { console.log('No memories to delete.'); return; }

  console.log(`Found ${memories.length} memories.`);
  if (!skipConfirm && !(await confirm(`Delete ALL ${memories.length} memories? This cannot be undone. (yes/no): `))) {
    console.log('Cancelled.'); return;
  }

  let deleted = 0, failed = 0;
  for (const m of memories) {
    try {
      await client.deleteMemory(aid, m.id);
      deleted++;
      console.log(`  [${deleted}/${memories.length}] Deleted: ${(m.content || '').slice(0, 60)}`);
    } catch {
      failed++;
      console.log(`  [${deleted + failed}/${memories.length}] FAILED: ${(m.content || '').slice(0, 60)}`);
    }
  }
  console.log(`\nMemories — Deleted: ${deleted}, Failed: ${failed}`);
}

async function wipeThreads(skipConfirm = false) {
  const aid = getAssistantId();
  const threads = await client.listThreads(aid);
  if (threads.length === 0) { console.log('No threads to delete.'); return; }

  console.log(`Found ${threads.length} threads.`);
  if (!skipConfirm && !(await confirm(`Delete ALL ${threads.length} threads? This cannot be undone. (yes/no): `))) {
    console.log('Cancelled.'); return;
  }

  let deleted = 0, failed = 0;
  for (const t of threads) {
    const tid = t.thread_id || t.id;
    try {
      await client.deleteThread(tid);
      deleted++;
      console.log(`  [${deleted}/${threads.length}] Deleted thread: ${tid}`);
    } catch {
      failed++;
      console.log(`  [${deleted + failed}/${threads.length}] FAILED thread: ${tid}`);
    }
  }
  console.log(`\nThreads — Deleted: ${deleted}, Failed: ${failed}`);
}

async function wipeDocuments(skipConfirm = false) {
  const aid = getAssistantId();
  const docs = await client.listDocuments(aid);
  if (docs.length === 0) { console.log('No documents to delete.'); return; }

  console.log(`Found ${docs.length} documents.`);
  if (!skipConfirm && !(await confirm(`Delete ALL ${docs.length} documents? This cannot be undone. (yes/no): `))) {
    console.log('Cancelled.'); return;
  }

  let deleted = 0, failed = 0;
  for (const d of docs) {
    const did = d.document_id || d.id;
    try {
      await client.deleteDocument(aid, did);
      deleted++;
      console.log(`  [${deleted}/${docs.length}] Deleted: ${d.filename || '?'}`);
    } catch {
      failed++;
      console.log(`  [${deleted + failed}/${docs.length}] FAILED: ${d.filename || '?'}`);
    }
  }
  console.log(`\nDocuments — Deleted: ${deleted}, Failed: ${failed}`);
}

async function wipeAll(skipConfirm = false) {
  const aid = getAssistantId();
  const [memories, threads, docs] = await Promise.all([
    client.listMemories(aid),
    client.listThreads(aid),
    client.listDocuments(aid),
  ]);
  const total = memories.length + threads.length + docs.length;

  if (total === 0) { console.log('Nothing to delete.'); return; }

  console.log(`Found: ${memories.length} memories, ${threads.length} threads, ${docs.length} documents`);
  if (!skipConfirm && !(await confirm(`Delete EVERYTHING (${total} items)? This cannot be undone. (yes/no): `))) {
    console.log('Cancelled.'); return;
  }

  if (memories.length > 0) { console.log(`\n--- Wiping ${memories.length} memories ---`); await wipeMemories(true); }
  if (threads.length > 0) { console.log(`\n--- Wiping ${threads.length} threads ---`); await wipeThreads(true); }
  if (docs.length > 0) { console.log(`\n--- Wiping ${docs.length} documents ---`); await wipeDocuments(true); }

  console.log('\nAll done.');
}

// ── Full Reset ─────────────────────────────────────────────────────

async function fullReset(skipConfirm = false) {
  if (!skipConfirm && !(await confirm(
    'Full reset: creates a NEW assistant, uploads patient profile, abandons all old data.\nContinue? (yes/no): '
  ))) {
    console.log('Cancelled.'); return;
  }

  // Wipe memories on old assistant if exists
  const oldState = loadBackboardState();
  if (oldState?.assistant_id) {
    console.log(`\nWiping memories on old assistant (${oldState.assistant_id.slice(0, 8)}...)...`);
    try {
      const memories = await client.listMemories(oldState.assistant_id);
      for (const m of memories) {
        try { await client.deleteMemory(oldState.assistant_id, m.id); } catch {}
      }
      console.log(`  Deleted ${memories.length} memories.`);
    } catch {
      console.log('  Could not wipe old memories (may not exist).');
    }
  }

  // Create new assistant
  console.log('\nCreating new Backboard assistant...');
  const assistant = await client.createAssistant({
    name: 'Dementia Care Memory Store',
    system_prompt: 'You store and recall memories about a dementia patient from their voice companion sessions. When asked for a summary, include date, time, mood, topics discussed, and any concerns.',
  });
  const newAid = assistant.assistant_id || assistant.id;
  console.log(`  New assistant: ${newAid}`);

  // Create thread
  const thread = await client.createThread(newAid);
  const newTid = thread.thread_id || thread.id;

  // Save state
  saveBackboardState({
    assistant_id: newAid,
    thread_id: newTid,
    created_at: new Date().toISOString(),
  });

  // Upload patient profile
  const profilePath = path.join(__dirname, 'patient_profile.md');
  if (fs.existsSync(profilePath)) {
    console.log('\nUploading patient_profile.md...');
    const profileBuffer = fs.readFileSync(profilePath);
    const doc = await client.uploadDocument(newAid, 'patient_profile.md', profileBuffer);
    console.log(`  Uploaded: ${doc.document_id || doc.id}`);
  } else {
    console.log(`\n  Warning: ${profilePath} not found, skipped upload.`);
  }

  // Verify
  const [m, t, d] = await Promise.all([
    client.listMemories(newAid),
    client.listThreads(newAid),
    client.listDocuments(newAid),
  ]);
  console.log('\n--- New assistant state ---');
  console.log(`  Memories:  ${m.length}`);
  console.log(`  Threads:   ${t.length}`);
  console.log(`  Documents: ${d.length}`);
  console.log('\nFull reset complete. Ready for demo.');
}

// ── CLI ────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node backboard-utils.js <resource> <action> [options]

Resources: memories, threads, documents, all
Actions: list, count, delete <id>, wipe [-y]
Special: reset [-y]`;

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
  console.log(USAGE);
  process.exit(0);
}

const resource = args[0];

// Handle reset as standalone command
if (resource === 'reset') {
  await fullReset(args.includes('-y'));
  process.exit(0);
}

if (args.length < 2) {
  console.log(USAGE);
  process.exit(1);
}

const action = args[1];
const skipY = args.includes('-y');

const COMMANDS = {
  memories: { list: listMemories, count: countMemories, delete: deleteMemory, wipe: wipeMemories },
  threads:  { list: listThreads,  count: countThreads,  delete: deleteThread,  wipe: wipeThreads },
  documents:{ list: listDocuments, count: countDocuments, delete: deleteDocument, wipe: wipeDocuments },
  all:      { count: countAll, wipe: wipeAll },
};

if (!COMMANDS[resource]) {
  console.error(`Unknown resource: ${resource}`);
  console.error(`Available: ${Object.keys(COMMANDS).join(', ')}, reset`);
  process.exit(1);
}

if (!COMMANDS[resource][action]) {
  console.error(`Unknown action '${action}' for ${resource}`);
  console.error(`Available: ${Object.keys(COMMANDS[resource]).join(', ')}`);
  process.exit(1);
}

if (action === 'delete') {
  if (args.length < 3) {
    console.error(`Usage: backboard-utils.js ${resource} delete <id>`);
    process.exit(1);
  }
  await COMMANDS[resource][action](args[2]);
} else if (action === 'wipe') {
  await COMMANDS[resource][action](skipY);
} else {
  await COMMANDS[resource][action]();
}
