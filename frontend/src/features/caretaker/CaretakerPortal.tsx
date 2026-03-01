
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
  getTimeline,
  type CaretakerEventType,
  type TimelineMessage,
} from "./api/caretakerApi";

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
// Component
// ----------------------
export default function CaretakerPortal() {
  const [timeline, setTimeline] = useState<TimelineMessage[]>([]);
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

  // timeline filters
  const [filterType, setFilterType] = useState<string>("all");
  const [fromDay, setFromDay] = useState<string>("");
  const [toDay, setToDay] = useState<string>("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [t, a] = await Promise.all([getTimeline(), getAnalyticsSummary()]);
      const msgs = (t.messages || []).slice().sort((m1, m2) => {
        const ts1 = new Date(getPrimaryISO(m1)).getTime() || 0;
        const ts2 = new Date(getPrimaryISO(m2)).getTime() || 0;
        return ts2 - ts1;
      });
      setTimeline(msgs);
      setSummary(a.summary);
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
        if (!body.text) body.text = `Sleep: ${sleepDuration} min, wakeUps ${sleepWakeUps}, quality ${sleepQuality}/5`;
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
        if (!body.text) body.text = `Incident: ${incidentType} (severity ${incidentSeverity}/5)`;
      }

      if (type === "medication") {
        body.data = {
          medication: medName.trim() || "Unknown",
          dose: medDose.trim() || undefined,
          taken: Boolean(medTaken),
          note: medNote.trim() || undefined,
        };
        if (!body.text) body.text = `Medication: ${medName || "Unknown"} (${medTaken ? "taken" : "missed"})`;
      }

      await addEvent(body);

      // reset some fields
      setText("");
      setIncidentDesc("");
      setMedNote("");

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
    const delta: Record<string, number> = summary.delta7DaysByType || {};
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
        delta: delta[type] ?? 0,
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
          <span className="card-number">A</span>
          <div>
            <h2 className="card-title">Analytics</h2>
            <p className="card-description">Figures and charts</p>
          </div>
        </div>

        <div style={{ padding: 16, display: "grid", gap: 16 }}>
          {/* Number cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <Card title="Total entries" value={String(totalEntries)} />
            <Card title="Incidents (total)" value={String(totalIncidents)} />
            <Card title="Latest sleep (min)" value={latestSleep != null ? String(latestSleep) : "—"} />
          </div>

          {/* Counts by type (color-coded by type) */}
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

          {/* Avg sleep (blue line) */}
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

          {/* Last 7 vs prev 7 (series-colored) */}
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

          {/* Top incident types (orange) */}
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

          {/* Flags */}
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

        <div style={{ marginTop: 8 }}>
          <a href="/" style={{ fontSize: 12, opacity: 0.8 }}>
            ← Back to patient portal
          </a>
        </div>
      </header>

      {error ? (
        <div className="error-text" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      {/* Add Entry */}
      <section className="form-card" style={{ animationDelay: "0.1s" }}>
        <div className="card-header">
          <span className="card-number">01</span>
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
                <select className="form-select" value={type} onChange={(e) => setType(e.target.value as CaretakerEventType)}>
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
                  <input className="form-input" type="number" value={sleepDuration} onChange={(e) => setSleepDuration(Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Wake ups</label>
                  <input className="form-input" type="number" value={sleepWakeUps} onChange={(e) => setSleepWakeUps(Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Quality (1–5)</label>
                  <input className="form-input" type="number" min={1} max={5} value={sleepQuality} onChange={(e) => setSleepQuality(Number(e.target.value))} />
                </div>
              </>
            ) : null}

            {/* mood */}
            {type === "mood" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Mood</label>
                  <div className="select-wrapper">
                    <select className="form-select" value={moodLabel} onChange={(e) => setMoodLabel(e.target.value as MoodLabel)}>
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
                  <input className="form-input" type="number" min={1} max={5} value={moodSeverity} onChange={(e) => setMoodSeverity(Number(e.target.value))} />
                </div>
              </>
            ) : null}

            {/* incident */}
            {type === "incident" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Incident type</label>
                  <div className="select-wrapper">
                    <select className="form-select" value={incidentType} onChange={(e) => setIncidentType(e.target.value as IncidentType)}>
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
                  <input className="form-input" type="number" min={1} max={5} value={incidentSeverity} onChange={(e) => setIncidentSeverity(Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Description (optional)</label>
                  <input className="form-input" value={incidentDesc} onChange={(e) => setIncidentDesc(e.target.value)} placeholder="What happened?" />
                </div>
              </>
            ) : null}

            {/* medication */}
            {type === "medication" ? (
              <>
                <div className="form-group">
                  <label className="form-label">Medication name</label>
                  <input className="form-input" value={medName} onChange={(e) => setMedName(e.target.value)} placeholder="e.g., Donepezil" />
                </div>
                <div className="form-group">
                  <label className="form-label">Dose (optional)</label>
                  <input className="form-input" value={medDose} onChange={(e) => setMedDose(e.target.value)} placeholder="e.g., 5mg" />
                </div>
                <div className="form-group">
                  <label className="form-label">Taken?</label>
                  <div className="select-wrapper">
                    <select className="form-select" value={medTaken ? "yes" : "no"} onChange={(e) => setMedTaken(e.target.value === "yes")}>
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
                  <input className="form-input" value={medNote} onChange={(e) => setMedNote(e.target.value)} placeholder="e.g., after breakfast" />
                </div>
              </>
            ) : null}
          </div>

          <div className="form-actions" style={{ marginTop: 12 }}>
            <button type="submit" className="btn btn-primary btn-large">
              Save Entry
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </form>
      </section>

      {/* Analytics */}
      {analyticsCharts}

      {/* Timeline */}
      <section className="form-card" style={{ animationDelay: "0.3s" }}>
        <div className="card-header">
          <span className="card-number">02</span>
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
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>
                    {formatDateLabel(day)}
                  </div>

                  <ul className="questions-list">
                    {items.map((m) => {
                      const iso = getPrimaryISO(m);
                      const md = getMeta(m);
                      const t = getType(m);
                      return (
                        <li key={m.message_id} className="question-item" style={{ alignItems: "flex-start" }}>
                          <span className="question-number">
                            {t.slice(0, 1).toUpperCase()}
                          </span>

                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
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
                              <span style={{ opacity: 0.7, fontSize: 12 }}>
                                {iso ? timeFromISO(iso) : ""}
                              </span>
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