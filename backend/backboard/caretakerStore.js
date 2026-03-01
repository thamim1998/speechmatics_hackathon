// // backend/backboard/caretakerStore.js
// import { BackboardClient } from './client.js';
// import { loadProfile, saveProfile } from "./profileState.js";
// import { buildPatientProfileDoc } from "./patientDocument.js";


// export class CaretakerStore {
//     constructor({ apiKey, threadId, assistantId }) {
//       this.client = new BackboardClient(apiKey);
//       this.threadId = threadId;
//       this.assistantId = assistantId;
//     }

// async addCaretakerEvent({ type, text, data = null, timestampISO = null, tags = [] }) {
//     const metadata = {
//       source: 'caretaker',
//       type,
//       ...(timestampISO ? { custom_timestamp: timestampISO } : {}),
//       ...(Array.isArray(tags) && tags.length ? { tags } : {}),
//       ...(data ? { data } : {}),
//     };
  
//     // Build readable content when caretaker didn't type anything
//     let content = (text || '').trim();
  
//     if (!content) {
//       if (type === 'mood') {
//         const mood = data?.mood ?? 'unknown';
//         const severity = data?.severity ?? '?';
//         content = `Mood: ${mood} (severity ${severity}/5)`;
//       } else if (type === 'incident') {
//         const incidentType = data?.incidentType ?? 'other';
//         const severity = data?.severity ?? '?';
//         content = `Incident: ${incidentType} (severity ${severity}/5)`;
//         if (data?.description) content += ` — ${data.description}`;
//       } else if (type === 'medication') {
//         const medication = data?.medication ?? 'unknown';
//         const taken = data?.taken === true ? 'taken' : 'missed';
//         content = `Medication: ${medication} (${taken})`;
//         if (data?.dose) content += `, dose ${data.dose}`;
//         if (data?.note) content += ` — ${data.note}`;
//       } else if (type === 'sleep') {
//         const duration = data?.durationMinutes ?? '?';
//         const wakeUps = data?.wakeUps ?? '?';
//         const quality = data?.quality ?? '?';
//         content = `Sleep: ${duration} min, wake-ups ${wakeUps}, quality ${quality}/5`;
//       } else if (data) {
//         // fallback
//         content = JSON.stringify(data);
//       } else {
//         content = '(no content)';
//       }
//     }
  
//     // return this.client.addMessage({
//     //   threadId: this.threadId,
//     //   content,
//     //   send_to_llm: false,
//     //   metadata,
//     // });
//     const saved = await this.client.addMessageJson({
//         threadId: this.threadId,
//         content,
//         send_to_llm: false,
//         metadata,
//         memory: "Auto", // ✅ key change: caretaker updates go to memory
//       });
      
//       // If caretaker is updating stable facts (profile), update doc + upload
//       if (type === "profile") {
//         const current = loadProfile();
      
//         // Prefer structured data for stable facts:
//         const next = {
//           ...current,
//           ...(data && typeof data === "object" ? data : {}),
//           ...(content ? { lastProfileNote: content } : {}),
//         };
      
//         saveProfile(next);
      
//         const filePath = buildPatientProfileDoc({ profileFacts: next });
      
//         await this.client.uploadAssistantDocument({
//           assistantId: this.assistantId,
//           filePath,
//         });
//       }
      
//       return saved;
//   }

//   async getTimeline() {
//     const thread = await this.client.getThread(this.threadId);
//     return thread.messages || [];
//   }
// }


// backend/backboard/caretakerStore.js
import { BackboardClient } from './client.js';
import { loadProfile, saveProfile } from "./profileState.js";
import { buildPatientProfileDoc } from "./patientDocument.js";


export class CaretakerStore {
    constructor({ apiKey, threadId, assistantId }) {
      this.client = new BackboardClient(apiKey);
      this.threadId = threadId;
      this.assistantId = assistantId;
    }

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
  
    // return this.client.addMessage({
    //   threadId: this.threadId,
    //   content,
    //   send_to_llm: false,
    //   metadata,
    // });
    const saved = await this.client.addMessageJson({
        threadId: this.threadId,
        content,
        send_to_llm: false,
        metadata,
        memory: "Auto", // ✅ key change: caretaker updates go to memory
      });
      
      // If caretaker is updating stable facts (profile), update doc + upload
      if (type === "profile") {
        const current = loadProfile();
      
        // Prefer structured data for stable facts:
        const next = {
          ...current,
          ...(data && typeof data === "object" ? data : {}),
          ...(content ? { lastProfileNote: content } : {}),
        };
      
        saveProfile(next);
      
        const filePath = buildPatientProfileDoc({ profileFacts: next });
      
        await this.client.uploadAssistantDocument({
          assistantId: this.assistantId,
          filePath,
        });
      }
      
      return saved;
  }

  async getTimeline() {
    const thread = await this.client.getThread(this.threadId);
    return thread.messages || [];
  }
}