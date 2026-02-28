// backend/backboard/caretakerStore.js
import { BackboardClient } from './client.js';

export class CaretakerStore {
  constructor({ apiKey, threadId }) {
    this.client = new BackboardClient(apiKey);
    this.threadId = threadId;
  }

//   async addCaretakerEvent({ type, text, data = null, timestampISO = null, tags = [] }) {
//     const metadata = {
//       source: 'caretaker',
//       type, // note | incident | sleep | mood | medication | profile
//       ...(timestampISO ? { custom_timestamp: timestampISO } : {}),
//       ...(Array.isArray(tags) && tags.length ? { tags } : {}),
//       ...(data ? { data } : {}),
//     };

//     // const content = text || (data ? JSON.stringify(data) : '');
//     let content = text;

// if (!content && type === 'mood') {
//   content = `Mood: ${data?.mood ?? 'unknown'} (severity ${data?.severity ?? '?'}/5)`;
// } else if (!content && type === 'incident') {
//   content = `Incident: ${data?.incidentType ?? 'unknown'} (severity ${data?.severity ?? '?'}/5)`;
//   if (data?.description) content += ` — ${data.description}`;
// } else if (!content && type === 'medication') {
//   content = `Medication: ${data?.medication ?? 'unknown'} (${data?.taken ? 'taken' : 'missed'})`;
//   if (data?.dose) content += `, dose ${data.dose}`;
//   if (data?.note) content += ` — ${data.note}`;
// } else if (!content && data) {
//   content = JSON.stringify(data);
// }

//     return this.client.addMessage({
//       threadId: this.threadId,
//       content,
//       send_to_llm: false, // store only
//       metadata,
//     });
//   }

async addCaretakerEvent({ type, text, data = null, timestampISO = null, tags = [] }) {
    const metadata = {
      source: 'caretaker',
      type,
      ...(timestampISO ? { custom_timestamp: timestampISO } : {}),
      ...(Array.isArray(tags) && tags.length ? { tags } : {}),
      ...(data ? { data } : {}),
    };
  
    // Build readable content when caretaker didn't type anything
    let content = (text || '').trim();
  
    if (!content) {
      if (type === 'mood') {
        const mood = data?.mood ?? 'unknown';
        const severity = data?.severity ?? '?';
        content = `Mood: ${mood} (severity ${severity}/5)`;
      } else if (type === 'incident') {
        const incidentType = data?.incidentType ?? 'other';
        const severity = data?.severity ?? '?';
        content = `Incident: ${incidentType} (severity ${severity}/5)`;
        if (data?.description) content += ` — ${data.description}`;
      } else if (type === 'medication') {
        const medication = data?.medication ?? 'unknown';
        const taken = data?.taken === true ? 'taken' : 'missed';
        content = `Medication: ${medication} (${taken})`;
        if (data?.dose) content += `, dose ${data.dose}`;
        if (data?.note) content += ` — ${data.note}`;
      } else if (type === 'sleep') {
        const duration = data?.durationMinutes ?? '?';
        const wakeUps = data?.wakeUps ?? '?';
        const quality = data?.quality ?? '?';
        content = `Sleep: ${duration} min, wake-ups ${wakeUps}, quality ${quality}/5`;
      } else if (data) {
        // fallback
        content = JSON.stringify(data);
      } else {
        content = '(no content)';
      }
    }
  
    return this.client.addMessage({
      threadId: this.threadId,
      content,
      send_to_llm: false,
      metadata,
    });
  }

  async getTimeline() {
    const thread = await this.client.getThread(this.threadId);
    return thread.messages || [];
  }
}