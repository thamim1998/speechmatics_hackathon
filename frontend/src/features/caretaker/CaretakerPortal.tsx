

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Cell,
  Legend,
} from "recharts";
import {
  addEvent,
  getAnalyticsSummary,
  getMemories,
  getTimeline,
  getTranscripts,
  type CaretakerEventType,
  type Memory,
  type TimelineMessage,
} from "./api/caretakerApi";

import { jsPDF } from "jspdf";

// ----------------------
// Color coding
// ----------------------
const TYPE_COLORS: Record<string, string> = {
  note: "#4F46E5", // indigo
  sleep: "#0EA5E9", // sky
  mood: "#22C55E", // green
  incident: "#F97316", // orange
  medication: "#A855F7", // purple
  profile: "#64748B", // slate
  call_session: "#EC4899", // pink
  unknown: "#94A3B8",
};

const SERIES_COLORS = {
  last7: "#22C55E", // green
  prev7: "#94A3B8", // gray
};

function colorForType(t: string) {
  return TYPE_COLORS[t] || TYPE_COLORS.unknown;
}

// ----------------------
// Types for form fields
// ----------------------
type MoodLabel = "calm" | "anxious" | "agitated";
type IncidentType = "wandering" | "fall" | "agitation" | "other";

// ----------------------
// Helpers
// ----------------------
function getMeta(msg: TimelineMessage) {
  return msg.metadata_ || {};
}

function getPrimaryISO(msg: TimelineMessage) {
  const md = getMeta(msg);
  return md.custom_timestamp || msg.timestamp || msg.created_at || "";
}

function dayKeyFromISO(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function timeFromISO(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(dayISO: string) {
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);

  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterdayKey = y.toISOString().slice(0, 10);

  if (dayISO === todayKey) return "Today";
  if (dayISO === yesterdayKey) return "Yesterday";
  return dayISO;
}

function getType(msg: TimelineMessage) {
  return (getMeta(msg).type || "unknown") as string;
}

function inRange(iso: string, from?: string, to?: string) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;

  if (from) {
    const f = new Date(from + "T00:00:00").getTime();
    if (t < f) return false;
  }
  if (to) {
    const end = new Date(to + "T23:59:59").getTime();
    if (t > end) return false;
  }
  return true;
}

