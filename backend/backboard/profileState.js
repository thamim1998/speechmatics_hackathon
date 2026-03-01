// backend/backboard/profileState.js
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "patient_profile.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadProfile() {
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveProfile(profile) {
  ensureDir();
  fs.writeFileSync(FILE_PATH, JSON.stringify(profile, null, 2), "utf8");
}