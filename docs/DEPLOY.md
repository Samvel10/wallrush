# Deploying WallRush

The whole game is **one Node process and one file**. No database server, no
container runtime, no build toolchain on the target machine. It runs on the
cheapest VPS you can rent, and on a Raspberry Pi.

## Requirements

- Node **22 or newer** (for `node:sqlite`). Node 24 recommended.
- ~80 MB of RAM at idle; a few hundred MB under real load.
- A writable directory for the database.

## 1. Build

Build on your machine (or in CI) and ship `dist/` directories:

```bash
git clone https://github.com/Samvel10/wallrush.git
cd wallrush
npm ci
npm run build
```

That produces:

```
packages/shared/dist    engine (compiled)
packages/server/dist    server (compiled)
packages/client/dist    the static app
```

## 2. Run

```bash
WALLRUSH_DATA=/var/lib/wallrush \
WALLRUSH_STATIC=/opt/wallrush/packages/client/dist \
PORT=8787 \
node packages/server/dist/index.js
```

Everything is served from that one port: the app, the API and the WebSocket.

### Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `WALLRUSH_DATA` | `./data` | SQLite file **and** the signing key live here — back this up |
| `WALLRUSH_STATIC` | `packages/client/dist` | set to `''` to serve the API only |
| `WALLRUSH_SECRET` | generated | 32+ bytes; generated and persisted on first boot |
| `WALLRUSH_ORIGINS` | `*` | set to your domain in production |
| `WALLRUSH_RECONNECT_GRACE` | `45000` | ms a disconnected player keeps their seat |
| `WALLRUSH_ROOM_LINGER` | `180000` | ms a finished room stays around for a rematch |
| `WALLRUSH_EMPTY_GRACE` | `90000` | ms an empty room is kept, so a host who refreshes keeps their code |
| `WALLRUSH_RATE_LIMIT` | `25` | realtime messages per second per connection |
| `WALLRUSH_MAX_ROOMS` | `4000` | |
| `WALLRUSH_DEBUG` | `0` | `1` logs every realtime message — development only |

## 3. systemd

`/etc/systemd/system/wallrush.service`:

```ini
[Unit]
Description=WallRush
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wallrush
Group=wallrush
WorkingDirectory=/opt/wallrush
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=always
RestartSec=2

Environment=NODE_ENV=production
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=WALLRUSH_DATA=/var/lib/wallrush
Environment=WALLRUSH_STATIC=/opt/wallrush/packages/client/dist
Environment=WALLRUSH_ORIGINS=https://your-domain.example

# The process needs nothing beyond its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/wallrush
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/wallrush --shell /usr/sbin/nologin wallrush
sudo mkdir -p /var/lib/wallrush && sudo chown wallrush:wallrush /var/lib/wallrush
sudo systemctl enable --now wallrush
sudo journalctl -u wallrush -f
```

## 4. nginx

The only non-obvious part is the WebSocket upgrade and a read timeout long
enough that an idle table is not cut off mid-game.

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # Realtime: upgrade the connection and keep it open.
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name your-domain.example;
    return 301 https://$host$request_uri;
}
```

Certificates: `sudo certbot --nginx -d your-domain.example`.

## 5. Backups

Two files matter, both in `WALLRUSH_DATA`:

- `wallrush.sqlite` — accounts, ratings, match history
- `secret.key` — the token signing key; lose it and everyone is logged out

SQLite runs in WAL mode, so copy it with the SQLite backup API rather than `cp`:

```bash
sqlite3 /var/lib/wallrush/wallrush.sqlite ".backup '/backups/wallrush-$(date +%F).sqlite'"
cp /var/lib/wallrush/secret.key /backups/
```

## 6. Updating

```bash
cd /opt/wallrush
git pull
npm ci
npm run build
sudo systemctl restart wallrush
```

The service worker is stamped with a hash of the built assets, so returning
visitors pick up the new version on their next load rather than sitting on a
cached bundle. In-progress games survive the restart only if players reconnect
within `WALLRUSH_RECONNECT_GRACE`; for a graceful window, restart when
`/api/health` reports `playing: 0`.

## 7. Health

```bash
curl -s https://your-domain.example/api/health
```

```json
{ "ok": true, "uptime": 1234, "rooms": 3, "playing": 2, "queue": 0,
  "online": 7, "users": 42, "matches": 118 }
```

Good things to alert on: the endpoint not answering, `uptime` resetting
unexpectedly (crash loop), or `rooms` growing without bound.

## Scaling notes

One process holds all room state in memory, so it does not scale horizontally
as-is. It does not need to for a long time: a table costs a few kilobytes, and
a move is one BFS over 81 cells. If you ever outgrow a single box, the natural
split is to shard rooms by code across processes behind a sticky-by-room proxy,
leaving accounts and history in the shared database.


## Փորձարկում հեռախոսից՝ նույն Wi-Fi-ի ներսում

`deploy/wallrush-lan.service`-ը նույն բանն է, ինչ արտադրական unit-ը, երկու
տարբերությամբ. կապվում է **բոլոր ինտերֆեյսներին** (`HOST=0.0.0.0`), ոչ միայն
loopback-ին, և աշխատում է հենց այս checkout-ից՝ մշակողի հաշվի տակ։ Դա տան
վստահելի ցանցի համար է, ոչ թե ինտերնետի։

```bash
sudo cp deploy/wallrush-lan.service /etc/systemd/system/wallrush.service
sudo systemctl daemon-reload && sudo systemctl enable --now wallrush
ip -4 addr show scope global | grep -oP 'inet \K[\d.]+'   # հասցեն
```

Հեռախոսում՝ `http://<հասցե>:8787`։

Երկու բան, որ պետք է իմանալ.

- **Node-ի ուղին unit-ում բացահայտ գրված է։** Համակարգային `node`-ը 18 է, իսկ
  `node:sqlite`-ին պետք է 22+, ուստի PATH-ի վրա հույս դնելը լուռ կոտրում է
  գործարկումը։
- **Service worker-ը չի գրանցվի `http://`-ի վրա** (միայն `localhost` կամ
  `https`)։ Խաղը լիարժեք աշխատում է, բայց հեռախոսի վրա այս հասցեով չեն լինի
  օֆլայն ռեժիմը և «ավելացնել գլխավոր էկրանին»։ Դրանք ստուգելու համար պետք է
  `https` կամ `localhost`։
