import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getSounds, addSound, deleteSound, renameSound, SOUNDS_DIR } from "./sounds.js";
import { playInChannel, client } from "./bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.WEB_PORT || "3000", 10);
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "8", 10);
const WEB_PASSWORD = process.env.WEB_PASSWORD || ""; // if set, require ?token= or header
const DEFAULT_CHANNEL = process.env.DEFAULT_CHANNEL_ID || "";
const DEFAULT_VOICE = process.env.VOICE_CHANNEL_ID || process.env.DEFAULT_VOICE_CHANNEL_ID || "";

app.use(express.json());

// Simple auth middleware for API if WEB_PASSWORD set
function auth(req, res, next) {
  if (!WEB_PASSWORD) return next();
  const token = req.headers["x-token"] || req.query.token || req.body?.token;
  if (token === WEB_PASSWORD) return next();
  // also allow basic auth style
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ") && authHeader.slice(7) === WEB_PASSWORD) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// Serve static UI
app.use(express.static(path.join(__dirname, "..", "public")));

// Serve sounds for preview (read-only)
app.get("/sounds/:filename", async (req, res) => {
  const fp = path.join(SOUNDS_DIR, path.basename(req.params.filename));
  try { await fs.access(fp); res.sendFile(fp); } catch { res.status(404).send("not found"); }
});

// API
app.get("/api/sounds", auth, (req, res) => {
  const sounds = getSounds();
  const list = Object.entries(sounds).map(([name, meta]) => ({ name, ...meta }));
  list.sort((a,b)=>a.name.localeCompare(b.name));
  const categories = [...new Set(list.map(s => s.category || "General"))].sort();
  res.json({ sounds: list, categories, defaultChannel: DEFAULT_CHANNEL, defaultVoice: DEFAULT_VOICE });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /audio|video\/ogg|video\/webm/.test(file.mimetype) || /\.(mp3|ogg|wav|webm|m4a|flac|opus)$/i.test(file.originalname);
    cb(null, ok);
  }
});

app.post("/api/sounds", auth, upload.single("file"), async (req, res) => {
  const name = (req.body.name || "").toLowerCase().trim();
  const category = (req.body.category || "General").trim();
  if (!name || !/^[a-z0-9_-]{1,30}$/.test(name)) return res.status(400).json({ error: "invalid_name", detail: "a-z,0-9,_,-, 1-30 chars" });
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const entry = await addSound(name, { filename: req.file.originalname, data: req.file.buffer, uploader: "web", contentType: req.file.mimetype, category });
    res.json({ ok: true, name, entry });
  } catch (e) {
    if (e.message === "exists") return res.status(409).json({ error: "exists" });
    if (e.message === "invalid_name") return res.status(400).json({ error: "invalid_name" });
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/sounds/:name", auth, async (req, res) => {
  try { await deleteSound(req.params.name); res.json({ ok: true }); }
  catch(e){ res.status(e.message==="not_found"?404:500).json({ error: e.message }); }
});

app.post("/api/sounds/:name/rename", auth, async (req, res) => {
  const newName = (req.body.newName || "").toLowerCase().trim();
  if (!newName) return res.status(400).json({ error: "missing_newName" });
  try { await renameSound(req.params.name, newName); res.json({ ok: true, newName }); }
  catch(e){ res.status(400).json({ error: e.message }); }
});

// Play trigger — bot posts sound in Stoat channel
app.post("/api/play/:name", auth, async (req, res) => {
  const name = req.params.name.toLowerCase();
  const channelId = (req.body.channelId || req.query.channelId || DEFAULT_CHANNEL || "").trim();
  if (!channelId) return res.status(400).json({ error: "missing_channelId", detail: "Provide channelId or set DEFAULT_CHANNEL_ID env" });
  if (!client.user) return res.status(503).json({ error: "bot_not_ready" });
  try {
    await playInChannel(channelId, name);
    res.json({ ok: true, channelId, name });
  } catch(e){
    const code = e.message==="not_found"?404 : e.message==="channel_not_found"?404 : 500;
    res.status(code).json({ error: e.message });
  }
});

// also allow GET for simple trigger via browser
app.get("/api/play/:name", auth, async (req,res)=>{
  req.body = { channelId: req.query.channelId };
  return app._router.handle({ ...req, method: "POST", url: `/api/play/${req.params.name}` }, res);
});

