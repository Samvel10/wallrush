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


## Կենդանի տարբերակը՝ https://wallrush.duckdns.org

Hetzner-ի մեքենա (`root@5.223.92.226`), որի վրա ուրիշ նախագծեր էլ են աշխատում։
WallRush-ը այնտեղ **միայն գործարկվում է** — շինումը տեղում է, սերվերին գնում է
միայն արդյունքը (343 KB)։ Դա դիտավորյալ է. մեքենան 7.6 GiB հիշողություն ունի, և
tsc/vite-ը այնտեղ վազեցնելը ուրիշների հաշվին կլիներ։

**Ամենակարճ ձևը՝** `scripts/deploy.sh` (շինում, ուղարկում, վերագործարկում և
ստուգում է՝ ներառյալ WebSocket-ի upgrade-ը)։ Ձեռքով՝

```bash
# տեղում
npm run build
tar czf /tmp/wallrush.tgz   package.json package-lock.json   packages/shared/package.json packages/shared/dist   packages/server/package.json packages/server/dist   packages/client/package.json packages/client/dist

# սերվերում
scp /tmp/wallrush.tgz root@SERVER:/tmp/
ssh root@SERVER 'tar xzf /tmp/wallrush.tgz -C /opt/wallrush &&
  cd /opt/wallrush && PATH=/opt/node22/bin:$PATH npm install --omit=dev &&
  systemctl restart wallrush'
```

Հեռացրու `packages/server/dist/test`-ը փաթեթից — թեստերը արտադրության մեջ պետք չեն։

### Node-ի տարբերակը

Բաշխման `node`-ը **20.20.2** է, իսկ `node:sqlite`-ին պետք է **22+**։ nodesource
տեղադրելը կփոխարիներ այն node-ը, որով ուրիշ նախագծեր են աշխատում, ուստի 22.14-ը
դրված է առանձին՝ **`/opt/node22`**, և միայն `wallrush.service`-ն է այն անվանում.

```
ExecStart=/opt/node22/bin/node packages/server/dist/index.js
```

### Apache (այս մեքենան nginx չունի)

`mod_proxy_wstunnel`-ը արդեն միացված էր։ **Կարևորը հերթականությունն է** —
WebSocket-ի rewrite-ը պետք է լինի `ProxyPass /`-ից **առաջ**, այլապես upgrade-ը
գնում է որպես սովորական HTTP հարցում և խաղը երբեք չի միանում.

```apache
RewriteEngine on
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/ws(.*) ws://127.0.0.1:8787/ws$1 [P,L]

ProxyPass / http://127.0.0.1:8787/
ProxyPassReverse / http://127.0.0.1:8787/
```

HTTPS-ը՝ `certbot --apache -d wallrush.duckdns.org --redirect`։ TLS vhost-ում
ավելացված են `X-Forwarded-Proto`, `X-Forwarded-Port` և HSTS։

Ստուգելու ամենաարագ ձևը, որ իրական ժամանակը աշխատում է՝ upgrade-ի կոդը.

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://wallrush.duckdns.org/api/health   # 200
# WebSocket՝ 101 և առաջին կադրը (welcome հաղորդագրությունը)
```


### Տվյալների պահուստավորում

Հանրային կայքում մարդիկ հաշիվներ են բացում և խաղեր են խաղում, ուստի սերվերին
դրված է գիշերային պահուստավորում՝ `wallrush-backup.timer` (03:20 UTC, պատահական
մինչև 10 րոպե ուշացումով), պահում է **երկու շաբաթ**՝ `/var/backups/wallrush/`։

WAL-ի պատճառով սովորական `cp`-ն կարող է ֆայլը բռնել գրելու կեսին, ուստի պատճենը
խնդրվում է հենց SQLite-ից՝ `VACUUM INTO`։ **Երկու բան այստեղ խայթում է, և երկուսն
էլ դուրս են գալիս նույն անօգուտ «SQL logic error» սխալով.**

1. Կապը պետք է լինի **կարդալ-գրել**։ `readOnly: true`-ի դեպքում SQLite-ը
   մերժում է `VACUUM`-ը։
2. Նպատակի ուղին պետք է լինի **միակի չակերտների** մեջ։ `JSON.stringify`-ի
   կրկնակի չակերտները SQLite-ի համար նշանակում են *identifier*, ոչ թե տող։

Վերականգնում՝ `gunzip -c backup.gz > wallrush.sqlite`, դնել
`/var/lib/wallrush/`-ում (ծառայությունը կանգնեցրած), `chown wallrush:wallrush`,
գործարկել։ Ստուգված է. պահուստը բացվում է և պարունակում է բոլոր վեց աղյուսակները։
