# Getting started

Steerloop's current alpha is designed to prove the complete local control loop
before adding internet-facing deployment. Start with the demo adapter, then opt
into the real Codex adapter.

## Local demo

Requirements:

- Node.js 18.18 or newer (Node.js 20 is used in CI);
- npm 9 or newer.

From the repository root:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The demo session requests permission to run the
repository checks after a short delay. Its command, working directory, reason,
expiration, and verified request digest are visible before a decision is sent.

The development stack uses `steerloop-local-dev`. That token is intentionally
unsafe outside localhost.

The Agent also prints a short pairing code such as `ABCD-1234`. In the web
console, open **Connection**, enter the code, and choose **Pair device**. Relay
exchanges the code for a browser-local client token, so the shared Relay token
does not need to be copied into every browser. The browser also creates a local
P-256 device key; paired approval decisions are signed with that key and bound
to the paired device ID.

## Connect local Codex

Install and authenticate the Codex CLI first, then start the stack with:

```bash
STEERLOOP_ADAPTER=codex npm run dev
```

The Agent launches Codex App Server over local stdio, lists recent threads, and
normalizes lifecycle, activity, diff, and approval events. App Server is never
bound to a network interface by Steerloop.

## Test from a phone on a trusted LAN

This mode is for temporary development on a private network, not the public
internet. Generate a token, bind the Relay and Vite to the LAN, and allow the
Vite port only from that network:

```bash
export STEERLOOP_TOKEN="$(openssl rand -hex 32)"
export STEERLOOP_RELAY_HOST=0.0.0.0
export STEERLOOP_WEB_HOST=0.0.0.0
npm run dev
```

Open `http://<computer-lan-address>:5173` on the phone. Choose **Connect**, keep
the automatically derived `ws://<computer-lan-address>:5173/ws` URL, and enter
the pairing code printed by the host Agent. Vite proxies `/ws` and `/pair` to the
local Relay during development, so the browser does not need direct access to
port 8787. After pairing, use **Refresh** in the Devices section to list paired
browsers, and **Revoke** to invalidate a browser token and its approval-signing
public key.

Plain HTTP and WebSocket traffic is not safe on an untrusted network. Some
mobile browsers also restrict installable PWA and Web Crypto capabilities on
non-secure origins; Steerloop blocks approval when the browser cannot verify the
host-bound digest. A remote deployment therefore requires HTTPS/WSS at a trusted
reverse proxy.

## Configuration

The main settings are documented in [`.env.example`](../.env.example). Node does
not automatically load that file: export values in the shell or use the service
manager that will run Steerloop.

For production-mode Relay and Agent processes, set exactly one of
`STEERLOOP_TOKEN` or `STEERLOOP_TOKEN_FILE`. Use a unique high-entropy value and
do not commit it. Relay stores browser device records in
`STEERLOOP_DEVICE_REGISTRY_PATH`, defaulting to
`steerloop-data/relay-devices.json`; set it to `off` only for disposable tests.
The PWA keeps its configured Relay URL and paired browser token in that
browser's local storage during the alpha.
Clearing browser storage removes the paired token and private device key, so
that browser must be paired again before it can approve requests as the same
device.

For remote HTTPS/WSS deployment, persistent event storage, and secret-file token
configuration, continue with the [deployment guide](../deploy/README.md).

## Validate a change

```bash
npm run check
```

This runs protocol, Relay, Agent, browser-security, and full approval-round-trip
tests, then creates production builds for every workspace.
