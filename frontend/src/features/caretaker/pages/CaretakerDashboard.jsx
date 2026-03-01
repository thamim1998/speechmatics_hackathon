import React, { useEffect, useMemo, useState } from "react";
import { addEvent, getAnalyticsSummary, getTimeline } from "../api/caretakerApi";

function formatTs(msg) {
  const md = msg.metadata_ || msg.metadata;
  const ts = md?.custom_timestamp || msg.created_at || msg.timestamp;
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function getType(msg) {
  const md = msg.metadata_ || msg.metadata;
  return md?.type || "unknown";
}

export default function CaretakerDashboard() {
  const [timeline, setTimeline] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const [type, setType] = useState("note");
  const [text, setText] = useState("");

  const [sleepDuration, setSleepDuration] = useState(360);
  const [sleepWakeUps, setSleepWakeUps] = useState(2);
  const [sleepQuality, setSleepQuality] = useState(3);

  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [t, a] = await Promise.all([getTimeline(), getAnalyticsSummary()]);
      const msgs = (t.messages || []).slice().sort((m1, m2) => {
        const md1 = m1.metadata_ || m1.metadata;
        const md2 = m2.metadata_ || m2.metadata;
        const ts1 = new Date(md1?.custom_timestamp || m1.created_at || 0).getTime();
        const ts2 = new Date(md2?.custom_timestamp || m2.created_at || 0).getTime();
        return ts2 - ts1;
      });
      setTimeline(msgs);
      setSummary(a.summary);
    } catch (e) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const analyticsView = useMemo(() => {
    if (!summary) return null;
    const countsByType = summary.countsByType || {};
    const avgSleep = summary.avgSleepMinutesByDay || {};
    const flags = summary.flags || [];

    return (
      <div style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Analytics</h3>
        <div>
          <strong>Counts by type:</strong>{" "}
          {Object.keys(countsByType).length
            ? Object.entries(countsByType).map(([k, v]) => `${k}: ${v}`).join(" • ")
            : "—"}
        </div>
        <div style={{ marginTop: 8 }}>
          <strong>Avg sleep minutes by day:</strong>{" "}
          {Object.keys(avgSleep).length
            ? Object.entries(avgSleep).map(([k, v]) => `${k}: ${v}`).join(" • ")
            : "—"}
        </div>
        <div style={{ marginTop: 8 }}>
          <strong>Flags:</strong> {flags.length ? flags.join(" • ") : "—"}
        </div>
      </div>
    );
  }, [summary]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      const body = {
        type,
        text: text.trim() || undefined,
        timestampISO: new Date().toISOString(),
      };

      if (type === "sleep") {
        body.data = {
          durationMinutes: Number(sleepDuration),
          wakeUps: Number(sleepWakeUps),
          quality: Number(sleepQuality),
        };
        if (!body.text) body.text = `Sleep: ${sleepDuration} min, wakeUps: ${sleepWakeUps}, quality: ${sleepQuality}`;
      }

      await addEvent(body);
      setText("");
      await refresh();
    } catch (e2) {
      setError(e2.message || "Failed to save");
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: 16 }}>
      <h2>Caretaker Portal</h2>

      {error ? (
        <div style={{ background: "#ffe5e5", padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
        <form onSubmit={onSubmit} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Add Entry</h3>

          <label>
            Type:&nbsp;
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="note">note</option>
              <option value="sleep">sleep</option>
              <option value="mood">mood</option>
              <option value="incident">incident</option>
              <option value="medication">medication</option>
              <option value="profile">profile</option>
            </select>
          </label>

          <div style={{ marginTop: 10 }}>
            <textarea
              rows={3}
              style={{ width: "100%" }}
              placeholder="Write a note..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {type === "sleep" ? (
            <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
              <label>
                Duration (min):&nbsp;
                <input type="number" value={sleepDuration} onChange={(e) => setSleepDuration(e.target.value)} />
              </label>
              <label>
                Wake ups:&nbsp;
                <input type="number" value={sleepWakeUps} onChange={(e) => setSleepWakeUps(e.target.value)} />
              </label>
              <label>
                Quality (1-5):&nbsp;
                <input type="number" min="1" max="5" value={sleepQuality} onChange={(e) => setSleepQuality(e.target.value)} />
              </label>
            </div>
          ) : null}

          <button type="submit" style={{ marginTop: 12 }}>
            Save
          </button>
        </form>

        {analyticsView}

        <div style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Timeline</h3>
          {loading ? (
            <div>Loading…</div>
          ) : timeline.length === 0 ? (
            <div>No entries yet.</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {timeline.map((m) => (
                <li key={m.message_id} style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{getType(m)}</strong>
                    <span style={{ opacity: 0.7, fontSize: 12 }}>{formatTs(m)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{m.content}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}