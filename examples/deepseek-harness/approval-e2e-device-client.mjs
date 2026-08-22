#!/usr/bin/env node
import { randomUUID, webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  canonicalizeApproval,
  canonicalizeApprovalDecision,
  createEmptyState,
  reduceEvent,
} from '@steerloop/protocol';

const encoder = new TextEncoder();
const relayUrl = process.env.STEERLOOP_RELAY_URL ?? 'ws://127.0.0.1:18889/ws';
const pairingCode = process.env.STEERLOOP_PAIRING_CODE;
const decision = process.env.STEERLOOP_APPROVAL_DECISION ?? 'approve_once';
const timeoutMs = Number(process.env.STEERLOOP_APPROVAL_TIMEOUT_MS ?? '180000');

if (pairingCode === undefined || pairingCode.trim() === '') {
  throw new Error('STEERLOOP_PAIRING_CODE is required');
}
if (!['approve_once', 'decline', 'cancel'].includes(decision)) {
  throw new Error(`unsupported decision: ${decision}`);
}

function httpUrl(pathname) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPairingOffer() {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const response = await fetch(httpUrl('/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairingCode,
        deviceName: `Steerloop approval e2e ${decision}`,
        devicePublicKey: publicJwk,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.ok === true && typeof body.token === 'string' && body.device?.id !== undefined) {
      return { privateKey: pair.privateKey, token: body.token, deviceId: body.device.id, hostId: body.hostId };
    }
    lastError = body.error ?? `${response.status} ${response.statusText}`;
    await sleep(250);
  }
  throw new Error(`pairing failed before timeout: ${lastError}`);
}

async function sha256Hex(value) {
  const digest = await webcrypto.subtle.digest('SHA-256', encoder.encode(value));
  return Buffer.from(digest).toString('hex');
}

async function verifyApprovalDigest(approval) {
  const material = canonicalizeApproval({
    approvalId: approval.id,
    kind: approval.kind,
    ...(approval.command === undefined ? {} : { command: approval.command }),
    ...(approval.cwd === undefined ? {} : { cwd: approval.cwd }),
    ...(approval.grantRoot === undefined ? {} : { grantRoot: approval.grantRoot }),
    ...(approval.networkHost === undefined ? {} : { networkHost: approval.networkHost }),
    ...(approval.networkProtocol === undefined ? {} : { networkProtocol: approval.networkProtocol }),
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    ...(approval.requestedPermissions === undefined ? {} : { requestedPermissions: approval.requestedPermissions }),
  });
  const actual = await sha256Hex(material);
  if (actual !== approval.requestDigest) {
    throw new Error(`approval digest mismatch: expected ${approval.requestDigest}, got ${actual}`);
  }
}

async function signCommand(command, privateKey, deviceId) {
  const signedAt = new Date().toISOString();
  const material = canonicalizeApprovalDecision({
    commandId: command.commandId,
    hostId: command.hostId,
    sessionId: command.sessionId,
    approvalId: command.command.payload.approvalId,
    requestDigest: command.command.payload.requestDigest,
    decision: command.command.payload.decision,
    deviceId,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    signedAt,
  });
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(material),
  );
  return {
    ...command,
    command: {
      ...command.command,
      payload: {
        ...command.command.payload,
        authorization: {
          deviceId,
          algorithm: 'ECDSA-P256-SHA256',
          signedAt,
          signature: bytesToBase64Url(signature),
        },
      },
    },
  };
}

async function main() {
  const paired = await waitForPairingOffer();
  console.log(`[approval-e2e] paired device ${paired.deviceId} for host ${paired.hostId}`);

  const socket = new WebSocket(relayUrl, { maxPayload: 512 * 1024 });
  let state = createEmptyState();
  let resolvedCommandId;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('approval client timed out')), timeoutMs);
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        kind: 'auth',
        protocolVersion: PROTOCOL_VERSION,
        role: 'client',
        token: paired.token,
      }));
    });
    socket.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'auth.result') {
        if (frame.ok !== true) reject(new Error(frame.error ?? 'client auth failed'));
        return;
      }
      if (frame.kind === 'snapshot') {
        for (const event of frame.events) state = reduceEvent(state, event);
        return;
      }
      if (frame.kind === 'event') {
        state = reduceEvent(state, frame);
        const pending = Object.values(state.approvals).find(approval => approval.status === 'pending');
        if (pending === undefined) return;
        await verifyApprovalDigest(pending);
        const now = Date.now();
        let command = {
          kind: 'command',
          protocolVersion: PROTOCOL_VERSION,
          commandId: randomUUID(),
          hostId: pending.hostId,
          sessionId: pending.sessionId,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30000).toISOString(),
          command: {
            type: 'approval.resolve',
            payload: {
              approvalId: pending.id,
              requestDigest: pending.requestDigest,
              decision,
            },
          },
        };
        command = await signCommand(command, paired.privateKey, paired.deviceId);
        resolvedCommandId = command.commandId;
        console.log(`[approval-e2e] ${decision} ${pending.id} ${pending.title}`);
        socket.send(JSON.stringify(command));
        return;
      }
      if (frame.kind === 'command.result' && frame.commandId === resolvedCommandId) {
        clearTimeout(timer);
        if (frame.ok !== true) reject(new Error(frame.error ?? 'approval command failed'));
        else resolve();
      }
    });
  });
  socket.close(1000, 'approval e2e complete');
}

await main();
