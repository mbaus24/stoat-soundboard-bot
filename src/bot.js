import { Client } from "stoat.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getSounds, getEntry, addSound, deleteSound, renameSound, saveRegistry, SOUNDS_DIR } from "./sounds.js";

const TOKEN = process.env.BOT_TOKEN;
const PREFIX = process.env.PREFIX || "!sb";
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "8", 10);
const BASE_URL = process.env.STOAT_BASE_URL || process.env.STOAT_API_URL || "https://stoat.chat/api";

const TOKEN_INVALID = !TOKEN || TOKEN === "your_bot_token_here" || TOKEN.length < 10;
if (TOKEN_INVALID) {
  console.warn("[bot] BOT_TOKEN not set or placeholder — web UI will run but bot offline. Set BOT_TOKEN in .env and restart.");
}

export const client = new Client(BASE_URL !== "https://stoat.chat/api" ? { baseURL: BASE_URL } : undefined);

// Prevent crash on InvalidSession / disconnect - keep web UI alive
client.on("error", (err) => {
  console.error("[bot] error event (bot will stay offline, web UI ok):", err?.message || err);
});
console.info(`[bot] Using baseURL: ${BASE_URL}`);
client.on("disconnected", () => {
  console.warn("[bot] disconnected");
});
process.on("unhandledRejection", (r) => console.error("[bot] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[bot] uncaughtException (keeping alive):", e.message));

function helpText() {
  return `**Soundboard Bot** — prefix \`${PREFIX}\`
\`${PREFIX} help\` — aide
\`${PREFIX} list\` — liste
\`${PREFIX} add <name>\` + fichier — ajoute
\`${PREFIX} play <name>\` / \`${PREFIX} <name>\` — poste en texte
\`${PREFIX} vjoin [voiceId]\` — rejoint le vocal (auto si t'es dedans)
\`${PREFIX} vplay <name>\` — joue DANS le vocal
\`${PREFIX} vleave\` — quitte le vocal
\`${PREFIX} vstop\` — stoppe le son vocal
\`${PREFIX} delete <name>\` — supprime
Web UI: http://NAS_IP:${process.env.WEB_PORT || 3000}`;
}

client.on("ready", async () => {
  console.info(`[bot] Logged in as ${client.user.username} (${client.user._id})`);
  console.info(`[bot] Prefix: "${PREFIX}" | Sounds: ${Object.keys(getSounds()).length}`);
});

