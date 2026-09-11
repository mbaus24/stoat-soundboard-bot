# Stoat Soundboard — Bot + App

Bot Stoat + interface web pour gérer une soundboard, hébergé sur ton NAS `192.168.1.83` derrière **WireGuard**. Basé sur [awesome-stoat](https://github.com/stoatchat/awesome-stoat) / [`stoat.js` 7.3.6](https://github.com/stoatchat/javascript-client-sdk).

**2 composants dans 1 conteneur** (partagent `./sounds`):
- **Bot** `src/bot.js:1` — commandes Stoat (`!sb list / add / play / delete`)
- **App web** `src/server.js:1` + `public/index.html:1` — upload, liste, preview, envoi dans Stoat

## Fonctionnement derrière WireGuard
- Le **bot** n'a besoin que d'une connexion **sortante** vers `stoat.chat` (WebSocket) → aucun port à ouvrir.
- L'**app web** écoute sur `0.0.0.0:${WEB_PORT}` et est exposée seulement sur ton LAN/WG (`http://192.168.1.83:3000` via VPN). Pas d'exposition internet nécessaire.
- `docker-compose.yml:14` bind en `127.0.0.1:${WEB_PORT}` par défaut — si ton WG est sur une autre interface, passe à `${WEB_PORT}:${WEB_PORT}`.

## Démarrage rapide

1. Crée un bot Stoat → copie le token, invite-le avec `Send Message` + `Upload Files` (+ `Manage Messages` si tu veux).
2. Récupère un **Channel ID** où le bot postera les sons : Stoat → Settings → Appearance → Enable Developer Mode → clic droit channel → Copy ID.

```bash
cd stoat-soundboard-bot
cp .env.example .env
# édite .env:
# BOT_TOKEN=...
# WEB_PORT=3000
# WEB_PASSWORD=unMotDePasseSiTuVeuxProtégerLUIMêmeDerrièreWG
# DEFAULT_CHANNEL_ID=01H...  # optionnel, pré-remplit l'UI
# PREFIX=!sb

npm install
npm start
# UI: http://localhost:3000  (sur NAS: http://192.168.1.83:3000 via WireGuard)
# Test: POST http://localhost:3000/api/health
```

## Déploiement NAS (TrueNAS Scale)

```bash
scp -r . root@192.168.1.83:/mnt/tank/apps/stoat-soundboard-bot
ssh root@192.168.1.83
cd /mnt/tank/apps/stoat-soundboard-bot
nano .env
docker compose up -d --build
docker logs -f stoat-soundboard
# Ouvre http://192.168.1.83:3000 depuis un client connecté au WG
```

Via TrueNAS Apps → Custom App → coller `docker-compose.yml`.

## Utilisation

### App web (recommandé)
- Ouvre l'UI → renseigne **Channel ID** + **WEB_PASSWORD** (si défini) → Save.
- **Upload** : nom `a-z0-9_-` (ex: `bruh`) + glisser fichier audio → Uploader. Preview immédiate via `<audio>`.
- **Jouer** : `▶ Envoyer dans Stoat` → le bot poste `🔊 bruh` + fichier joint dans le channel Stoat. Toute personne avec le Channel ID peut déclencher.
- **Gérer** : Suppr / Renommer. Les fichiers sont dans `./sounds/` + registre `sounds/sounds.json` (persisté via volume Docker).

### Commandes Stoat (alternative)
- `!sb list` — liste
- `!sb add <nom>` + fichier joint — ajoute
- `!sb play <nom>` ou `!sb <nom>` — joue (poste le fichier)
- `!sb delete <nom>` / `!sb rename <old> <new>`
- `!sb help`

Partage le stockage : un son uploadé via l'UI est jouable via `!sb play` et inversement (`src/sounds.js:1`).

## API

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| GET | `/api/health` | non | status bot + count |
| GET | `/api/sounds` | `X-Token` si `WEB_PASSWORD` | liste |
| POST | `/api/sounds` | `X-Token` | `form: name, file` multipart |
| DELETE | `/api/sounds/:name` | `X-Token` | supprime |
| POST | `/api/sounds/:name/rename` | `X-Token` | `{newName}` |
| POST | `/api/play/:name` | `X-Token` | `{channelId}` — bot envoie dans Stoat |
| GET | `/sounds/:filename` | non | preview audio |

Auth: header `X-Token: WEB_PASSWORD` ou `?token=` ou `Authorization: Bearer`.

## Env

- `BOT_TOKEN` requis
- `PREFIX` défaut `!sb`
- `WEB_PORT` défaut `3000`
- `WEB_PASSWORD` défaut vide (ouvert sur WG — mets un mdp si le WG est partagé)
- `DEFAULT_CHANNEL_ID` défaut vide
- `MAX_FILE_SIZE_MB` défaut `8`

## Structure
```
src/index.js:1   # lance bot + web
src/bot.js:1     # Client stoat.js, handlePlay(), playInChannel()
src/sounds.js:1  # registry partagé (getSounds, addSound...)
src/server.js:1  # Express + multer, API + static
public/index.html:1 # UI
sounds/          # stockage + sounds.json
```

## WireGuard — notes
- Assure-toi que le NAS peut résoudre `stoat.chat` via le WG (DNS sortant autorisé).
- Si tu veux accéder à l'UI depuis l'extérieur sans WG, mets un reverse proxy (Tailscale Funnel / Cloudflare Tunnel) mais garde `WEB_PASSWORD`.
- Le bind `127.0.0.1` dans compose limite à localhost du NAS → si tu accèdes via `192.168.1.83` depuis le WG, retire le préfixe `127.0.0.1:`.

## Troubleshooting
- `Missing BOT_TOKEN` — `.env` non chargé (`docker compose config` pour vérifier)
- `channel_not_found` — mauvais Channel ID ou bot pas dans le serveur
- `bot_not_ready` — attends `ready` dans les logs, token invalide ?
- Upload rejeté — vérifie extension/MIME audio et `MAX_FILE_SIZE_MB`
