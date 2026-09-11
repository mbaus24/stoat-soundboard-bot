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

export async function joinVoice(channelId) {
  if (!channelId) throw new Error("missing_channelId");
  const rv = getRevoice();
  if (connections.has(channelId)){
    armIdle(channelId);
    return connections.get(channelId);
  }
  console.info(`[voice] joining ${channelId}...`);
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
  // wait for join event if not yet connected
  if (!conn.connected) {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("join_timeout")), 15000);
      conn.once("join", () => { clearTimeout(t); res(); });
      conn.once("error", (e) => { clearTimeout(t); rej(e); });
    });
  }
  armIdle(channelId);
  return conn;
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

export async function stopVoice(channelId) {
  const p = players.get(channelId);
  if (p) {
    p.stop();
    players.delete(channelId);
  }
  armIdle(channelId);
  return true;
}
