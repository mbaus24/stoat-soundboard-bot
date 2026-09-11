import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
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
    const conn = await rv.join(channelId);
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
      console.warn(`[voice] AlreadyConnected for ${channelId}, trying to recover...`);
      // try to find any existing connection for this server and leave it, then retry
      if(_retry < 2){
        // wait a bit for LiveKit to clear stale (server holds it ~30s)
        await new Promise(r=>setTimeout(r, 3000));
        // try to force leave via any existing connection on same server
        for(const [cid, c] of connections.entries()){
          try{ await c.leave(); }catch{}
        }
        // also try revoice's internal connections
        for(const [cid, c] of (rv.connections||new Map()).entries()){
          if(cid!==channelId) continue;
          try{ await c.leave(); }catch{}
        }
        // wait for server to clear
        await new Promise(r=>setTimeout(r, 2000));
        return joinVoice(channelId, _retry+1);
      }
      throw new Error("already_connected_try_leave_first_or_wait_30s");
    }
    throw e;
  }
}

export async function leaveVoice(channelId) {
  clearIdle(channelId);
  const conn = connections.get(channelId);
  if (!conn) {
    const rv = getRevoice();
    const c = rv.getVoiceConnection(channelId);
    if (c) {
      await c.leave();
      return true;
    }
    throw new Error("not_connected");
  }
  await conn.leave();
  clearIdle(channelId);
  connections.delete(channelId);
  players.delete(channelId);
  return true;
}

export async function playInVoice(channelId, soundName) {
  const entry = getEntry(soundName);
  if (!entry) throw new Error("not_found");
  const filepath = path.join(SOUNDS_DIR, entry.filename);
  if (!fs.existsSync(filepath)) throw new Error("file_missing");
  const conn = await joinVoice(channelId);
  clearIdle(channelId);
  const old = players.get(channelId);
  if (old) {
    try { old.stop(); } catch {}
  }
  const player = new MediaPlayer();
  const vol = getVolume();
  try{ player.setVolume(vol); }catch{}
  players.set(channelId, player);
  player.once("finish", ()=> armIdle(channelId));
  player.once("error", ()=> armIdle(channelId));
  await conn.play(player);
  await new Promise(r => setTimeout(r, 200));
  player.playStream(fs.createReadStream(filepath));
  console.info(`[voice] playing ${soundName} (${entry.filename}) in ${channelId}`);
  return { channelId, soundName, filename: entry.filename };
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
  const p = players.get(channelId);
  if (p) {
    p.stop();
    players.delete(channelId);
  }
  armIdle(channelId);
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
