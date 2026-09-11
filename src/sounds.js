import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SOUNDS_DIR = path.join(__dirname, "..", "sounds");
export const DATA_FILE = path.join(SOUNDS_DIR, "sounds.json");

await fs.mkdir(SOUNDS_DIR, { recursive: true });

let sounds = {};
try {
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  sounds = JSON.parse(raw);
} catch { /* first run */ }

export function getSounds() { return sounds; }

export async function saveRegistry() {
  await fs.writeFile(DATA_FILE, JSON.stringify(sounds, null, 2));
}

export function getEntry(name) { return sounds[name.toLowerCase()]; }

export async function addSound(name, { filename, data, uploader, contentType, category }) {
  const key = name.toLowerCase();
  if (sounds[key]) throw new Error("exists");
  if (!/^[a-z0-9_-]{1,30}$/.test(key)) throw new Error("invalid_name");
  const ext = path.extname(filename || ".mp3") || ".mp3";
  const destName = `${key}${ext}`;
  const dest = path.join(SOUNDS_DIR, destName);
  await fs.writeFile(dest, data);
  const cat = (category || "General").trim() || "General";
  sounds[key] = { filename: destName, uploader: uploader || "web", createdAt: new Date().toISOString(), size: data.length, contentType, category: cat };
  await saveRegistry();
  return sounds[key];
}

export async function deleteSound(name) {
  const key = name.toLowerCase();
  const entry = sounds[key];
  if (!entry) throw new Error("not_found");
  try { await fs.unlink(path.join(SOUNDS_DIR, entry.filename)); } catch {}
  delete sounds[key];
  await saveRegistry();
}

export async function renameSound(oldName, newName) {
  const oldKey = oldName.toLowerCase();
  const newKey = newName.toLowerCase();
  if (!sounds[oldKey]) throw new Error("not_found");
  if (sounds[newKey]) throw new Error("exists");
  if (!/^[a-z0-9_-]{1,30}$/.test(newKey)) throw new Error("invalid_name");
  const entry = sounds[oldKey];
  const ext = path.extname(entry.filename);
  const newFilename = `${newKey}${ext}`;
  try { await fs.rename(path.join(SOUNDS_DIR, entry.filename), path.join(SOUNDS_DIR, newFilename)); } catch {}
  sounds[newKey] = { ...entry, filename: newFilename };
  delete sounds[oldKey];
  await saveRegistry();
}
