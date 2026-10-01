import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SOUNDS_DIR, getEntry } from "./sounds.js";

const require = createRequire(import.meta.url);
let Revoice, MediaPlayer;
try {
  const rv = require("revoice.js");
  Revoice = rv.Revoice;
  MediaPlayer = rv.MediaPlayer || rv.Media;
} catch (e) {
  console.warn("[voice] revoice.js not installed — voice disabled", e.message);
}

// ffmpeg binary for the effects chain (transcode file -> s16le stream).
// Same static build family revoice uses; best-effort — fx disabled if missing.
let ffmpegPath = null;
try {
  ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch {
  ffmpegPath = null;
}
if (!ffmpegPath) console.warn("[voice] ffmpeg-static not found — voice effects disabled");

const BASE_URL = process.env.STOAT_BASE_URL || "https://stoat.chat/api";
const TOKEN = process.env.BOT_TOKEN;

let revoice = null;
let connections = new Map(); // channelId -> connection
let players = new Map(); // channelId -> MediaPlayer
let idleTimers = new Map(); // channelId -> timeout

function getRevoice() {
  if (!Revoice || !MediaPlayer) throw new Error("revoice_not_installed");
  if (!TOKEN || TOKEN === "your_bot_token_here") throw new Error("BOT_TOKEN missing");
  if (revoice) return revoice;
  const apiConfig = BASE_URL !== "https://stoat.chat/api" ? { baseURL: BASE_URL } : {};
  revoice = new Revoice(TOKEN, apiConfig);
  revoice.on("error", (e) => console.error("[voice] Revoice error", e));
  console.info(`[voice] Revoice initialized baseURL=${BASE_URL}`);
  return revoice;
}

function clearIdle(channelId){
  if(idleTimers.has(channelId)){ clearTimeout(idleTimers.get(channelId)); idleTimers.delete(channelId); }
}
function armIdle(channelId){
  clearIdle(channelId);
  const mins = 5 + Math.random()*5; // 5-10 min random to avoid thundering herd
  const ms = Math.round(mins*60*1000);
  const t = setTimeout(async ()=>{
    if(!connections.has(channelId)) return;
    console.info(`[voice] idle ${Math.round(ms/60000)}m → leaving ${channelId}`);
    try{ await leaveVoice(channelId); }catch(e){ console.warn("[voice] idle leave failed", e.message); }
  }, ms);
  // do not keep process alive
  if(t.unref) t.unref();
  idleTimers.set(channelId, t);
  console.info(`[voice] idle timer armed ${Math.round(ms/1000)}s for ${channelId}`);
}

export async function joinVoice(channelId, _retry=0) {
  return lockedJoin(channelId, _retry);
}
async function joinVoiceInner(channelId, _retry=0) {
  if (!channelId) throw new Error("missing_channelId");
  const rv = getRevoice();
  if (connections.has(channelId)){
    armIdle(channelId);
    return connections.get(channelId);
  }
  // also check revoice's internal map (survives our Map clear on restart)
  try{
    const existing = rv.getVoiceConnection(channelId);
    if(existing){
      connections.set(channelId, existing);
      armIdle(channelId);
      console.info(`[voice] reusing existing Revoice connection ${channelId}`);
      return existing;
    }
  }catch{}
  console.info(`[voice] joining ${channelId}...`);
  try{
    const conn = await Promise.race([
      rv.join(channelId),
      new Promise((_,rej)=> setTimeout(()=>rej(new Error("join_call_timeout_voice_server_not_responding")), 12000))
    ]);
    connections.set(channelId, conn);
    conn.on("join", () => { console.info(`[voice] joined ${channelId}`); armIdle(channelId); });
    conn.on("leave", () => {
      console.info(`[voice] left ${channelId}`);
      clearIdle(channelId);
      connections.delete(channelId);
      players.delete(channelId);
    });
    conn.on("autoleave", () => {
      console.info(`[voice] autoleave ${channelId}`);
      clearIdle(channelId);
      connections.delete(channelId);
    });
    if (!conn.connected) {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("join_timeout")), 15000);
        conn.once("join", () => { clearTimeout(t); res(); });
        conn.once("error", (e) => { clearTimeout(t); rej(e); });
      });
    }
    armIdle(channelId);
    return conn;
  }catch(e){
    const msg = e?.response?.data?.type || e?.message || String(e);
    const isAlready = msg.includes("AlreadyConnected") || JSON.stringify(e).includes("AlreadyConnected");
    if(isAlready){
      // server holds a stale voice session for the bot (common after restart).
      // Clear anything local instantly and fail fast — long waits hang the HTTP
      // request (Caddy 502) and spam-clicking join_call lags the voice server.
      console.warn(`[voice] AlreadyConnected for ${channelId}, clearing local state, fail fast`);
      for(const [cid, c] of Array.from(connections.entries())){
        try{ await c.leave(); }catch{}
        connections.delete(cid);
      }
      for(const [cid, c] of Array.from((rv.connections||new Map()).entries())){
        try{ await c.leave(); }catch{}
        rv.connections.delete(cid);
      }
      connections.delete(channelId);
      throw new Error("already_connected_stale_kick_bot_from_voice_then_retry_once");
    }
    throw e;
  }
}

