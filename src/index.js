import { startBot } from "./bot.js";
import { startServer } from "./server.js";

// Start bot + web UI together (shared volume ./sounds)
await startServer();
console.info("[web] ready, connecting bot...");
try {
  await startBot();
  console.info("[main] Soundboard bot + web UI ready");
} catch (e) {
  console.error("[bot] login failed — web UI still available for uploads:", e.message);
  console.info("[main] Web UI ready (bot offline, set BOT_TOKEN and restart)");
}
