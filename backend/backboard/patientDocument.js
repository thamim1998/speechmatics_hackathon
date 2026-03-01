// backend/backboard/patientDocument.js
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DOC_PATH = path.join(DATA_DIR, "patient_profile.txt");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function buildPatientProfileDoc({ profileFacts = {} }) {
  ensureDir();

  const lines = [];
  lines.push("PATIENT PROFILE / CARE PLAN");
  lines.push("===========================");
  lines.push("");

  // Put stable facts here:
  if (profileFacts.patientName) lines.push(`Patient: ${profileFacts.patientName}`);
  if (profileFacts.diagnosis) lines.push(`Diagnosis: ${profileFacts.diagnosis}`);
  if (profileFacts.medicationPlan) lines.push(`Medication plan: ${profileFacts.medicationPlan}`);
  if (profileFacts.baselineRoutine) lines.push(`Routine: ${profileFacts.baselineRoutine}`);
  if (profileFacts.emergencyContact) lines.push(`Emergency contact: ${profileFacts.emergencyContact}`);
  if (profileFacts.calmingStrategies) lines.push(`Calming strategies: ${profileFacts.calmingStrategies}`);

  lines.push("");
  lines.push(`Last updated: ${new Date().toISOString()}`);

  fs.writeFileSync(DOC_PATH, lines.join("\n"), "utf8");
  return DOC_PATH;
}