export function clearVoiceState(){
  for(const cid of Array.from(connections.keys())){ try{ connections.delete(cid); }catch{} }
  for(const cid of Array.from(players.keys())){ try{ players.delete(cid); }catch{} }
  for(const cid of Array.from(idleTimers.keys())){ try{ clearIdle(cid); }catch{} }
  try{
    const rv = getRevoice();
    for(const cid of Array.from((rv.connections||new Map()).keys())){ try{ rv.connections.delete(cid); }catch{} }
  }catch{}
  console.info("[voice] clearVoiceState done");
  return true;
}
export async function leaveVoice(channelId) {
  clearIdle(channelId);
  const conn = connections.get(channelId);
  if (!conn) {
    const rv = getRevoice();
    const c = rv.getVoiceConnection(channelId);
    if (c) {
      try{ await c.leave(); }catch{}
      try{ rv.connections.delete(channelId); }catch{}
      connections.delete(channelId);
      players.delete(channelId);
      await new Promise(r=>setTimeout(r, 800));
      return true;
    }
    connections.delete(channelId);
    players.delete(channelId);
    try{ getRevoice().connections.delete(channelId); }catch{}
    return true;
  }
  try{ await conn.leave(); }catch(e){ console.warn("[voice] leave error", e.message); }
  clearIdle(channelId);
  connections.delete(channelId);
  players.delete(channelId);
  try{
    const rv = getRevoice();
    rv.connections.delete(channelId);
  }catch{}
  await new Promise(r=>setTimeout(r, 800));
  return true;
}