client.on("messageCreate", async (message) => {
  if (message.authorId === client.user?._id) return;
  if (!message.content) return;
  const content = message.content.trim();
  if (!content.startsWith(PREFIX)) return;

  const argsRaw = content.slice(PREFIX.length).trim();
  const [cmd, ...rest] = argsRaw.split(/\s+/);
  if (!cmd) { await message.channel.sendMessage(helpText()); return; }
  const lowerCmd = cmd.toLowerCase();
  const sounds = getSounds();

  if (!["help","list","ls","add","upload","play","p","delete","del","rm","remove","rename","mv"].includes(lowerCmd)) {
    if (sounds[lowerCmd]) return handlePlay(message.channel, lowerCmd);
    await message.channel.sendMessage(`Inconnu \`${cmd}\`. \`${PREFIX} list\` / \`${PREFIX} help\``);
    return;
  }

  switch(lowerCmd) {
    case "help": await message.channel.sendMessage(helpText()); break;
    case "vjoin": {
      const voiceId = rest[0] || await getUserVoiceChannel(message);
      if (!voiceId) { await message.channel.sendMessage(`Tu n'es dans aucun vocal. Usage: \`${PREFIX} vjoin <voiceChannelId>\``); break; }
      try {
        const { joinVoice } = await import("./voice.js");
        await joinVoice(voiceId);
        await message.channel.sendMessage(`✅ Rejoint vocal <#${voiceId}>`);
      } catch(e){ await message.channel.sendMessage(`Erreur vjoin: ${e.message}`); }
      break;
    }
    case "vleave":
    case "vquit": {
      const voiceId = rest[0] || await getUserVoiceChannel(message) || voiceFallbackId();
      if (!voiceId) { await message.channel.sendMessage(`Usage: \`${PREFIX} vleave <voiceChannelId>\``); break; }
      try {
        const { leaveVoice } = await import("./voice.js");
        await leaveVoice(voiceId);
        await message.channel.sendMessage(`👋 Quitté <#${voiceId}>`);
      } catch(e){ await message.channel.sendMessage(`Erreur vleave: ${e.message}`); }
      break;
    }
    case "vplay":
    case "vp":
    case "vsay": {
      const name = rest[0]?.toLowerCase();
      const voiceId = rest[1] || await getUserVoiceChannel(message) || voiceFallbackId();
      if (!name) { await message.channel.sendMessage(`Usage: \`${PREFIX} vplay <name> [voiceChannelId]\``); break; }
      if (!voiceId) { await message.channel.sendMessage(`Pas de vocal trouvé. Rejoins un vocal ou \`${PREFIX} vjoin <id>\``); break; }
      try {
        const { playInVoice } = await import("./voice.js");
        await playInVoice(voiceId, name);
        await message.channel.sendMessage(`🔊 Joue \`${name}\` dans <#${voiceId}>`);
      } catch(e){ await message.channel.sendMessage(`Erreur vplay: ${e.message}`); }
      break;
    }
    case "vstop":
    case "vpause": {
      const voiceId = rest[0] || await getUserVoiceChannel(message) || voiceFallbackId();
      if (!voiceId) { await message.channel.sendMessage(`Usage: \`${PREFIX} vstop [voiceChannelId]\``); break; }
      try {
        const { stopVoice } = await import("./voice.js");
        await stopVoice(voiceId);
        await message.channel.sendMessage(`⏹️ Stop vocal`);
      } catch(e){ await message.channel.sendMessage(`Erreur vstop: ${e.message}`); }
      break;
    }
    case "list": case "ls": {
      const names = Object.keys(sounds).sort();
      if (!names.length) await message.channel.sendMessage(`Aucun son. Ajoute via Web UI ou \`${PREFIX} add <name>\` + fichier.`);
      else {
        const lines = names.map(n => `• \`${n}\` — ${sounds[n].filename} (${(sounds[n].size/1024).toFixed(1)}KB)`);
        const chunk=15;
        for(let i=0;i<lines.length;i+=chunk) await message.channel.sendMessage(`**Sounds (${names.length}):**\n${lines.slice(i,i+chunk).join("\n")}`);
      }
      break;
    }
    case "add": case "upload": {
      const name = rest[0]?.toLowerCase();
      if (!name || !/^[a-z0-9_-]{1,30}$/.test(name)) { await message.channel.sendMessage(`Usage: \`${PREFIX} add <name>\` + fichier joint (a-z,0-9,_,-, 1-30)`); return; }
      if (sounds[name]) { await message.channel.sendMessage(`\`${name}\` existe déjà.`); return; }
      const att = (message.attachments||[])[0];
      if (!att) { await message.channel.sendMessage(`Attache un fichier audio (mp3/ogg/wav/webm/m4a <${MAX_FILE_SIZE_MB}MB)`); return; }
      if (att.size > MAX_FILE_SIZE_MB*1024*1024) { await message.channel.sendMessage(`Trop gros: ${Math.round(att.size/1024/1024)}MB > ${MAX_FILE_SIZE_MB}MB`); return; }
      try {
        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`download ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await addSound(name, { filename: att.filename||`${name}.mp3`, data: buf, uploader: message.authorId, contentType: att.contentType });
        await message.channel.sendMessage(`Ajouté \`${name}\` (${(buf.length/1024).toFixed(1)}KB). Joue: \`${PREFIX} play ${name}\``);
      } catch(e){ await message.channel.sendMessage(`Erreur: ${e.message}`); }
      break;
    }
    case "play": case "p": {
      const name = rest[0]?.toLowerCase();
      if (!name) { await message.channel.sendMessage(`Usage: \`${PREFIX} play <name>\``); return; }
      await handlePlay(message.channel, name);
      break;
    }
    case "delete": case "del": case "rm": case "remove": {
      const name = rest[0]?.toLowerCase();
      if (!name || !getEntry(name)) { await message.channel.sendMessage(`\`${name||"?"}\` introuvable.`); return; }
      await deleteSound(name);
      await message.channel.sendMessage(`Supprimé \`${name}\``);
      break;
    }
    case "rename": case "mv": {
      const [o,n] = rest.map(s=>s?.toLowerCase());
      if (!o||!n||!getEntry(o)) { await message.channel.sendMessage(`Usage: \`${PREFIX} rename <old> <new>\``); return; }
      try { await renameSound(o,n); await message.channel.sendMessage(`Renommé \`${o}\` → \`${n}\``); } catch(e){ await message.channel.sendMessage(`Erreur: ${e.message}`); }
      break;
    }
  }
});

