# Where and When

A quiz built on EUMETSAT's [Climate Anomalies and Normals (CAN) service](https://can.eumetsat.int). Players guess the place and year of 20 climate events from 2007 to 2025, such as droughts, floods, sunshine records and sea ice extremes. The top ten scores are stored in SQLite.

- **Noob**: an anomaly map of the event, with the region outlined. Three options for the place and three for the year.
- **Expert**: the same options, but only a 12-month chart of actual values against the 1991–2020 normal.

Each round gives 500 points for the right place and 500 for the right year. A wrong answer scores nothing. After each answer, an info box explains the event and links to Wikipedia and one authoritative source.

## Run it

```bash
docker compose up -d --build
# open http://localhost:8080
```

To run it without Compose:

```bash
docker build -t where-and-when .
docker run -d --name where-and-when -p 8080:8080 -v ww-scores:/data where-and-when
```

Scores live in `/data/scores.db` inside the container, on the named volume `scores` (or `ww-scores` above). They survive restarts and rebuilds. To back up:

```bash
docker compose cp quiz:/data/scores.db ./scores-backup.db
```

To run it without Docker you need Node 22.13 or newer. There are no npm packages:

```bash
DB_PATH=./data/scores.db PORT=8080 node --disable-warning=ExperimentalWarning server.mjs
```

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/scores.db` | SQLite file |
| `ADMIN_TOKEN` | empty | When set, allows `DELETE /api/scores/<id>` with `Authorization: Bearer <token>` |
| `TRUST_PROXY` | empty | Set to `1` behind a reverse proxy, so the rate limit uses `X-Forwarded-For` |
| `RATE_LIMIT` | `60` | New scores allowed per IP address per 10 minutes. Raise it for big events on shared Wi-Fi |

The app serves plain HTTP. For a public address, put it behind your usual reverse proxy (Caddy, Traefik, nginx) for HTTPS. It works under a sub-path too, because the page calls `api/scores` with a relative URL.

## API

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/scores?mode=noob&limit=10` | `mode` = `noob` or `expert`, `limit` up to 50 | `{ mode, scores: [{ id, name, score, mode, created_at }] }` |
| `POST /api/scores` | `{ "name": "Niklas", "score": 5000, "mode": "noob" }` | `201 { id, rank }` |
| `DELETE /api/scores/<id>` | header `Authorization: Bearer <ADMIN_TOKEN>` | `{ deleted: 1 }` |
| `GET /healthz` | | `{ ok: true }` |

Validation rules:
- Names are trimmed, stripped of control and invisible characters, and capped at 24 characters.
- The page always shows names as plain text.
- A score must be a multiple of 500 between 0 and 8000. Anything else isn't possible in the quiz.

Scores aren't verified beyond that, so a determined player could post a made-up score with curl. For an informal competition, use the admin delete to remove anything odd:

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/api/scores/42
```

## Files

```
server.mjs          HTTP server, static files and the scores API (Node 22, built-in node:sqlite)
public/index.html   page and styles
public/app.js       quiz logic, map and chart rendering, leaderboard
public/data.js      the 20 events: CAN region series, normals and anomaly grids, plus borders
Dockerfile, docker-compose.yml
```

## Data

The quiz data comes from the CAN service:
- region means through `GetTimeSeries`
- normals from the `Normals/…` layers
- anomaly maps decoded from `GetMap` PNGs using the `GetLegendGraphic` colour legend

Country borders are Natural Earth 50m, from world-atlas. The data is a snapshot taken in October 2026.

EUMETSAT CAN service, with climate data records from the CM SAF (SARAH-3), H SAF and OSI SAF.
