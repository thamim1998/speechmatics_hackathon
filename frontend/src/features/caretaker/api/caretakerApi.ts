/**
 * Caretaker API client
 * Talks to backend endpoints:
 *   /api/caretaker/timeline
 *   /api/caretaker/event
 *   /api/caretaker/analytics/summary
 */

const SECRET = import.meta.env.VITE_CARETAKER_SECRET as string | undefined;

/**
 * Generic request wrapper
 */
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  if (!SECRET) {
    throw new Error(
      "VITE_CARETAKER_SECRET is missing. Add it to frontend/.env and restart Vite."
    );
  }

  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-CARETAKER-SECRET": SECRET,
    },
  });

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {}
    throw new Error(message);
  }

  return (await res.json()) as T;
}

/* ============================
   Types
============================ */

export type CaretakerEventType =
  | "note"
  | "sleep"
  | "mood"
  | "incident"
  | "medication"
  | "profile";

export interface TimelineMessage {
  message_id: string;
  role: string;
  content: string;
  created_at?: string;
  timestamp?: string;
  metadata_?: {
    source?: string;
    type?: string;
    custom_timestamp?: string;
    tags?: string[];
    data?: any;
  };
}

export interface TimelineResponse {
  ok: boolean;
  messages: TimelineMessage[];
}

// export interface AnalyticsSummaryResponse {
//   ok: boolean;
//   summary: {
//     countsByType: Record<string, number>;
//     countsBySource: Record<string, number>;
//     incidentsByDay: Record<string, number>;
//     avgSleepMinutesByDay: Record<string, number>;
//     flags: string[];
//   };
// }

export interface AnalyticsSummaryResponse {
    ok: boolean;
    summary: {
      // existing
      countsByType: Record<string, number>;
      countsBySource: Record<string, number>;
      incidentsByDay: Record<string, number>;
      avgSleepMinutesByDay: Record<string, number>;
      flags: string[];
  
      // NEW (backend will add)
      incidentCountsByType?: Record<string, number>;
  
      last7Days?: {
        fromISO: string;
        toISO: string;
        countsByType: Record<string, number>;
      };
  
      prev7Days?: {
        fromISO: string;
        toISO: string;
        countsByType: Record<string, number>;
      };
  
      delta7DaysByType?: Record<string, number>;
    };
  }

/* ============================
   API Methods
============================ */

export function getTimeline() {
  return request<TimelineResponse>("/api/caretaker/timeline");
}

export function addEvent(body: {
  type: CaretakerEventType;
  text?: string;
  timestampISO?: string;
  tags?: string[];
  data?: any;
}) {
  return request<{ ok: boolean }>("/api/caretaker/event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function getAnalyticsSummary() {
  return request<AnalyticsSummaryResponse>(
    "/api/caretaker/analytics/summary"
  );
}