// ----------------------
// Small UI helpers (TSX-only polish)
// ----------------------
function SectionBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="card-number"
      style={{
        width: 34,
        height: 34,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 999,
        background: "var(--color-cream)",
        border: "1px solid var(--color-cream-dark)",
        fontSize: 14,
        fontWeight: 600,
        lineHeight: 1,
        opacity: 1,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

// ----------------------
// Component
// ----------------------
export default function CaretakerPortal() {
  const [timeline, setTimeline] = useState<TimelineMessage[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<any>(null);
  const [error, setError] = useState("");

  // Add Entry form state
  const [type, setType] = useState<CaretakerEventType>("note");
  const [text, setText] = useState("");

  // sleep fields
  const [sleepDuration, setSleepDuration] = useState(360);
  const [sleepWakeUps, setSleepWakeUps] = useState(2);
  const [sleepQuality, setSleepQuality] = useState(3);

  // mood fields
  const [moodLabel, setMoodLabel] = useState<MoodLabel>("calm");
  const [moodSeverity, setMoodSeverity] = useState(3);

  // incident fields
  const [incidentType, setIncidentType] = useState<IncidentType>("wandering");
  const [incidentSeverity, setIncidentSeverity] = useState(3);
  const [incidentDesc, setIncidentDesc] = useState("");

  // medication fields
  const [medName, setMedName] = useState("");
  const [medDose, setMedDose] = useState("");
  const [medTaken, setMedTaken] = useState(true);
  const [medNote, setMedNote] = useState("");

  // profile fields (stable facts -> backend builds/uploads document)
  const [profilePatientName, setProfilePatientName] = useState("");
  const [profileDiagnosis, setProfileDiagnosis] = useState("");
  const [profileMedicationPlan, setProfileMedicationPlan] = useState("");
  const [profileRoutine, setProfileRoutine] = useState("");
  const [profileEmergencyContact, setProfileEmergencyContact] = useState("");
  const [profileCalmingStrategies, setProfileCalmingStrategies] = useState("");

  // timeline filters
  const [filterType, setFilterType] = useState<string>("all");
  const [fromDay, setFromDay] = useState<string>("");
  const [toDay, setToDay] = useState<string>("");

  // call patient
  const [callPhone, setCallPhone] = useState("+917202849884");
  const [callStatus, setCallStatus] = useState<"idle" | "calling" | "success" | "error">("idle");
  const [callError, setCallError] = useState("");

  const handleCallPatient = async () => {
    const digits = callPhone.replace(/\D/g, "");
    if (digits.length < 9) {
      setCallError("Enter a valid phone number first");
      return;
    }
    setCallStatus("calling");
    setCallError("");
    try {
      const res = await fetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: callPhone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Call failed");
      setCallStatus("success");
      setTimeout(() => setCallStatus("idle"), 4000);
    } catch (err: any) {
      setCallStatus("error");
      setCallError(err instanceof Error ? err.message : "Call failed");
      setTimeout(() => setCallStatus("idle"), 4000);
    }
  };

  // report download
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // Fetch timeline + memories in parallel
      const [tlData, memData] = await Promise.all([
        getTimeline(),
        getMemories(),
      ]);
      const entries = (tlData.messages || []).sort((a, b) => {
        const ta = new Date(getPrimaryISO(a)).getTime();
        const tb = new Date(getPrimaryISO(b)).getTime();
        return tb - ta;
      });
      const patientMemories = (memData.memories || []).filter((m) => {
        const lower = m.content.toLowerCase();
        if (lower.startsWith("user is sarah") || lower.startsWith("user is megan")) return false;
        if (lower.startsWith("megan ") || lower.startsWith("megan's ")) return false;
        if (lower.startsWith("sarah ") || lower.startsWith("sarah's ")) return false;
        return true;
      });

      // Deduplicate memories by content
      const seen = new Set<string>();
      const uniqueMemories = patientMemories.filter((m) => {
        const key = m.content.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (entries.length === 0 && uniqueMemories.length === 0) {
        alert("No data to download.");
        return;
      }

      // Try to extract name from memories
      const nameMemory = uniqueMemories.find((m) => m.content.toLowerCase().includes("name is "));
      let personName = "Abhishek";
      if (nameMemory) {
        const match = nameMemory.content.match(/name is (\w+)/i);
        if (match) personName = match[1];
      }

      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const W = pdf.internal.pageSize.getWidth();
      const H = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentW = W - margin * 2;
      let y = 0;

      const ensureSpace = (needed: number) => {
        if (y + needed > H - margin) {
          pdf.addPage();
          y = margin;
        }
      };

      // ── Header ──
      pdf.setFillColor(45, 74, 62);
      pdf.rect(0, 0, W, 52, "F");
      pdf.setFillColor(196, 114, 78);
      pdf.rect(0, 52, W, 2, "F");

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(22);
      pdf.setTextColor(255, 255, 255);
      const dateStr = new Date().toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      pdf.text(`${personName}'s Care Report — ${dateStr}`, margin, 26);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.setTextColor(200, 210, 200);
      pdf.text(
        `${entries.length} timeline entries  •  ${uniqueMemories.length} memories`,
        margin,
        38,
      );
      y = 66;

      // ── Section 1: What Megan Knows ──
      if (uniqueMemories.length > 0) {
        ensureSpace(20);
        pdf.setFillColor(224, 242, 254);
        pdf.roundedRect(margin, y - 3, contentW, 12, 3, 3, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(13);
        pdf.setTextColor(3, 105, 161);
        pdf.text(`What Megan Knows About ${personName}`, margin + 6, y + 5);
        y += 16;

        uniqueMemories.forEach((m) => {
          const lines = pdf
            .setFont("helvetica", "normal")
            .setFontSize(10)
            .splitTextToSize(`• ${m.content}`, contentW - 10);
          const blockH = lines.length * 5 + 2;
          ensureSpace(blockH + 2);
          pdf.setTextColor(60, 55, 50);
          pdf.text(lines, margin + 6, y);
          y += blockH + 1;
        });
        y += 8;
      }

      // ── Section 2: Caretaker Timeline ──
      if (entries.length > 0) {
        ensureSpace(20);
        pdf.setFillColor(245, 243, 240);
        pdf.roundedRect(margin, y - 3, contentW, 12, 3, 3, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(13);
        pdf.setTextColor(45, 74, 62);
        pdf.text("Caretaker Timeline", margin + 6, y + 5);
        y += 16;

        entries.forEach((entry, idx) => {
          const md = getMeta(entry);
          const entryType = (md.type || "note").toUpperCase();
          const ts = getPrimaryISO(entry);
          const timeStr = ts ? new Date(ts).toLocaleString() : "";

          // Entry header line
          ensureSpace(18);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(10);
          pdf.setTextColor(45, 74, 62);
          pdf.text(`[${entryType}]`, margin + 6, y);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(8);
          pdf.setTextColor(140, 135, 130);
          pdf.text(timeStr, W - margin, y, { align: "right" });
          y += 6;

          // Entry content
          const content = entry.content || "";
          if (content) {
            const lines = pdf
              .setFont("helvetica", "normal")
              .setFontSize(10)
              .splitTextToSize(content, contentW - 12);
            const blockH = lines.length * 5 + 7;
            ensureSpace(blockH + 4);

            pdf.setFillColor(250, 248, 245);
            pdf.setDrawColor(230, 225, 220);
            pdf.roundedRect(margin, y - 3, contentW, blockH, 2.5, 2.5, "FD");
            pdf.setTextColor(60, 55, 50);
            pdf.text(lines, margin + 7, y + 3.5);
            y += blockH + 5;
          }

          if (idx < entries.length - 1) {
            y += 4;
          }
        });
      }

      // ── Footer ──
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(160, 155, 150);
      pdf.text("Dementia Voice Agent  •  Confidential", W / 2, H - 10, { align: "center" });

      pdf.save("patient-care-report.pdf");
    } catch (err) {
      console.error("Download failed:", err);
      alert("Failed to download report. Check console for details.");
    } finally {
      setDownloading(false);
    }
  };

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [t, a, m] = await Promise.all([getTimeline(), getAnalyticsSummary(), getMemories()]);
      const msgs = (t.messages || []).slice().sort((m1, m2) => {
        const ts1 = new Date(getPrimaryISO(m1)).getTime() || 0;
        const ts2 = new Date(getPrimaryISO(m2)).getTime() || 0;
        return ts2 - ts1;
      });
      setTimeline(msgs);
      setSummary(a.summary);
      setMemories(m.memories || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load caretaker data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    try {
      const timestampISO = new Date().toISOString();
      const body: any = {
        type,
        text: text.trim() || undefined,
        timestampISO,
      };

      if (type === "sleep") {
        body.data = {
          durationMinutes: Number(sleepDuration),
          wakeUps: Number(sleepWakeUps),
          quality: Number(sleepQuality),
        };
        if (!body.text)
          body.text = `Sleep: ${sleepDuration} min, wakeUps ${sleepWakeUps}, quality ${sleepQuality}/5`;
      }

      if (type === "mood") {
        body.data = { mood: moodLabel, severity: Number(moodSeverity) };
        if (!body.text) body.text = `Mood: ${moodLabel} (severity ${moodSeverity}/5)`;
      }

      if (type === "incident") {
        body.data = {
          incidentType,
          severity: Number(incidentSeverity),
          description: incidentDesc.trim() || undefined,
        };
        if (!body.text)
          body.text = `Incident: ${incidentType} (severity ${incidentSeverity}/5)`;
      }

      if (type === "medication") {
        body.data = {
          medication: medName.trim() || "Unknown",
          dose: medDose.trim() || undefined,
          taken: Boolean(medTaken),
          note: medNote.trim() || undefined,
        };
        if (!body.text)
          body.text = `Medication: ${medName || "Unknown"} (${medTaken ? "taken" : "missed"})`;
      }

      // ✅ NEW: profile (stable facts -> backend document upload)
      if (type === "profile") {
        body.data = {
          patientName: profilePatientName.trim() || undefined,
          diagnosis: profileDiagnosis.trim() || undefined,
          medicationPlan: profileMedicationPlan.trim() || undefined,
          baselineRoutine: profileRoutine.trim() || undefined,
          emergencyContact: profileEmergencyContact.trim() || undefined,
          calmingStrategies: profileCalmingStrategies.trim() || undefined,
        };
        if (!body.text) body.text = "Profile updated by caretaker.";
      }

      await addEvent(body);

      // reset generic fields
      setText("");
      setIncidentDesc("");
      setMedNote("");

      // optional: reset profile fields on save
      if (type === "profile") {
        setProfilePatientName("");
        setProfileDiagnosis("");
        setProfileMedicationPlan("");
        setProfileRoutine("");
        setProfileEmergencyContact("");
        setProfileCalmingStrategies("");
      }

      await refresh();
    } catch (e2: any) {
      setError(e2?.message || "Failed to save entry");
    }
  }

  const filteredTimeline = useMemo(() => {
    return timeline.filter((m) => {
      const t = getType(m);
      const iso = getPrimaryISO(m);
      if (!iso) return false;

      if (filterType !== "all" && t !== filterType) return false;
      if (fromDay || toDay) {
        if (!inRange(iso, fromDay || undefined, toDay || undefined)) return false;
      }
      return true;
    });
  }, [timeline, filterType, fromDay, toDay]);

  const grouped = useMemo(() => {
    const map = new Map<string, TimelineMessage[]>();
    for (const m of filteredTimeline) {
      const iso = getPrimaryISO(m);
      const day = dayKeyFromISO(iso) || "unknown";
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(m);
    }
    const keys = Array.from(map.keys()).sort((a, b) => (a > b ? -1 : 1));
    return keys.map((k) => ({ day: k, items: map.get(k)! }));
  }, [filteredTimeline]);

  const analyticsCharts = useMemo(() => {
    if (!summary) return null;

    const countsByType: Record<string, number> = summary.countsByType || {};
    const avgSleepByDay: Record<string, number> = summary.avgSleepMinutesByDay || {};
    const incidentCountsByType: Record<string, number> = summary.incidentCountsByType || {};
    const last7 = summary.last7Days?.countsByType || {};
    const prev7 = summary.prev7Days?.countsByType || {};
    const flags: string[] = summary.flags || [];

    const countsData = Object.entries(countsByType)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    const sleepData = Object.entries(avgSleepByDay)
      .map(([day, minutes]) => ({ day, minutes }))
      .sort((a, b) => (a.day > b.day ? 1 : -1));

    const incidentData = Object.entries(incidentCountsByType)
      .filter(([k]) => k !== "unknown")
      .map(([incidentType, count]) => ({ incidentType, count }))
      .sort((a, b) => b.count - a.count);

    const deltaData = Object.keys({ ...last7, ...prev7 })
      .sort()
      .map((type) => ({
        type,
        last7: last7[type] ?? 0,
        prev7: prev7[type] ?? 0,
      }));

    const totalEntries = Object.values(countsByType).reduce((a, b) => a + b, 0);
    const totalIncidents = incidentData.reduce((a, b) => a + b.count, 0);
    const latestSleep = sleepData.length ? sleepData[sleepData.length - 1].minutes : null;

    const Card = ({ title, value }: { title: string; value: string }) => (
      <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{value}</div>
      </div>
    );

    return (
      <section className="form-card" style={{ animationDelay: "0.2s" }}>
        <div className="card-header">
          <SectionBadge>A</SectionBadge>
          <div>
            <h2 className="card-title">Analytics</h2>
            <p className="card-description">Figures and charts</p>
          </div>
        </div>

        <div style={{ padding: 16, display: "grid", gap: 16 }}>
          {/* TSX-only responsive KPI grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <Card title="Total entries" value={String(totalEntries)} />
            <Card title="Incidents (total)" value={String(totalIncidents)} />
            <Card title="Latest sleep (min)" value={latestSleep != null ? String(latestSleep) : "—"} />
          </div>

          <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Counts by type</div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={countsData}>
                  <XAxis dataKey="type" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" name="Count">
                    {countsData.map((row) => (
                      <Cell key={row.type} fill={colorForType(row.type)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Avg sleep minutes by day</div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sleepData}>
                  <CartesianGrid />
                  <XAxis dataKey="day" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line dataKey="minutes" name="Avg minutes" dot stroke={TYPE_COLORS.sleep} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Last 7 days vs previous 7 days</div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deltaData}>
                  <XAxis dataKey="type" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="last7" name="Last 7 days" fill={SERIES_COLORS.last7} />
                  <Bar dataKey="prev7" name="Previous 7 days" fill={SERIES_COLORS.prev7} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Top incident types</div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={incidentData}>
                  <XAxis dataKey="incidentType" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" name="Incidents" fill={TYPE_COLORS.incident} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Flags</div>
            {flags.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {flags.map((f: string, i: number) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : (
              <div style={{ opacity: 0.7 }}>—</div>
            )}
          </div>
        </div>
      </section>
    );
  }, [summary]);

  return (
    <div className="page-wrapper">
      <header className="page-header">
        <div className="header-accent" />
        <h1 className="page-title">Caretaker Portal</h1>
        <p className="page-subtitle">Add context and review the patient timeline</p>

        {/* link on top, download button below */}
        <div
          style={{
            marginTop: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <a href="/" style={{ fontSize: 12, opacity: 0.8 }}>
            ← Back to patient portal
          </a>

          <button
            type="button"
            className="btn-download"
            onClick={handleDownload}
            disabled={downloading}
            style={{
              minWidth: 260,
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ display: "inline-block", minWidth: 175, textAlign: "center" }}>
              {downloading ? "Downloading..." : "Download Report"}
            </span>
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-text" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      {/* Call Patient */}
      <section className="form-card" style={{ animationDelay: "0.05s" }}>
        <div className="card-header">
          <SectionBadge>C</SectionBadge>
          <div>
            <h2 className="card-title">Call Patient</h2>
            <p className="card-description">Initiate a voice call via LiveKit</p>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Phone Number</label>
              <input
                className="form-input"
                type="tel"
                placeholder="+33 7 68 97 56 61"
                value={callPhone}
                onChange={(e) => setCallPhone(e.target.value)}
              />
            </div>
          </div>

          <div className="call-action-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className={`btn btn-call ${callStatus}`}
              onClick={handleCallPatient}
              disabled={callStatus === "calling"}
            >
              {callStatus === "calling" ? (
                <>
                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  Calling...
                </>
              ) : callStatus === "success" ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Call Initiated
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                  </svg>
                  Call Patient
                </>
              )}
            </button>
            {callStatus === "error" && callError && (
              <span className="error-text">{callError}</span>
            )}
          </div>
        </div>
      </section>

      {/* Add Entry */}
      <section className="form-card" style={{ animationDelay: "0.1s" }}>
        <div className="card-header">
          <SectionBadge>01</SectionBadge>
          <div>
            <h2 className="card-title">Add Entry</h2>
            <p className="card-description">Store caretaker observations in Backboard</p>
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ padding: 16 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Type</label>
              <div className="select-wrapper">
                <select
                  className="form-select"
                  value={type}
                  onChange={(e) => setType(e.target.value as CaretakerEventType)}
                >
                  <option value="note">note</option>
                  <option value="sleep">sleep</option>
                  <option value="mood">mood</option>
                  <option value="incident">incident</option>
                  <option value="medication">medication</option>
                  <option value="profile">profile</option>
                </select>
                <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </div>

            {/* Free text stays available for all types */}
            <div className="form-group">
              <label className="form-label">Text (optional)</label>
              <textarea
                className="form-input"
                style={{ minHeight: 90 }}
                placeholder="Write context / observations..."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            {/* sleep */}
            {type === "sleep" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Duration (minutes)</label>
                  <input
                    className="form-input"
                    type="number"
                    value={sleepDuration}
                    onChange={(e) => setSleepDuration(Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Wake ups</label>
                  <input
                    className="form-input"
                    type="number"
                    value={sleepWakeUps}
                    onChange={(e) => setSleepWakeUps(Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Quality (1–5)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    max={5}
                    value={sleepQuality}
                    onChange={(e) => setSleepQuality(Number(e.target.value))}
                  />
                </div>
              </>
            ) : null}

            {/* mood */}
            {type === "mood" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Mood</label>
                  <div className="select-wrapper">
                    <select
                      className="form-select"
                      value={moodLabel}
                      onChange={(e) => setMoodLabel(e.target.value as MoodLabel)}
                    >
                      <option value="calm">calm</option>
                      <option value="anxious">anxious</option>
                      <option value="agitated">agitated</option>
                    </select>
                    <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Severity (1–5)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    max={5}
                    value={moodSeverity}
                    onChange={(e) => setMoodSeverity(Number(e.target.value))}
                  />
                </div>
              </>
            ) : null}

            {/* incident */}
            {type === "incident" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Incident type</label>
                  <div className="select-wrapper">
                    <select
                      className="form-select"
                      value={incidentType}
                      onChange={(e) => setIncidentType(e.target.value as IncidentType)}
                    >
                      <option value="wandering">wandering</option>
                      <option value="fall">fall</option>
                      <option value="agitation">agitation</option>
                      <option value="other">other</option>
                    </select>
                    <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Severity (1–5)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    max={5}
                    value={incidentSeverity}
                    onChange={(e) => setIncidentSeverity(Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Description (optional)</label>
                  <input
                    className="form-input"
                    value={incidentDesc}
                    onChange={(e) => setIncidentDesc(e.target.value)}
                    placeholder="What happened?"
                  />
                </div>
              </>
            ) : null}

            {/* medication */}
            {type === "medication" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Medication name</label>
                  <input
                    className="form-input"
                    value={medName}
                    onChange={(e) => setMedName(e.target.value)}
                    placeholder="e.g., Donepezil"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Dose (optional)</label>
                  <input
                    className="form-input"
                    value={medDose}
                    onChange={(e) => setMedDose(e.target.value)}
                    placeholder="e.g., 5mg"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Taken?</label>
                  <div className="select-wrapper">
                    <select
                      className="form-select"
                      value={medTaken ? "yes" : "no"}
                      onChange={(e) => setMedTaken(e.target.value === "yes")}
                    >
                      <option value="yes">yes</option>
                      <option value="no">no</option>
                    </select>
                    <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Note (optional)</label>
                  <input
                    className="form-input"
                    value={medNote}
                    onChange={(e) => setMedNote(e.target.value)}
                    placeholder="e.g., after breakfast"
                  />
                </div>
              </>
            ) : null}

            {/* ✅ NEW: profile fields */}
            {type === "profile" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Patient name</label>
                  <input
                    className="form-input"
                    value={profilePatientName}
                    onChange={(e) => setProfilePatientName(e.target.value)}
                    placeholder="e.g., John Doe"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Diagnosis</label>
                  <input
                    className="form-input"
                    value={profileDiagnosis}
                    onChange={(e) => setProfileDiagnosis(e.target.value)}
                    placeholder="e.g., Dementia"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Medication plan</label>
                  <input
                    className="form-input"
                    value={profileMedicationPlan}
                    onChange={(e) => setProfileMedicationPlan(e.target.value)}
                    placeholder="e.g., Donepezil 5mg daily after breakfast"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Baseline routine</label>
                  <textarea
                    className="form-input"
                    style={{ minHeight: 90 }}
                    value={profileRoutine}
                    onChange={(e) => setProfileRoutine(e.target.value)}
                    placeholder="Breakfast time, walk, lunch, rest..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Emergency contact</label>
                  <input
                    className="form-input"
                    value={profileEmergencyContact}
                    onChange={(e) => setProfileEmergencyContact(e.target.value)}
                    placeholder="Name + phone"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Calming strategies</label>
                  <textarea
                    className="form-input"
                    style={{ minHeight: 90 }}
                    value={profileCalmingStrategies}
                    onChange={(e) => setProfileCalmingStrategies(e.target.value)}
                    placeholder="What helps when the patient is anxious/confused?"
                  />
                </div>
              </>
            ) : null}
          </div>

          <div className="form-actions" style={{ marginTop: 12 }}>
            <button type="submit" className="btn btn-primary btn-large">
              Save Entry
            </button>
          </div>
        </form>
      </section>

      {analyticsCharts}

      {/* Patient Memories */}
      {memories.length > 0 && (
        <section className="form-card" style={{ animationDelay: "0.25s" }}>
          <div className="card-header">
            <SectionBadge>M</SectionBadge>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 className="card-title">Patient Memories</h2>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const data = await getMemories();
                      setMemories(data.memories || []);
                    } catch (e) {
                      console.error("Failed to refresh memories", e);
                    }
                  }}
                  className="btn-outline"
                  style={{
                    padding: "6px 14px",
                    fontSize: 13,
                    cursor: "pointer",
                    borderRadius: 6,
                    border: "1px solid #ccc",
                    background: "#fff",
                    color: "#555",
                  }}
                >
                  Refresh
                </button>
              </div>
              <p className="card-description">
                What the agent has learned across conversations ({memories.length})
              </p>
            </div>
          </div>

          <div style={{ padding: 16 }}>
            <ul className="questions-list">
              {memories
                .filter((m) => {
                  // Skip system-prompt-like memories (agent persona descriptions)
                  const lower = m.content.toLowerCase();
                  if (lower.startsWith("user is sarah") || lower.startsWith("user is megan")) return false;
                  if (lower.startsWith("megan ") || lower.startsWith("megan's ")) return false;
                  if (lower.startsWith("sarah ") || lower.startsWith("sarah's ")) return false;
                  return true;
                })
                .sort((a, b) => {
                  const ta = new Date(a.updated_at || a.created_at).getTime();
                  const tb = new Date(b.updated_at || b.created_at).getTime();
                  return tb - ta;
                })
                .map((m) => (
                  <li key={m.id} className="question-item" style={{ alignItems: "flex-start" }}>
                    <span
                      className="question-number"
                      style={{ lineHeight: "28px", background: "#E0F2FE", color: "#0369A1" }}
                    >
                      M
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ marginBottom: 4 }}>{m.content}</div>
                      <div style={{ fontSize: 11, opacity: 0.5 }}>
                        {m.updated_at
                          ? `Updated ${new Date(m.updated_at).toLocaleString()}`
                          : `Created ${new Date(m.created_at).toLocaleString()}`}
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      )}

      {/* Timeline */}
      <section className="form-card" style={{ animationDelay: "0.3s" }}>
        <div className="card-header">
          <SectionBadge>02</SectionBadge>
          <div>
            <h2 className="card-title">Timeline</h2>
            <p className="card-description">Filter and review entries</p>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="form-group">
              <label className="form-label">Filter type</label>
              <div className="select-wrapper">
                <select className="form-select" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                  <option value="all">all</option>
                  <option value="note">note</option>
                  <option value="sleep">sleep</option>
                  <option value="mood">mood</option>
                  <option value="incident">incident</option>
                  <option value="medication">medication</option>
                  <option value="profile">profile</option>
                  <option value="call_session">call session</option>
                </select>
                <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">From</label>
              <input className="form-input" type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">To</label>
              <input className="form-input" type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
            </div>
          </div>

          {loading ? (
            <div>Loading…</div>
          ) : grouped.length === 0 ? (
            <div>No entries match your filters.</div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {grouped.map(({ day, items }) => (
                <div key={day}>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>{formatDateLabel(day)}</div>

                  <ul className="questions-list">
                    {items.map((m) => {
                      const iso = getPrimaryISO(m);
                      const md = getMeta(m);
                      const t = getType(m);
                      return (
                        <li key={m.message_id} className="question-item" style={{ alignItems: "flex-start" }}>
                          <span className="question-number" style={{ lineHeight: "28px", fontVariantNumeric: "tabular-nums" }}>
                            {t.slice(0, 1).toUpperCase()}
                          </span>

                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                              <span className="question-text" style={{ fontWeight: 700 }}>
                                <span
                                  style={{
                                    display: "inline-block",
                                    width: 8,
                                    height: 8,
                                    borderRadius: 999,
                                    background: colorForType(t),
                                    marginRight: 8,
                                    transform: "translateY(-1px)",
                                  }}
                                />
                                {t}
                              </span>
                              <span style={{ opacity: 0.7, fontSize: 12 }}>{iso ? timeFromISO(iso) : ""}</span>
                            </div>

                            <div style={{ marginTop: 6 }}>{m.content}</div>

                            {md?.data ? (
                              <pre style={{ marginTop: 8, fontSize: 12, opacity: 0.8, whiteSpace: "pre-wrap" }}>
                                {JSON.stringify(md.data, null, 2)}
                              </pre>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}