let playLock = new Set();
let joinLocks = new Map();
async function lockedJoin(channelId, _retry=0) {
  if (joinLocks.has(channelId)) return joinLocks.get(channelId);
  const p = joinVoiceInner(channelId, _retry);
  joinLocks.set(channelId, p);
  try { return await p; } finally { joinLocks.delete(channelId); }
}
export async function playInVoice(channelId, soundName) {
  const entry = getEntry(soundName);
  if (!entry) throw new Error("not_found");
  const filepath = path.join(SOUNDS_DIR, entry.filename);
  if (!fs.existsSync(filepath)) throw new Error("file_missing");
  // single active voice connection: leave others first to avoid multi-spawn lag
  let leftOther = false;
  for (const cid of Array.from(connections.keys())) {
    if (cid !== channelId) { try { await leaveVoice(cid); leftOther = true; } catch {} }
  }
  if (leftOther) await new Promise(r => setTimeout(r, 2000));
  const conn = await lockedJoin(channelId);
  clearIdle(channelId);
  // reuse one player per channel so we never stack LiveKit tracks
  let player = players.get(channelId);
  if (!player) {
    player = new MediaPlayer();
    try { player.setVolume(getVolume()); } catch {}
    players.set(channelId, player);
    player.on("finish", () => { armIdle(channelId); });
    player.on("error", () => { armIdle(channelId); });
    await conn.play(player);
    await new Promise(r => setTimeout(r, 200));
  } else {
    try { await player.stop(); } catch {}
    try { player.setVolume(getVolume()); } catch {}
    // ensure connection uses this player (re-publish only if replaced)
    if (conn.media !== player) {
      await conn.play(player);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  playLock.add(channelId);
  try {
    const chain = buildFilterChain(getFx());
    // FX output is headerless s16le: tell revoice's ffmpeg its format
    // explicitly, otherwise it misdetects the stream and plays silence.
    let stream = fs.createReadStream(filepath);
    let inputOptions = [];
    if (chain) {
      const fx = fxStream(filepath, chain);
      if (fx) {
        stream = fx;
        inputOptions = ["-f", "s16le", "-ar", "48000", "-ac", "2"];
      }
    }
    player.playStream(stream, inputOptions);
    console.info(`[voice] playing ${soundName} (${entry.filename}) in ${channelId}${chain ? ` fx=${chain}` : ""}`);
    return { channelId, soundName, filename: entry.filename };
  } finally { setTimeout(() => playLock.delete(channelId), 500); }
}

export function isVoiceConnected(channelId) {
  return connections.has(channelId);
}

export function listVoiceConnections() {
  return Array.from(connections.keys());
}
export function getVoiceDebug(channelId){
  const conn = connections.get(channelId);
  if(!conn) return { connected: false, hasConn: false, channelId };
  try{
    const room = conn.room;
    return {
      connected: !!conn.connected,
      hasConn: true,
      channelId,
      roomConnected: room ? (typeof room.isConnected === 'function' ? room.isConnected() : !!room.isConnected) : null,
      roomState: room?.state || null,
      participants: room ? Array.from(room.remoteParticipants?.keys?.() || []) : [],
      localParticipant: room?.localParticipant?.identity || null,
      trackPublised: !!conn.media
    };
  }catch(e){ return { error: e.message, channelId }; }
}

export async function stopVoice(channelId) {
  if(channelId){
    const p = players.get(channelId);
    // keep player instance so next play reuses the same published track
    if (p) { try{ await p.stop(); }catch{} }
    armIdle(channelId);
    return true;
  }
  for(const [cid, p] of Array.from(players.entries())){
    try{ await p.stop(); }catch{}
    armIdle(cid);
  }
  return true;
}
export async function stopAll(){
  // stop all audio but stay in voice (so next play is instant, no re-join)
  for(const [cid, p] of Array.from(players.entries())){
    try{ await p.stop(); }catch{}
  }
  console.info("[voice] stopAll done (stayed in voice)");
  return true;
}
export async function setVolume(volume, channelId){
  const vol = Math.max(0, Math.min(2, Number(volume)||1));
  for(const [cid, player] of players.entries()){
    if(channelId && cid!==channelId) continue;
    try{ player.setVolume(vol); }catch(e){ console.warn("[voice] setVolume fail", e.message); }
  }
  // store for next player
  globalThis._voiceVol = vol;
  console.info(`[voice] volume set ${vol} for ${channelId||'all'}`);
  return { volume: vol };
}
export function getVolume(){ return globalThis._voiceVol ?? 1; }

// ---- Voice effects (applied at play time via ffmpeg, next plays) ----
const FX_DEFAULTS = { pitch: 0, tempo: 100, reverb: 0, echo: 0, bass: 0 };

export function getFx() {
  return { ...FX_DEFAULTS, ...(globalThis._voiceFx || {}) };
}

export async function setFx(patch) {
  const cur = getFx();
  const num = (v, lo, hi, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const next = {
    pitch: num(patch?.pitch, -12, 12, cur.pitch),
    tempo: num(patch?.tempo, 50, 200, cur.tempo),
    reverb: num(patch?.reverb, 0, 100, cur.reverb),
    echo: num(patch?.echo, 0, 100, cur.echo),
    bass: num(patch?.bass, -20, 20, cur.bass),
  };
  globalThis._voiceFx = next;
  console.info(`[voice] fx set ${JSON.stringify(next)}`);
  return { fx: { ...next } };
}

// Pure: fx state -> ffmpeg -filter:a chain, or null when neutral.
export function buildFilterChain(fx) {
  const f = { ...FX_DEFAULTS, ...(fx || {}) };
  const parts = [];
  // normalize input rate first so pitch factor is rate-independent
  const shaped = f.pitch !== 0 || f.tempo !== 100 || f.reverb !== 0 || f.echo !== 0 || f.bass !== 0;
  if (!shaped) return null;
  parts.push("aresample=48000");
  if (f.pitch !== 0) {
    const factor = Math.pow(2, f.pitch / 12);
    parts.push(`asetrate=48000*${factor.toFixed(6)},aresample=48000`);
  }
  if (f.tempo !== 100) parts.push(`atempo=${(f.tempo / 100).toFixed(3)}`);
  if (f.reverb !== 0) {
    const d1 = Math.round(25 + f.reverb * 0.35);
    const d2 = Math.round(d1 * 1.8);
    parts.push(`aecho=0.8:${(0.45 + f.reverb / 400).toFixed(3)}:${d1}|${d2}:0.35|0.25`);
  }
  if (f.echo !== 0) {
    const d = Math.round(180 + f.echo * 3);
    parts.push(`aecho=0.8:${(0.4 + f.echo / 500).toFixed(3)}:${d}:0.45`);
  }
  if (f.bass !== 0) parts.push(`bass=g=${f.bass}`);
  return parts.join(",");
}

// Transcode filepath through the fx chain, returning a readable s16le
// stream suitable for player.playStream(). Falls back to null on error
// so the caller can play the raw file instead.
export function fxStream(filepath, chain) {
  if (!ffmpegPath || !chain) return null;
  try {
    const child = spawn(ffmpegPath, [
      "-v", "error", "-i", filepath,
      "-filter:a", chain,
      "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (e) => console.warn("[voice] fx ffmpeg spawn failed, falling back to raw:", e.message));
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += String(c).slice(0, 300); });
    child.on("close", (code) => {
      if (code !== 0 && code !== null) console.warn(`[voice] fx ffmpeg exited ${code}: ${stderr.slice(0, 200)}`);
    });
    return child.stdout;
  } catch (e) {
    console.warn("[voice] fx stream failed, falling back to raw:", e.message);
    return null;
  }
}
