import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Firebase client SDK
const firebaseConfig = JSON.parse(
  readFileSync(join(__dirname, 'adminsdkFirebase.json'), 'utf-8')
);
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// In-memory session store keyed by callSid
const sessions = new Map();

export function createSession(callSid, metadata = {}) {
  const session = {
    callSid,
    streamSid: null,
    messages: [],         // Claude conversation history [{role, content}]
    transcript: [],       // Timestamped log [{timestamp, speaker, text}]
    sttClient: null,
    isProcessing: false,
    currentUtterance: '',
    metadata,             // relationship, questions, contactName, etc.
    createdAt: new Date(),
  };
  sessions.set(callSid, session);
  console.log(`[session] Created session for call ${callSid}`);
  return session;
}

export function getSession(callSid) {
  return sessions.get(callSid);
}

export function addMessage(callSid, role, content) {
  const session = sessions.get(callSid);
  if (!session) return;
  session.messages.push({ role, content });
  session.transcript.push({
    timestamp: new Date().toISOString(),
    speaker: role === 'user' ? 'caller' : 'counsellor',
    text: content,
  });
}

export async function destroySession(callSid) {
  const session = sessions.get(callSid);
  if (!session) return;

  // Stop STT client if active
  if (session.sttClient) {
    try {
      session.sttClient.stopRecognition();
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  // Save transcript to Firestore
  try {
    const docRef = await addDoc(collection(db, 'call_transcripts'), {
      callSid: session.callSid,
      transcript: session.transcript,
      messages: session.messages,
      metadata: session.metadata,
      createdAt: session.createdAt.toISOString(),
      endedAt: new Date().toISOString(),
    });
    console.log(`[session] Transcript saved to Firestore: ${docRef.id}`);
  } catch (err) {
    console.error('[session] Failed to save transcript:', err.message);
  }

  sessions.delete(callSid);
  console.log(`[session] Destroyed session for call ${callSid}`);
}
