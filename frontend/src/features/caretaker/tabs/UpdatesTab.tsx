import { useState, type FormEvent } from "react";
import { addEvent, type CaretakerEventType, type TimelineMessage } from "../api/caretakerApi";

type MoodLabel = "calm" | "anxious" | "agitated";
type IncidentType = "wandering" | "fall" | "agitation" | "other";

const TYPE_COLORS: Record<string, string> = {
  note: "#4F46E5", sleep: "#0EA5E9", mood: "#22C55E", incident: "#F97316",
  medication: "#A855F7", profile: "#64748B", call_session: "#EC4899", unknown: "#94A3B8",
};

function getMeta(msg: TimelineMessage) { return msg.metadata_ || {}; }
function getPrimaryISO(msg: TimelineMessage) { const md = getMeta(msg); return md.custom_timestamp || msg.timestamp || msg.created_at || ""; }
function getType(msg: TimelineMessage) { return (getMeta(msg).type || "unknown") as string; }
function timeFromISO(iso: string) { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ""; return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatDay(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toISOString().slice(0, 10);
  const day = d.toISOString().slice(0, 10);
  if (day === today) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (day === y.toISOString().slice(0, 10)) return "Yesterday";
  return day;
}

interface UpdatesTabProps {
  timeline: TimelineMessage[];
  onRefresh: () => Promise<void>;
  error: string;
  setError: (e: string) => void;
}

export default function UpdatesTab({ timeline, onRefresh, error, setError }: UpdatesTabProps) {
  const [type, setType] = useState<CaretakerEventType>("profile");
  const [text, setText] = useState("");
  const [sleepDuration, setSleepDuration] = useState(360);
  const [sleepWakeUps, setSleepWakeUps] = useState(2);
  const [sleepQuality, setSleepQuality] = useState(3);
  const [moodLabel, setMoodLabel] = useState<MoodLabel>("calm");
  const [moodSeverity, setMoodSeverity] = useState(3);
  const [incidentType, setIncidentType] = useState<IncidentType>("wandering");
  const [incidentSeverity, setIncidentSeverity] = useState(3);
  const [incidentDesc, setIncidentDesc] = useState("");
  const [medName, setMedName] = useState("Donepezil");
  const [medDose, setMedDose] = useState("10mg");
  const [medTaken, setMedTaken] = useState(true);
  const [medNote, setMedNote] = useState("");
  const [profilePatientName, setProfilePatientName] = useState("Abhishek");
  const [profileDiagnosis, setProfileDiagnosis] = useState("Early-stage Alzheimer's");
  const [profileMedicationPlan, setProfileMedicationPlan] = useState("Donepezil 10mg daily, Memantine 5mg evening");
  const [profileRoutine, setProfileRoutine] = useState("Wake 7:30am, breakfast 8am, morning walk 9am, lunch 12:30pm, nap 2-3pm, tea 4pm, dinner 7pm, bed 9:30pm");
  const [profileEmergencyContact, setProfileEmergencyContact] = useState("Ayush (caretaker) +91-7202849884");
  const [profileCalmingStrategies, setProfileCalmingStrategies] = useState("Play old Hindi songs, show family photos, gentle hand massage, offer chai");
  const [callPhone, setCallPhone] = useState("+917202849884");
  const [callStatus, setCallStatus] = useState<"idle" | "calling" | "success" | "error">("idle");
  const [callError, setCallError] = useState("");

  const handleCallPatient = async () => {
    const digits = callPhone.replace(/\D/g, "");
    if (digits.length < 9) { setCallError("Enter a valid phone number"); return; }
    setCallStatus("calling"); setCallError("");
    try {
      const res = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumber: callPhone }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Call failed");
      setCallStatus("success"); setTimeout(() => setCallStatus("idle"), 4000);
    } catch (err: any) {
      setCallStatus("error"); setCallError(err instanceof Error ? err.message : "Call failed");
      setTimeout(() => setCallStatus("idle"), 4000);
    }
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault(); setError("");
    try {
      const timestampISO = new Date().toISOString();
      const body: any = { type, text: text.trim() || undefined, timestampISO };
      if (type === "sleep") { body.data = { durationMinutes: Number(sleepDuration), wakeUps: Number(sleepWakeUps), quality: Number(sleepQuality) }; if (!body.text) body.text = `Sleep: ${sleepDuration} min, wakeUps ${sleepWakeUps}, quality ${sleepQuality}/5`; }
      if (type === "mood") { body.data = { mood: moodLabel, severity: Number(moodSeverity) }; if (!body.text) body.text = `Mood: ${moodLabel} (severity ${moodSeverity}/5)`; }
      if (type === "incident") { body.data = { incidentType, severity: Number(incidentSeverity), description: incidentDesc.trim() || undefined }; if (!body.text) body.text = `Incident: ${incidentType} (severity ${incidentSeverity}/5)`; }
      if (type === "medication") { body.data = { medication: medName.trim() || "Unknown", dose: medDose.trim() || undefined, taken: Boolean(medTaken), note: medNote.trim() || undefined }; if (!body.text) body.text = `Medication: ${medName || "Unknown"} (${medTaken ? "taken" : "missed"})`; }
      if (type === "profile") { body.data = { patientName: profilePatientName.trim() || undefined, diagnosis: profileDiagnosis.trim() || undefined, medicationPlan: profileMedicationPlan.trim() || undefined, baselineRoutine: profileRoutine.trim() || undefined, emergencyContact: profileEmergencyContact.trim() || undefined, calmingStrategies: profileCalmingStrategies.trim() || undefined }; if (!body.text) body.text = "Profile updated by caretaker."; }
      await addEvent(body);
      setText(""); setIncidentDesc(""); setMedNote("");
      if (type === "profile") { setProfilePatientName(""); setProfileDiagnosis(""); setProfileMedicationPlan(""); setProfileRoutine(""); setProfileEmergencyContact(""); setProfileCalmingStrategies(""); }
      await onRefresh();
    } catch (e2: any) { setError(e2?.message || "Failed to save entry"); }
  }

  const Chev = () => <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>;

  return (
    <div className="updates-layout">
      {/* ── LEFT: Call + Add Entry ── */}
      <div className="updates-left">
        {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}

        {/* Call */}
        <div className="col-card">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Call</span>
            <input className="form-input" type="tel" value={callPhone} onChange={(e) => setCallPhone(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className={`btn btn-call ${callStatus}`} onClick={handleCallPatient} disabled={callStatus === "calling"} style={{ height: 42, padding: "0 24px" }}>
              {callStatus === "calling" ? "Calling..." : callStatus === "success" ? "Initiated" : "Call"}
            </button>
          </div>
          {callStatus === "error" && callError && <span className="error-text" style={{ marginTop: 6, display: "block", fontSize: 12 }}>{callError}</span>}
        </div>

        {/* Add Entry */}
        <div className="col-card" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <form onSubmit={onSubmit} style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div className="form-group" style={{ marginBottom: 10, maxWidth: 180 }}>
              <label className="form-label">Type</label>
              <div className="select-wrapper">
                <select className="form-select" value={type} onChange={(e) => setType(e.target.value as CaretakerEventType)}>
                  <option value="profile">profile</option><option value="note">note</option><option value="sleep">sleep</option><option value="mood">mood</option>
                  <option value="incident">incident</option><option value="medication">medication</option>
                </select>
                <Chev />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 14, flex: 1, display: "flex", flexDirection: "column" }}>
              <label className="form-label">Text (optional)</label>
              <textarea className="form-input" placeholder="Observations..." value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, resize: "none", minHeight: 40 }} />
            </div>

            {type === "sleep" && (
              <div className="entry-fields-grid">
                <div className="form-group"><label className="form-label">Duration (min)</label><input className="form-input" type="number" value={sleepDuration} onChange={(e) => setSleepDuration(Number(e.target.value))} /></div>
                <div className="form-group"><label className="form-label">Wake ups</label><input className="form-input" type="number" value={sleepWakeUps} onChange={(e) => setSleepWakeUps(Number(e.target.value))} /></div>
                <div className="form-group"><label className="form-label">Quality (1-5)</label><input className="form-input" type="number" min={1} max={5} value={sleepQuality} onChange={(e) => setSleepQuality(Number(e.target.value))} /></div>
              </div>
            )}
            {type === "mood" && (
              <div className="entry-fields-grid">
                <div className="form-group"><label className="form-label">Mood</label><div className="select-wrapper"><select className="form-select" value={moodLabel} onChange={(e) => setMoodLabel(e.target.value as MoodLabel)}><option value="calm">calm</option><option value="anxious">anxious</option><option value="agitated">agitated</option></select><Chev /></div></div>
                <div className="form-group"><label className="form-label">Severity (1-5)</label><input className="form-input" type="number" min={1} max={5} value={moodSeverity} onChange={(e) => setMoodSeverity(Number(e.target.value))} /></div>
              </div>
            )}
            {type === "incident" && (
              <div className="entry-fields-grid">
                <div className="form-group"><label className="form-label">Type</label><div className="select-wrapper"><select className="form-select" value={incidentType} onChange={(e) => setIncidentType(e.target.value as IncidentType)}><option value="wandering">wandering</option><option value="fall">fall</option><option value="agitation">agitation</option><option value="other">other</option></select><Chev /></div></div>
                <div className="form-group"><label className="form-label">Severity (1-5)</label><input className="form-input" type="number" min={1} max={5} value={incidentSeverity} onChange={(e) => setIncidentSeverity(Number(e.target.value))} /></div>
                <div className="form-group" style={{ gridColumn: "1 / -1" }}><label className="form-label">Description</label><input className="form-input" value={incidentDesc} onChange={(e) => setIncidentDesc(e.target.value)} placeholder="What happened?" /></div>
              </div>
            )}
            {type === "medication" && (
              <div className="entry-fields-grid">
                <div className="form-group"><label className="form-label">Medication</label><input className="form-input" value={medName} onChange={(e) => setMedName(e.target.value)} placeholder="Donepezil" /></div>
                <div className="form-group"><label className="form-label">Dose</label><input className="form-input" value={medDose} onChange={(e) => setMedDose(e.target.value)} placeholder="5mg" /></div>
                <div className="form-group"><label className="form-label">Taken?</label><div className="select-wrapper"><select className="form-select" value={medTaken ? "yes" : "no"} onChange={(e) => setMedTaken(e.target.value === "yes")}><option value="yes">yes</option><option value="no">no</option></select><Chev /></div></div>
                <div className="form-group" style={{ gridColumn: "1 / -1" }}><label className="form-label">Note</label><input className="form-input" value={medNote} onChange={(e) => setMedNote(e.target.value)} placeholder="after breakfast" /></div>
              </div>
            )}
            {type === "profile" && (
              <div className="entry-fields-grid">
                <div className="form-group"><label className="form-label">Patient name</label><input className="form-input" value={profilePatientName} onChange={(e) => setProfilePatientName(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Diagnosis</label><input className="form-input" value={profileDiagnosis} onChange={(e) => setProfileDiagnosis(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Medication plan</label><input className="form-input" value={profileMedicationPlan} onChange={(e) => setProfileMedicationPlan(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Emergency contact</label><input className="form-input" value={profileEmergencyContact} onChange={(e) => setProfileEmergencyContact(e.target.value)} /></div>
                <div className="form-group" style={{ gridColumn: "1 / -1" }}><label className="form-label">Routine</label><input className="form-input" value={profileRoutine} onChange={(e) => setProfileRoutine(e.target.value)} /></div>
                <div className="form-group" style={{ gridColumn: "1 / -1" }}><label className="form-label">Calming strategies</label><input className="form-input" value={profileCalmingStrategies} onChange={(e) => setProfileCalmingStrategies(e.target.value)} /></div>
              </div>
            )}

            <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: "auto", paddingTop: 12, paddingBottom: 12 }}>Save Entry</button>
          </form>
        </div>
      </div>

      {/* ── RIGHT: Recent Activity ── */}
      <div className="updates-right">
        <div className="col-card" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <div className="col-card-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
            <h3>Recent Caretaker Activity</h3>
          </div>
          <div className="activity-scroll">
            {timeline.length === 0 ? (
              <div style={{ opacity: 0.5, padding: 20, textAlign: "center" }}>No entries yet</div>
            ) : (
              timeline.map((m) => {
                const iso = getPrimaryISO(m);
                const t = getType(m);
                const md = getMeta(m);
                const color = TYPE_COLORS[t] || TYPE_COLORS.unknown;
                return (
                  <div key={m.message_id} className="activity-item">
                    <div className="activity-type-dot" style={{ background: color }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <span className="activity-type-label" style={{ color }}>{t}</span>
                        <span className="activity-time">{formatDay(iso)} {timeFromISO(iso)}</span>
                      </div>
                      <div className="activity-content">{m.content}</div>
                      {md?.data && t !== "call_session" && (
                        <div className="activity-meta">
                          {Object.entries(md.data).filter(([, v]) => v != null).map(([k, v]) => (
                            <span key={k} className="activity-tag">{k}: {String(v)}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
