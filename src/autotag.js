import { parseBuffer } from "music-metadata";

// Canonical people list — mirrors PEOPLE in public/index.html.
// Registry people (from sounds.json) are added to this at match time.
export const DEFAULT_PEOPLE = [
  "ThD", "Cdellies", "Tooki", "Titiver", "Arbow", "Ambroze", "Nail",
  "McRaclette", "Doko", "Martin", "Salemium", "Léa", "Toileking", "Delta",
  "LouvAndTech", "Wazo",
];

// Aliases: normalized metadata name -> canonical person.
// For people credited under a different name in file tags
// (e.g. Titi28043 is Martin). Keys must already be normalized
// (lowercase, no accents) — see norm().
export const PEOPLE_ALIASES = {
  titi28043: "Martin",
  deltarobase: "Delta",
  victor: "Nail",
  jaituia: "Doko",
  hypermat: "McRaclette",
  thea: "Salemium",
  "thea dorangeon": "Salemium",
  eno: "Ambroze",
  toiletking: "Toileking",
  cdelies: "Cdellies",
};

// Lowercase + strip accents so "Léa" matches "lea", "LEA", etc.
export function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Split "a,b;c & d feat. e" style tag values into candidate tokens.
function splitArtists(v) {
  if (Array.isArray(v)) return v.flatMap(splitArtists);
  return String(v || "")
    .split(/[,;/&]| feat\.? | ft\.? | vs\.? | x /i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Best-effort audio tag read. Never throws — returns {} on failure.
export async function readTags(data, mime) {
  try {
    const meta = await parseBuffer(Buffer.from(data), mime || undefined);
    const c = meta.common || {};
    return {
      artist: splitArtists(c.artist || c.artists),
      albumArtist: splitArtists(c.albumartist),
      composer: splitArtists(c.composer),
      lyricist: splitArtists(c.lyricist),
      title: c.title ? [String(c.title)] : [],
      album: c.album ? [String(c.album)] : [],
      comment: (c.comment || []).map((x) => (typeof x === "string" ? x : x.text)).filter(Boolean),
      genre: c.genre || [],
    };
  } catch {
    return {};
  }
}

// Flatten tag object into searchable strings.
function tagStrings(tags) {
  const out = [];
  for (const v of Object.values(tags || {})) {
    if (Array.isArray(v)) out.push(...v);
    else if (v) out.push(v);
  }
  return out.map((s) => String(s)).filter(Boolean);
}

// True if the normalized person name appears as a standalone token in the
// normalized haystack, e.g. "tooki" matches "tooki_laugh.mp3" or
// "Tooki - laugh". Strict token equality on purpose: "martinez" must NOT
// tag "Martin" — a false positive is worse than a missed tag here.
function nameMatches(needle, haystack) {
  if (!needle || !haystack) return false;
  return haystack.split(/[^a-z0-9]+/).filter(Boolean).includes(needle);
}

// Detect known people from sound name, original filename, bulk-upload
// relative path (e.g. "Downloads/Tooki/laugh.mp3"), and audio metadata.
// Only matches names in knownPeople — never invents new tags.
// Returns canonical-cased names, deduped, order preserved.
export function detectPeople({ name, filename, sourcePath, tags } = {}, knownPeople = []) {
  const haystacks = norm(
    [name, filename, sourcePath, ...tagStrings(tags)].filter(Boolean).join(" "),
  );
  // Also match per-tag-value: "artist: tooki" should hit even if the
  // joined haystack only helps via tokens — same thing, but keep the
  // joined string as the single matching surface (simpler + sufficient).
  const out = [];
  for (const person of knownPeople || []) {
    const p = String(person || "").trim();
    if (!p || out.includes(p)) continue;
    if (nameMatches(norm(p), haystacks)) out.push(p);
  }
  // Aliases: metadata credited under another name (Titi28043 -> Martin).
  // Only applied when the target is a known person. Multi-word aliases
  // match as substrings; single-word ones as strict tokens.
  const knownSet = new Set((knownPeople || []).map((p) => String(p || "").trim()).filter(Boolean));
  for (const [alias, target] of Object.entries(PEOPLE_ALIASES)) {
    if (!knownSet.has(target) || out.includes(target)) continue;
    const hit = alias.includes(" ") ? haystacks.includes(alias) : nameMatches(alias, haystacks);
    if (hit) out.push(target);
  }
  return out;
}

// Union preserving order, capped like normalizePeople.
export function mergePeople(explicit, auto, cap = 14) {
  const out = [];
  for (const p of [...(explicit || []), ...(auto || [])]) {
    const s = String(p || "").trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}