// Voice API
app.get("/api/voice/status", auth, async (req,res)=>{
  try {
    const { listVoiceConnections, isVoiceConnected } = await import("./voice.js");
    res.json({ connections: listVoiceConnections(), defaultVoice: DEFAULT_VOICE });
  } catch(e){ res.json({ connections: [], defaultVoice: DEFAULT_VOICE, error: e.message }); }
});
app.post("/api/voice/join", auth, async (req,res)=>{
  const channelId = (req.body.channelId || req.query.channelId || DEFAULT_VOICE || "").trim();
  if (!channelId) return res.status(400).json({ error: "missing_channelId" });
  try {
    const { joinVoice } = await import("./voice.js");
    await joinVoice(channelId);
    res.json({ ok:true, channelId });
  } catch(e){ res.status(500).json({ error: e.message }); }
});
app.post("/api/voice/leave", auth, async (req,res)=>{
  const channelId = (req.body.channelId || req.query.channelId || DEFAULT_VOICE || "").trim();
  if (!channelId) return res.status(400).json({ error: "missing_channelId" });
  try {
    const { leaveVoice } = await import("./voice.js");
    await leaveVoice(channelId);
    res.json({ ok:true, channelId });
  } catch(e){ res.status(500).json({ error: e.message }); }
});
app.post("/api/voice/play/:name", auth, async (req,res)=>{
  const name = req.params.name.toLowerCase();
  const channelId = (req.body.channelId || req.query.channelId || DEFAULT_VOICE || "").trim();
  if (!channelId) return res.status(400).json({ error: "missing_channelId", detail: "Set VOICE_CHANNEL_ID or provide channelId" });
  if (!client.user) return res.status(503).json({ error: "bot_not_ready" });
  try {
    const { playInVoice } = await import("./voice.js");
    await playInVoice(channelId, name);
    res.json({ ok:true, channelId, name, mode:"voice" });
  } catch(e){
    const code = e.message==="not_found"?404:500;
    res.status(code).json({ error: e.message });
  }
});
app.post("/api/voice/stop", auth, async (req,res)=>{
  const channelId = (req.body.channelId || req.query.channelId || DEFAULT_VOICE || "").trim();
  if (!channelId) return res.status(400).json({ error: "missing_channelId" });
  try {
    const { stopVoice } = await import("./voice.js");
    await stopVoice(channelId);
    res.json({ ok:true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Channels - fetch via API to get real names
app.get("/api/channels", auth, async (req,res)=>{
  if (!client.user) return res.json({ servers: [] });
  try {
    const servers = [];
    for (const server of client.servers.values()) {
      const chans = [];
      // Use server.channels list as source of truth, fetch each via API if needed
      const ids = server.channels || [];
      for (const cid of ids) {
        const id = typeof cid === 'string' ? cid : (cid._id || cid.id || String(cid));
        let ch = client.channels.get(id);
        // try cache first, else fetch via API for real name/type
        if (!ch) {
          try {
            const fetched = await client.api.get(`/channels/${id}`);
            if (fetched) {
              // stoat.js will hydrate on next event, but use fetched directly
              ch = fetched;
            }
          } catch {}
        }
        if (ch) {
          const hasVoice = ch.voice !== undefined && ch.voice !== null;
          chans.push({
            _id: ch._id || id,
            name: ch.name || ch.displayName || id,
            channel_type: ch.channel_type || ch.type || (hasVoice ? "VoiceChannel" : "TextChannel"),
            voice: hasVoice,
            server: server._id
          });
        } else {
          chans.push({ _id: id, name: String(id).slice(0,8), channel_type: "TextChannel", voice: false, server: server._id });
        }
      }
      // Fallback: also add any cached channels that belong to this server but not in list
      for (const ch of client.channels.values()) {
        const sid = ch.serverId || ch.server || ch.server_id;
        if (sid === server._id && !chans.find(c=>c._id===ch._id)) {
          const hasV = ch.voice !== undefined && ch.voice !== null;
          chans.push({
            _id: ch._id,
            name: ch.name || ch.displayName || ch._id,
            channel_type: ch.channel_type || ch.type || (hasV ? "VoiceChannel" : "TextChannel"),
            voice: hasV,
            server: server._id
          });
        }
      }
      servers.push({ _id: server._id, name: server.name, channels: chans });
    }
    res.json({ servers });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Health
app.get("/api/health", (req,res)=> res.json({ ok:true, botReady: !!client.user, bot: client.user?.username || null, sounds: Object.keys(getSounds()).length, voiceDefault: DEFAULT_VOICE, defaultChannel: DEFAULT_CHANNEL }));

export function startServer() {
  return new Promise(resolve => {
    const srv = app.listen(PORT, "0.0.0.0", () => {
      console.info(`[web] UI listening on http://0.0.0.0:${PORT} (NAS: http://192.168.1.83:${PORT} via WireGuard)`);
      if (WEB_PASSWORD) console.info(`[web] Password protection enabled`);
      if (DEFAULT_CHANNEL) console.info(`[web] Default text channel: ${DEFAULT_CHANNEL}`);
      if (DEFAULT_VOICE) console.info(`[web] Default voice channel: ${DEFAULT_VOICE}`);
      resolve(srv);
    });
  });
}
