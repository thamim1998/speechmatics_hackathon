import { useMemo, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { getTimeline, getMemories, type Memory, type Thread, type TimelineMessage } from "../api/caretakerApi";
import { jsPDF } from "jspdf";

function getMeta(msg: TimelineMessage) { return msg.metadata_ || {}; }
function getPrimaryISO(msg: TimelineMessage) { const md = getMeta(msg); return md.custom_timestamp || msg.timestamp || msg.created_at || ""; }
function getType(msg: TimelineMessage) { return (getMeta(msg).type || "unknown") as string; }

function timeAgo(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "Positive", neutral: "Neutral", negative: "Negative", CRITICAL: "Critical",
};

/* ── Dummy trend data for recent 7 days ── */
function buildDummyDays() {
  const days: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  return days;
}

function buildMemoryTrend() {
  const days = buildDummyDays();
  const scores = [62, 68, 65, 72, 70, 75, 78];
  return days.map((day, i) => ({ day, score: scores[i] }));
}

function buildSentimentTrend() {
  const days = buildDummyDays();
  const data = [
    { positive: 40, neutral: 45, negative: 15 },
    { positive: 50, neutral: 35, negative: 15 },
    { positive: 35, neutral: 45, negative: 20 },
    { positive: 55, neutral: 35, negative: 10 },
    { positive: 60, neutral: 30, negative: 10 },
    { positive: 65, neutral: 25, negative: 10 },
    { positive: 70, neutral: 25, negative: 5 },
  ];
  return days.map((day, i) => ({ day, ...data[i] }));
}

interface DashboardTabProps {
  timeline: TimelineMessage[];
  memories: Memory[];
  transcripts: TimelineMessage[];
  threads: Thread[];
  summary: any;
  loading: boolean;
  onRefresh: () => Promise<void>;
}

export default function DashboardTab({ timeline, memories, transcripts, threads, summary, loading, onRefresh }: DashboardTabProps) {
  const [downloading, setDownloading] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [modalThread, setModalThread] = useState<(Thread & { conversation: { role: string; content: string }[]; summaryText: string; sentimentLabel: string; duration: string }) | null>(null);

  const handleRefresh = async () => { await onRefresh(); setRefreshMsg("Up to date"); setTimeout(() => setRefreshMsg(""), 2000); };

  const memoryScore = 75;
  const memoryTrend = useMemo(() => buildMemoryTrend(), []);
  const sentimentTrend = useMemo(() => buildSentimentTrend(), []);
  const currentSentiment = "positive";

  // Check if a message is an internal/system message that should be hidden
  function isInternalMsg(content: string) {
    const c = content.toLowerCase().trim();
    if (c.startsWith("you are megan") || c.startsWith("you are sarah")) return true;
    if (c.includes("personality:") && c.includes("voice call")) return true;
    if (c.includes("communication rules:") && c.includes("conversation goals:")) return true;
    if (c.startsWith("session on ") && c.includes("overall sentiment:") && c.includes("caretaker summary:")) return true;
    return false;
  }

  // Parse actual conversation transcript from "Generate a brief caretaker summary" messages
  // These contain lines like: [18s] megan: Hello, Abhishek! ... [23s] patient: I'm great ...
  function parseTranscript(content: string): { role: string; content: string }[] {
    const convoMatch = content.match(/Conversation:\s*([\s\S]+?)(?:Include:|$)/i);
    if (!convoMatch) return [];
    const lines = convoMatch[1].trim().split(/\[(\d+)s\]\s*/);
    const parsed: { role: string; content: string }[] = [];
    for (let i = 1; i < lines.length; i += 2) {
      const text = (lines[i + 1] || "").trim();
      if (!text) continue;
      const colonIdx = text.indexOf(":");
      if (colonIdx < 0) continue;
      const speaker = text.slice(0, colonIdx).trim().toLowerCase();
      let msg = text.slice(colonIdx + 1).trim();
      // Remove trailing sentiment tags like [positive] [neutral]
      msg = msg.replace(/\s*\[(positive|negative|neutral|CRITICAL)\]\s*$/i, "").trim();
      const role = (speaker === "patient" || speaker === "abhishek") ? "user" : "assistant";
      if (msg) parsed.push({ role, content: msg });
    }
    return parsed;
  }

  // Process a thread: extract real conversation + summary
  function processThread(t: Thread) {
    const msgs = t.messages || [];
    let conversation: { role: string; content: string }[] = [];
    let summaryText = "";
    let sentimentLabel = "";
    let duration = "";

    for (const m of msgs) {
      const c = (m.content || "").trim();
      const cl = c.toLowerCase();

      // Skip system role
      if (m.role === "system") continue;
      // Skip system prompt injections
      if (isInternalMsg(c)) continue;

      // Parse transcript from summary request messages
      if (cl.startsWith("generate a brief caretaker summary")) {
        const parsed = parseTranscript(c);
        if (parsed.length > 0) conversation = parsed;
        // Extract sentiment and duration
        const sentMatch = c.match(/Overall sentiment:\s*(\w+)/i);
        if (sentMatch) sentimentLabel = sentMatch[1];
        const durMatch = c.match(/Duration:\s*(\d+)\s*seconds/i);
        if (durMatch) duration = `${durMatch[1]}s`;
        continue;
      }

      // Summary response from assistant (contains **Date:** or **Caretaker Summary:**)
      if (m.role === "assistant" && (cl.includes("**summary:**") || cl.includes("**overall mood:**") || cl.includes("**caretaker summary:**"))) {
        summaryText = c;
        // Extract sentiment from summary too
        const moodMatch = c.match(/Overall (?:Mood|Sentiment)[:\*]*\s*(\w+)/i);
        if (moodMatch && !sentimentLabel) sentimentLabel = moodMatch[1];
        continue;
      }

      // Regular conversation message (user <-> assistant)
      if (m.role === "user" || m.role === "assistant") {
        // Only add if conversation wasn't already parsed from transcript
        if (conversation.length === 0) {
          conversation.push({ role: m.role, content: c });
        }
      }
    }

    return { conversation, summaryText, sentimentLabel, duration };
  }

  // Threads sorted by most recent, processed
  const recentThreads = useMemo(() => {
    return threads
      .map((t) => {
        const processed = processThread(t);
        return { ...t, ...processed };
      })
      .filter((t) => t.conversation.length > 0 || t.summaryText)
      .sort((a, b) => {
        const da = new Date(b.updated_at || b.created_at || "").getTime() || 0;
        const db = new Date(a.updated_at || a.created_at || "").getTime() || 0;
        return da - db;
      })
      .slice(0, 10);
  }, [threads]);

  const recentMemories = useMemo(() => {
    return memories
      .filter((m) => {
        const l = m.content.toLowerCase();
        return !l.startsWith("user is sarah") && !l.startsWith("user is megan") && !l.startsWith("megan ") && !l.startsWith("megan's ") && !l.startsWith("sarah ") && !l.startsWith("sarah's ");
      })
      .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())
      .slice(0, 10);
  }, [memories]);

  const stats = useMemo(() => {
    if (!summary) return null;
    const countsByType: Record<string, number> = summary.countsByType || {};
    const totalEntries = Object.values(countsByType).reduce((a: number, b: any) => a + (b as number), 0);
    const totalIncidents = (summary.incidentCountsByType ? Object.values(summary.incidentCountsByType).reduce((a: number, b: any) => a + (b as number), 0) : countsByType.incident || 0) as number;
    const avgSleepByDay: Record<string, number> = summary.avgSleepMinutesByDay || {};
    const sleepDays = Object.entries(avgSleepByDay).sort((a, b) => b[0].localeCompare(a[0]));
    const latestSleep = sleepDays.length > 0 ? sleepDays[0][1] : null;
    const flags: string[] = summary.flags || [];
    return { totalEntries, totalIncidents, latestSleep, flags, memoriesCount: memories.length, countsByType };
  }, [summary, memories]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const [tlData, memData] = await Promise.all([getTimeline(), getMemories()]);
      const entries = (tlData.messages || []).sort((a, b) => new Date(getPrimaryISO(b)).getTime() - new Date(getPrimaryISO(a)).getTime());
      const patientMemories = (memData.memories || []).filter((m) => { const l = m.content.toLowerCase(); return !l.startsWith("user is sarah") && !l.startsWith("user is megan") && !l.startsWith("megan ") && !l.startsWith("megan's ") && !l.startsWith("sarah ") && !l.startsWith("sarah's "); });
      const seen = new Set<string>();
      const uniqueMemories = patientMemories.filter((m) => { const k = m.content.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; });
      if (entries.length === 0 && uniqueMemories.length === 0) { alert("No data to download."); return; }
      const nameMemory = uniqueMemories.find((m) => m.content.toLowerCase().includes("name is "));
      let personName = "Abhishek";
      if (nameMemory) { const match = nameMemory.content.match(/name is (\w+)/i); if (match) personName = match[1]; }

      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const W = pdf.internal.pageSize.getWidth(); const H = pdf.internal.pageSize.getHeight();
      const margin = 20; const contentW = W - margin * 2; let y = 0;
      const ensureSpace = (needed: number) => { if (y + needed > H - margin) { pdf.addPage(); y = margin; } };

      pdf.setFillColor(44, 42, 39); pdf.rect(0, 0, W, 52, "F");
      pdf.setFillColor(224, 122, 95); pdf.rect(0, 52, W, 2, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(22); pdf.setTextColor(255, 255, 255);
      const dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      pdf.text(`${personName}'s Care Report — ${dateStr}`, margin, 26);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(200, 195, 190);
      pdf.text(`${entries.length} timeline entries  •  ${uniqueMemories.length} memories  •  Memory Score: ${memoryScore}/100`, margin, 38);
      y = 66;

      /* ── Summary Scores Section ── */
      ensureSpace(50);
      pdf.setFillColor(255, 243, 237); pdf.roundedRect(margin, y - 3, contentW, 42, 3, 3, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.setTextColor(224, 122, 95);
      pdf.text("Dashboard Summary", margin + 6, y + 5); y += 14;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(60, 55, 50);
      const summaryLines = [
        `Memory Score: ${memoryScore}/100    |    Sentiment: ${SENTIMENT_LABEL[currentSentiment] || "Neutral"}    |    Memories: ${uniqueMemories.length}`,
        `Total Entries: ${entries.length}    |    Current Trend: Improving`,
      ];
      summaryLines.forEach((line) => { pdf.text(line, margin + 6, y); y += 6; });
      y += 6;

      /* ── Memory Trend Table ── */
      ensureSpace(35);
      pdf.setFillColor(240, 253, 244); pdf.roundedRect(margin, y - 3, contentW, 30, 3, 3, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(22, 163, 74);
      pdf.text("Memory Trend (Last 7 Days)", margin + 6, y + 5); y += 12;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(60, 55, 50);
      const mTrend = buildMemoryTrend();
      pdf.text(mTrend.map((d) => d.day).join("    "), margin + 6, y); y += 5;
      pdf.setFont("helvetica", "bold");
      pdf.text(mTrend.map((d) => String(d.score)).join("      "), margin + 6, y); y += 8;

      /* ── Sentiment Trend Table ── */
      ensureSpace(40);
      pdf.setFillColor(254, 249, 235); pdf.roundedRect(margin, y - 3, contentW, 35, 3, 3, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(202, 138, 4);
      pdf.text("Sentiment Trend (Last 7 Days)", margin + 6, y + 5); y += 12;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(60, 55, 50);
      const sTrend = buildSentimentTrend();
      pdf.text(sTrend.map((d) => d.day).join("    "), margin + 6, y); y += 5;
      pdf.setTextColor(22, 163, 74); pdf.text("Pos:  " + sTrend.map((d) => `${d.positive}%`).join("   "), margin + 6, y); y += 4;
      pdf.setTextColor(202, 138, 4); pdf.text("Neu:  " + sTrend.map((d) => `${d.neutral}%`).join("   "), margin + 6, y); y += 4;
      pdf.setTextColor(220, 38, 38); pdf.text("Neg:  " + sTrend.map((d) => `${d.negative}%`).join("   "), margin + 6, y); y += 8;

      if (uniqueMemories.length > 0) {
        ensureSpace(20); pdf.setFillColor(254, 243, 239); pdf.roundedRect(margin, y - 3, contentW, 12, 3, 3, "F");
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.setTextColor(224, 122, 95);
        pdf.text(`What Megan Knows About ${personName}`, margin + 6, y + 5); y += 16;
        uniqueMemories.forEach((m) => { const lines = pdf.setFont("helvetica", "normal").setFontSize(10).splitTextToSize(`• ${m.content}`, contentW - 10); const bH = lines.length * 5 + 2; ensureSpace(bH + 2); pdf.setTextColor(60, 55, 50); pdf.text(lines, margin + 6, y); y += bH + 1; });
        y += 8;
      }
      if (entries.length > 0) {
        ensureSpace(20); pdf.setFillColor(245, 243, 240); pdf.roundedRect(margin, y - 3, contentW, 12, 3, 3, "F");
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.setTextColor(44, 42, 39);
        pdf.text("Caretaker Timeline", margin + 6, y + 5); y += 16;
        entries.forEach((entry, idx) => {
          const md = getMeta(entry); const eType = (md.type || "note").toUpperCase(); const ts = getPrimaryISO(entry); const timeStr = ts ? new Date(ts).toLocaleString() : "";
          ensureSpace(18); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(44, 42, 39); pdf.text(`[${eType}]`, margin + 6, y);
          pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(140, 135, 130); pdf.text(timeStr, W - margin, y, { align: "right" }); y += 6;
          const content = entry.content || "";
          if (content) { const lines = pdf.setFont("helvetica", "normal").setFontSize(10).splitTextToSize(content, contentW - 12); const bH = lines.length * 5 + 7; ensureSpace(bH + 4); pdf.setFillColor(250, 248, 245); pdf.setDrawColor(230, 225, 220); pdf.roundedRect(margin, y - 3, contentW, bH, 2.5, 2.5, "FD"); pdf.setTextColor(60, 55, 50); pdf.text(lines, margin + 7, y + 3.5); y += bH + 5; }
          if (idx < entries.length - 1) y += 4;
        });
      }
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(160, 155, 150);
      pdf.text("MemoryBridge AI  •  Confidential", W / 2, H - 10, { align: "center" });
      pdf.save("patient-care-report.pdf");
    } catch (err) { console.error("Download failed:", err); alert("Failed to download report."); } finally { setDownloading(false); }
  };

  return (
    <div className="dashboard-layout">
      {/* Top bar — Refresh centered */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button type="button" className="btn btn-secondary" onClick={handleRefresh} disabled={loading} style={{ padding: "8px 22px" }}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
        {refreshMsg && <span style={{ fontSize: 13, color: "#16a34a", fontWeight: 500 }}>{refreshMsg}</span>}
      </div>

      {/* 3-column grid: Conversations | Memories | Summary + Trend */}
      <div className="dash-grid-3">
        {/* Recent Conversations (Threads) */}
        <div className="col-card dash-col">
          <div className="col-card-header" style={{ marginBottom: 8, paddingBottom: 8 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#e07a5f" strokeWidth="2" width="15" height="15"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
            <h3>Recent Conversations</h3>
            <span style={{ fontSize: 11, opacity: 0.4, marginLeft: "auto" }}>{recentThreads.length} threads</span>
          </div>
          <div className="dash-col-scroll">
            {recentThreads.length === 0 ? (
              <div className="dash-empty">No conversations yet</div>
            ) : (
              recentThreads.map((t) => {
                const firstUserMsg = t.conversation.find((m) => m.role === "user");
                const preview = firstUserMsg?.content || t.conversation[0]?.content || t.summaryText || "No content";
                const ts = t.updated_at || t.created_at || "";
                const sentColor = t.sentimentLabel?.toLowerCase() === "positive" ? "#4ade80" : t.sentimentLabel?.toLowerCase() === "negative" ? "#f87171" : "#fbbf24";
                return (
                  <div key={t.thread_id} className="dash-item" style={{ cursor: "pointer" }} onClick={() => setModalThread(t)}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#e07a5f" }}>
                        {t.conversation.length} msgs
                        {t.sentimentLabel && <> · <span style={{ color: sentColor }}>{t.sentimentLabel}</span></>}
                        {t.duration && <> · {t.duration}</>}
                      </span>
                      <span style={{ fontSize: 10, opacity: 0.45 }}>{timeAgo(ts)}</span>
                    </div>
                    <div className="dash-item-content">{preview}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Recent Memories */}
        <div className="col-card dash-col">
          <div className="col-card-header" style={{ marginBottom: 8, paddingBottom: 8 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#e07a5f" strokeWidth="2" width="15" height="15"><path d="M12 2a10 10 0 100 20 10 10 0 000-20z" /><path d="M12 6v6l4 2" /></svg>
            <h3>Recent Memories</h3>
            <span style={{ fontSize: 11, opacity: 0.4, marginLeft: "auto" }}>{memories.length} total</span>
          </div>
          <div className="dash-col-scroll">
            {recentMemories.length === 0 ? (
              <div className="dash-empty">No memories yet</div>
            ) : (
              recentMemories.map((m) => (
                <div key={m.id} className="dash-item">
                  <div style={{ fontSize: 13, lineHeight: 1.4 }}>{m.content}</div>
                  <div style={{ fontSize: 10, opacity: 0.4, marginTop: 3 }}>
                    {m.updated_at ? `Updated ${formatDateTime(m.updated_at)}` : formatDateTime(m.created_at)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Summary + Scores + Charts */}
        <div className="dash-col" style={{ display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
          {/* Summary stats + Memory Score row */}
          <div className="col-card" style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
              {/* Summary numbers */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Summary</div>
                {stats ? (
                  <>
                    <div className="dash-summary-row"><span>Entries</span><strong>{stats.totalEntries}</strong></div>
                    <div className="dash-summary-row"><span>Memories</span><strong>{stats.memoriesCount}</strong></div>
                    <div className="dash-summary-row"><span>Incidents</span><strong>{stats.totalIncidents}</strong></div>
                    <div className="dash-summary-row">
                      <span>Sentiment</span>
                      <strong style={{ color: "#e07a5f" }}>{SENTIMENT_LABEL[currentSentiment] || "Neutral"}</strong>
                    </div>
                  </>
                ) : <div className="dash-empty">Loading...</div>}
              </div>
              {/* Memory Score gauge */}
              <div style={{ flex: "0 0 110px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#FFF3ED", borderRadius: 12, padding: "10px 8px" }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: "#e07a5f", lineHeight: 1 }}>{memoryScore}</div>
                <div style={{ fontSize: 11, color: "#e07a5f", opacity: 0.7, marginTop: 2 }}>/100</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#2c2a27", opacity: 0.5, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Memory Score</div>
              </div>
            </div>
          </div>

          {/* Memory Trend Chart */}
          <div className="col-card" style={{ padding: "14px 18px", flex: 1, minHeight: 140, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#e07a5f" strokeWidth="2" width="13" height="13"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Memory Trend</span>
              <span style={{ fontSize: 10, opacity: 0.4, marginLeft: "auto" }}>Last 7 days</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={memoryTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4ddd4" />
                  <XAxis dataKey="day" fontSize={9} tick={{ fill: "#7c7872" }} />
                  <YAxis domain={[0, 100]} fontSize={9} tick={{ fill: "#7c7872" }} width={24} />
                  <Tooltip formatter={(v: number) => [`${v}/100`, "Score"]} />
                  <Line dataKey="score" name="Memory" stroke="#e07a5f" strokeWidth={2} dot={{ r: 3, fill: "#e07a5f" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Sentiment Trend — stacked 100% bar */}
          <div className="col-card" style={{ padding: "14px 18px", flex: 1, minHeight: 140, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#e07a5f" strokeWidth="2" width="13" height="13"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18" /></svg>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Sentiment Trend</span>
              <span style={{ fontSize: 10, opacity: 0.4, marginLeft: "auto" }}>Last 7 days</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sentimentTrend} stackOffset="expand" barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4ddd4" />
                  <XAxis dataKey="day" fontSize={9} tick={{ fill: "#7c7872" }} />
                  <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} fontSize={9} tick={{ fill: "#7c7872" }} width={30} />
                  <Tooltip formatter={(v: number) => [`${v}%`, ""]} />
                  <Bar dataKey="positive" name="Positive" stackId="s" fill="#4ade80" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="neutral" name="Neutral" stackId="s" fill="#fbbf24" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="negative" name="Negative" stackId="s" fill="#f87171" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 6 }}>
              <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "#4ade80", display: "inline-block" }} />Positive</span>
              <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "#fbbf24", display: "inline-block" }} />Neutral</span>
              <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "#f87171", display: "inline-block" }} />Negative</span>
            </div>
          </div>
        </div>
      </div>

      {/* Download Report — bottom center, green */}
      <div style={{ display: "flex", justifyContent: "center", flexShrink: 0 }}>
        <button type="button" className="btn-download-green" onClick={handleDownload} disabled={downloading}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          {downloading ? "Downloading..." : "Download Report"}
        </button>
      </div>

      {/* ── Chat Modal ── */}
      {modalThread && (
        <div className="chat-modal-overlay" onClick={() => setModalThread(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chat-modal-header">
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Conversation</h3>
                <span style={{ fontSize: 11, opacity: 0.5 }}>
                  {modalThread.conversation.length} messages
                  {modalThread.sentimentLabel && ` · ${modalThread.sentimentLabel}`}
                  {modalThread.duration && ` · ${modalThread.duration}`}
                  {modalThread.updated_at ? ` · ${formatDateTime(modalThread.updated_at)}` : ""}
                </span>
              </div>
              <button className="chat-modal-close" onClick={() => setModalThread(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="chat-modal-body">
              {modalThread.conversation.map((msg, i) => {
                const isUser = msg.role === "user";
                return (
                  <div key={i} className={`chat-bubble-row ${isUser ? "chat-row-user" : "chat-row-agent"}`}>
                    <div className={`chat-bubble ${isUser ? "chat-bubble-user" : "chat-bubble-agent"}`}>
                      <div className="chat-bubble-name">{isUser ? "Abhishek" : "Megan"}</div>
                      <div className="chat-bubble-text">{msg.content}</div>
                    </div>
                  </div>
                );
              })}
              {modalThread.summaryText && (
                <div style={{ borderTop: "1px solid #e4ddd4", marginTop: 16, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#e07a5f", marginBottom: 6 }}>Summary</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "#4a4540" }}>{modalThread.summaryText}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
