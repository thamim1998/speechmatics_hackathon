import { useEffect, useState } from "react";
import {
  getAnalyticsSummary,
  getMemories,
  getTimeline,
  getTranscripts,
  getThreads,
  type Memory,
  type Thread,
  type TimelineMessage,
} from "./api/caretakerApi";
import NavBar, { type TabId } from "./components/NavBar";
import UpdatesTab from "./tabs/UpdatesTab";
import DashboardTab from "./tabs/DashboardTab";

function getPrimaryISO(msg: TimelineMessage) {
  const md = msg.metadata_ || {};
  return md.custom_timestamp || msg.timestamp || msg.created_at || "";
}

export default function CaretakerPortal() {
  const [tab, setTab] = useState<TabId>("updates");
  const [timeline, setTimeline] = useState<TimelineMessage[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [transcripts, setTranscripts] = useState<TimelineMessage[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [t, a, m, tr, th] = await Promise.all([
        getTimeline(),
        getAnalyticsSummary(),
        getMemories(),
        getTranscripts(),
        getThreads().catch(() => ({ ok: true, threads: [] })),
      ]);
      const msgs = (t.messages || []).slice().sort((m1, m2) => {
        const ts1 = new Date(getPrimaryISO(m1)).getTime() || 0;
        const ts2 = new Date(getPrimaryISO(m2)).getTime() || 0;
        return ts2 - ts1;
      });
      setTimeline(msgs);
      setSummary(a.summary);
      setMemories(m.memories || []);
      setTranscripts(tr.transcripts || []);
      setThreads(th.threads || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load caretaker data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <NavBar activeTab={tab} onTabChange={setTab} />

      <div style={{ display: tab === "updates" ? "block" : "none" }}>
        <UpdatesTab
          timeline={timeline}
          onRefresh={refresh}
          error={error}
          setError={setError}
        />
      </div>

      <div style={{ display: tab === "dashboard" ? "block" : "none" }}>
        <DashboardTab
          timeline={timeline}
          memories={memories}
          transcripts={transcripts}
          threads={threads}
          summary={summary}
          loading={loading}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
}
