# Remote deployment

This deployment exposes only the Steerloop PWA and Relay through Caddy. Codex
App Server remains on the developer machine and communicates with the local
Steerloop Agent over stdio.

## Prerequisites

- a Linux server with Docker Engine and Docker Compose v2;
- a DNS name pointing to the server;
- inbound TCP 80 and TCP/UDP 443 allowed by the firewall;
- no public access to Relay port 8787.

Caddy obtains and renews the TLS certificate automatically. The browser uses the
same origin for the PWA and `wss://<domain>/ws`, avoiding a second exposed port.

## Configure

From the repository root:

```bash
mkdir -p deploy/secrets
umask 077
openssl rand -hex -out deploy/secrets/relay-token 32
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and set `STEERLOOP_DOMAIN` to the DNS name. The token file and
`.env` are ignored by Git. Keep a secure copy of the token for the host Agent and
the phone; do not send it through the deployed Steerloop site.

Validate and start the stack:

```bash
docker compose --env-file deploy/.env -f deploy/compose.remote.yml config
docker compose --env-file deploy/.env -f deploy/compose.remote.yml build
docker compose --env-file deploy/.env -f deploy/compose.remote.yml up -d
docker compose --env-file deploy/.env -f deploy/compose.remote.yml ps
```

Check the TLS edge and Relay health:

```bash
curl --fail --show-error https://<domain>/healthz
```

The expected response includes `"ok":true` and reports the connected Agent and
client counts.

## Connect a host Agent

Copy the Relay token to a root- or user-readable file on the computer that runs
Codex. Then build and start only the Agent:

```bash
npm ci
npm run build --workspace=@steerloop/agent
NODE_ENV=production \
STEERLOOP_ADAPTER=codex \
STEERLOOP_TOKEN_FILE=/absolute/path/to/relay-token \
STEERLOOP_RELAY_URL=wss://<domain>/ws \
npm run start --workspace=@steerloop/agent
```

Open `https://<domain>` on the phone, choose **Connect**, and enter the same
token. The default Relay URL is the same-origin `wss://<domain>/ws` endpoint.

## Persistence and backups

Relay events are stored in the `relay-data` volume as
`/data/relay-events.jsonl`. Each accepted event is synced before broadcast, and
the journal is atomically compacted to the configured history window.

The journal contains session titles, activity summaries, commands, paths, and
approval metadata. Protect Docker data at rest and include the `relay-data`
volume in encrypted backups. Removing that volume permanently removes the Relay
history; it does not delete Codex's local thread history on host machines.

## Update and rollback

Pull a reviewed commit, rebuild, and recreate the services:

```bash
git pull --ff-only
docker compose --env-file deploy/.env -f deploy/compose.remote.yml build
docker compose --env-file deploy/.env -f deploy/compose.remote.yml up -d
```

Keep the previous Git commit and container images until the health check and one
real Agent connection succeed. Roll back by checking out the previous reviewed
commit and rebuilding; the journal format is append-only protocol JSON and is
validated during startup.

## Security notes

- Use a dedicated high-entropy token with at least 32 characters.
- Expose only ports 80 and 443; port 8787 is an internal Compose port.
- Never expose Codex App Server. Its direct WebSocket transport is not used.
- The PWA is publicly downloadable, but events and commands require the Relay
  token during the WebSocket handshake.
- The current alpha does not provide per-device identities, token rotation, or
  end-to-end encrypted Relay storage. These remain required before team use.