export async function handlePlay(channel, name) {
  const entry = getEntry(name);
  if (!entry) { await channel.sendMessage(`Son \`${name}\` introuvable.`); return; }
  const filepath = path.join(SOUNDS_DIR, entry.filename);
  try { await fs.access(filepath); } catch { await channel.sendMessage(`Fichier manquant: ${entry.filename}`); return; }
  const data = await fs.readFile(filepath);
  try {
    // Correct stoat.js flow: upload via autumn then send attachment id
    const file = new File([data], entry.filename, { type: entry.contentType || "audio/mpeg" });
    const attachId = await client.uploadFile("attachments", file);
    await channel.sendMessage({ content: `🔊 \`${name}\``, attachments: [attachId] });
  } catch (e) {
    console.error("[play] send failed", e?.message || e);
    try {
      await channel.sendMessage(`Erreur envoi \`${name}\`: ${e?.message || e}`);
    } catch {}
    throw e;
  }
}

function voiceFallbackId() {
  return process.env.VOICE_CHANNEL_ID || process.env.DEFAULT_VOICE_CHANNEL_ID || null;
}
async function getUserVoiceChannel(message) {
  // try to find voice channel where author is connected (via client voice state or via API)
  try {
    // stoat.js may track voice participants; fallback: check server voice channels
    const member = client.serverMembers.get(`${message.serverId || ""}:${message.authorId}`);
    // not reliable, so try API: GET /servers/:id/members/:id
    // For now, return null and let caller use voiceFallbackId
  } catch {}
  return null;
}

// allow web server to trigger play by channelId
export async function playInChannel(channelId, name) {
  const entry = getEntry(name);
  if (!entry) throw new Error("not_found");
  // fetch channel via client
  let channel;
  try {
    channel = client.channels.get(channelId);
    if (!channel) {
      // try fetch via API if not cached
      const fetched = await client.api.get(`/channels/${channelId}`);
      // hydrating not needed, we use raw send via API
      // fallback: use client's internal fetch
      channel = client.channels.get(channelId);
      if (!channel && fetched) {
        // create temporary channel-like object with sendMessage via API
        const filepath = path.join(SOUNDS_DIR, entry.filename);
        const data = await fs.readFile(filepath);
        // upload then send — reuse handlePlay logic via API
        // We attempt direct API message send with attachment upload helper if available
        // As generic fallback, try client.channels.get after ready
        throw new Error("channel_not_cached_try_restart_or_use_valid_id");
      }
    }
  } catch(e){ /* */ }
  if (!channel) throw new Error("channel_not_found");
  await handlePlay(channel, name);
}

export async function startBot() {
  if (TOKEN_INVALID) throw new Error("BOT_TOKEN missing or placeholder");
  await client.loginBot(TOKEN);
}
