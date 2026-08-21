import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyState,
  type ApprovalDecision,
  type ApprovalView,
  type CommandEnvelope,
  type ControlPlaneState,
  type SessionStatus,
  type SessionView,
} from "@steerloop/protocol";
import {
  buildCommand,
  ControlClient,
  defaultRelayUrl,
  type ConnectionUpdate,
} from "./connection.js";
import {
  verifyApprovalIntegrity,
  type ApprovalIntegrity,
} from "./approval-integrity.js";

const DEVELOPMENT_TOKEN = "steerloop-local-dev";

const statusCopy: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting_approval: "Needs approval",
  waiting_input: "Needs input",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  offline: "Offline",
};

const connectionCopy = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
  error: "Connection issue",
} as const;

interface Settings {
  url: string;
  token: string;
}

function loadSettings(): Settings {
  return {
    url: localStorage.getItem("steerloop.relayUrl") ?? defaultRelayUrl(window.location),
    token: localStorage.getItem("steerloop.token") ?? DEVELOPMENT_TOKEN,
  };
}

function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function shortPath(path: string | undefined): string {
  if (path === undefined) return "No working directory";
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {statusCopy[status]}
    </span>
  );
}

function EmptyState() {
  return (
    <section className="empty-state panel">
      <div className="empty-orbit" aria-hidden="true">
        <span />
      </div>
      <p className="eyebrow">Awaiting a host</p>
      <h2>Your loops will appear here.</h2>
      <p>
        Start the relay and a Steerloop Agent. This console will restore the latest
        session snapshot as soon as the connection is authenticated.
      </p>
      <code>npm run dev</code>
    </section>
  );
}

interface ApprovalCardProps {
  approval: ApprovalView;
  integrity: ApprovalIntegrity;
  now: number;
  onResolve(approval: ApprovalView, decision: ApprovalDecision): void;
}

function ApprovalCard({ approval, integrity, now, onResolve }: ApprovalCardProps) {
  const expired = Date.parse(approval.expiresAt) <= now;
  const blocked = expired || integrity !== "valid";
  return (
    <article className="approval-card">
      <div className="approval-heading">
        <div className="approval-icon" aria-hidden="true">!</div>
        <div>
          <p className="eyebrow">{approval.kind.replace("_", " ")} request</p>
          <h3>{approval.title}</h3>
        </div>
        <span className={expired ? "expiry expired" : "expiry"}>
          {expired ? "Expired" : `Expires ${relativeTime(approval.expiresAt, now)}`}
        </span>
      </div>

      {approval.reason !== undefined && <p className="approval-reason">{approval.reason}</p>}
      <dl className="approval-details">
        {approval.command !== undefined && (
          <div>
            <dt>Command</dt>
            <dd><code>{approval.command}</code></dd>
          </div>
        )}
        {approval.cwd !== undefined && (
          <div><dt>Directory</dt><dd>{approval.cwd}</dd></div>
        )}
        {approval.grantRoot !== undefined && (
          <div><dt>Write scope</dt><dd>{approval.grantRoot}</dd></div>
        )}
        {approval.networkHost !== undefined && (
          <div><dt>Destination</dt><dd>{approval.networkProtocol ?? "network"}://{approval.networkHost}</dd></div>
        )}
        {approval.requestedPermissions !== undefined && (
          <div>
            <dt>Permissions</dt>
            <dd>
              <ul className="permission-list">
                {approval.requestedPermissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <p className={`digest integrity-${integrity}`} title={approval.requestDigest}>
        {integrity === "valid"
          ? "Verified bound request"
          : integrity === "checking"
            ? "Verifying bound request…"
            : integrity === "invalid"
              ? "Warning: request contents do not match the host digest"
              : "Secure digest verification is unavailable"}
        {integrity === "valid" && ` · ${approval.requestDigest.slice(0, 12)}`}
      </p>
      <div className="approval-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={blocked}
          onClick={() => onResolve(approval, "approve_once")}
        >
          Approve once
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={blocked}
          onClick={() => onResolve(approval, "decline")}
        >
          Decline
        </button>
      </div>
    </article>
  );
}

interface SessionListProps {
  sessions: SessionView[];
  selectedId: string | undefined;
  now: number;
  onSelect(id: string): void;
}

function SessionList({ sessions, selectedId, now, onSelect }: SessionListProps) {
  return (
    <nav className="session-list" aria-label="Agent sessions">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Active workspace</p>
          <h2>Sessions</h2>
        </div>
        <span className="count-badge">{sessions.length}</span>
      </div>
      <div className="session-items">
        {sessions.map((session) => (
          <button
            type="button"
            className={`session-item${selectedId === session.id ? " selected" : ""}`}
            key={session.id}
            onClick={() => onSelect(session.id)}
          >
            <span className={`session-glyph status-${session.status}`} aria-hidden="true" />
            <span className="session-copy">
              <strong>{session.title}</strong>
              <small>{shortPath(session.cwd)}</small>
            </span>
            <span className="session-meta">
              <small>{relativeTime(session.updatedAt, now)}</small>
              {session.status === "waiting_approval" && <span className="attention-dot" />}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

interface SessionDetailProps {
  session: SessionView;
  hostName: string;
  approvals: ApprovalView[];
  approvalIntegrity: Record<string, ApprovalIntegrity>;
  now: number;
  onResolve(approval: ApprovalView, decision: ApprovalDecision): void;
  onInterrupt(): void;
  onPrompt(text: string, behavior: "queue" | "steer"): void;
}

function SessionDetail({
  session,
  hostName,
  approvals,
  approvalIntegrity,
  now,
  onResolve,
  onInterrupt,
  onPrompt,
}: SessionDetailProps) {
  const [prompt, setPrompt] = useState("");

  function submit(event: FormEvent, behavior: "queue" | "steer") {
    event.preventDefault();
    const text = prompt.trim();
    if (text.length === 0) return;
    onPrompt(text, behavior);
    setPrompt("");
  }

  return (
    <section className="session-detail">
      <header className="session-header panel">
        <div>
          <div className="session-kicker">
            <StatusPill status={session.status} />
            <span>{hostName}</span>
            <span>{session.source}</span>
          </div>
          <h1>{session.title}</h1>
          <p className="cwd">{session.cwd ?? "Working directory unavailable"}</p>
        </div>
        <button className="icon-button danger" type="button" onClick={onInterrupt} title="Interrupt session">
          <span aria-hidden="true">■</span>
          <span>Stop</span>
        </button>
      </header>

      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          integrity={approvalIntegrity[approval.id] ?? "checking"}
          now={now}
          onResolve={onResolve}
        />
      ))}

      <div className="detail-grid">
        <article className="activity-panel panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Event stream</p><h2>What’s happening</h2></div>
            <span className="live-label"><span /> live</span>
          </div>
          {session.activities.length === 0 && session.latestMessage.length === 0 ? (
            <p className="muted">No activity has been reported yet.</p>
          ) : (
            <ol className="timeline">
              {[...session.activities].reverse().map((activity) => (
                <li key={activity.id}>
                  <span className={`timeline-mark activity-${activity.kind}`} />
                  <div>
                    <div className="timeline-line">
                      <strong>{activity.summary}</strong>
                      <time>{relativeTime(activity.emittedAt, now)}</time>
                    </div>
                    {activity.detail !== undefined && <pre>{activity.detail}</pre>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {session.latestMessage.length > 0 && (
            <div className="agent-message">
              <p className="eyebrow">Latest agent message</p>
              <p>{session.latestMessage}</p>
            </div>
          )}
        </article>

        <aside className="side-stack">
          <article className="diff-card panel">
            <p className="eyebrow">Working tree</p>
            <h2>{session.diff?.summary ?? "No diff reported"}</h2>
            {session.diff !== undefined && (
              <div className="diff-stats">
                <span>{session.diff.filesChanged ?? 0}<small>files</small></span>
                <span className="additions">+{session.diff.additions ?? 0}<small>added</small></span>
                <span className="deletions">−{session.diff.deletions ?? 0}<small>removed</small></span>
              </div>
            )}
          </article>
          <form className="prompt-card panel" onSubmit={(event) => submit(event, "queue")}>
            <p className="eyebrow">Guide the loop</p>
            <h2>Send context</h2>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={16_384}
              rows={4}
              placeholder="Add a constraint, answer a question, or redirect the task…"
              aria-label="Guidance for the agent"
            />
            <div className="prompt-actions">
              <button className="button button-secondary" type="submit">Queue next</button>
              <button
                className="button button-primary"
                type="button"
                onClick={(event) => submit(event as unknown as FormEvent, "steer")}
              >
                Steer now
              </button>
            </div>
          </form>
        </aside>
      </div>
    </section>
  );
}

export function App() {
  const [state, setState] = useState<ControlPlaneState>(createEmptyState);
  const [connection, setConnection] = useState<ConnectionUpdate>({ status: "disconnected" });
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [draftSettings, setDraftSettings] = useState<Settings>(settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [approvalIntegrity, setApprovalIntegrity] = useState<Record<string, ApprovalIntegrity>>({});
  const [now, setNow] = useState(Date.now());
  const clientRef = useRef<ControlClient>();

  if (clientRef.current === undefined) {
    clientRef.current = new ControlClient({
      onState: setState,
      onConnection: setConnection,
      onCommandResult: (result) => {
        setNotice(result.ok ? "Command accepted by the host" : result.error ?? "Command failed");
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current;
    client?.connect(settings);
    return () => client?.disconnect();
  }, [settings]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let active = true;
    const pending = Object.values(state.approvals).filter(
      (approval) => approval.status === "pending",
    );
    void Promise.all(
      pending.map(async (approval) => [approval.id, await verifyApprovalIntegrity(approval)] as const),
    ).then((entries) => {
      if (active) setApprovalIntegrity(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [state.approvals]);

  const sessions = useMemo(
    () => Object.values(state.sessions).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [state.sessions],
  );
  const selected = state.sessions[selectedId ?? ""] ?? sessions[0];
  const pendingApprovals = Object.values(state.approvals).filter(
    (approval) => approval.status === "pending",
  );
  const selectedApprovals = selected === undefined
    ? []
    : pendingApprovals.filter((approval) => approval.sessionId === selected.id);
  const onlineHosts = Object.values(state.hosts).filter((host) => host.online).length;
  const runningSessions = sessions.filter((session) => session.status === "running").length;

  function send(command: CommandEnvelope): void {
    try {
      clientRef.current?.send(command);
      setNotice("Command sent securely");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send command");
    }
  }

  async function resolveApproval(approval: ApprovalView, decision: ApprovalDecision): Promise<void> {
    const integrity = await verifyApprovalIntegrity(approval);
    if (integrity !== "valid") {
      setNotice("Approval blocked: the request could not be verified");
      return;
    }
    send(
      buildCommand(approval.hostId, approval.sessionId, {
        type: "approval.resolve",
        payload: {
          approvalId: approval.id,
          requestDigest: approval.requestDigest,
          decision,
        },
      }),
    );
  }

  function saveSettings(event: FormEvent): void {
    event.preventDefault();
    const next = { url: draftSettings.url.trim(), token: draftSettings.token };
    localStorage.setItem("steerloop.relayUrl", next.url);
    localStorage.setItem("steerloop.token", next.token);
    setSettings(next);
    setSettingsOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Steerloop home">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span><strong>steerloop</strong><small>agent control plane</small></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection connection-${connection.status}`}>
            <i />{connectionCopy[connection.status]}
          </span>
          <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)}>
            <span aria-hidden="true">⌘</span><span>Connect</span>
          </button>
        </div>
      </header>

      <main>
        <section className="overview">
          <div>
            <p className="eyebrow">Remote operations</p>
            <h1>Keep every loop <em>within reach.</em></h1>
          </div>
          <dl className="metrics">
            <div><dt>Hosts online</dt><dd>{onlineHosts.toString().padStart(2, "0")}</dd></div>
            <div><dt>Running</dt><dd>{runningSessions.toString().padStart(2, "0")}</dd></div>
            <div className={pendingApprovals.length > 0 ? "metric-alert" : ""}>
              <dt>Needs you</dt><dd>{pendingApprovals.length.toString().padStart(2, "0")}</dd>
            </div>
          </dl>
        </section>

        {sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="workspace">
            <SessionList sessions={sessions} selectedId={selected?.id} now={now} onSelect={setSelectedId} />
            {selected !== undefined && (
              <SessionDetail
                key={selected.id}
                session={selected}
                hostName={state.hosts[selected.hostId]?.name ?? selected.hostId}
                approvals={selectedApprovals}
                approvalIntegrity={approvalIntegrity}
                now={now}
                onResolve={resolveApproval}
                onInterrupt={() => {
                  if (window.confirm(`Interrupt “${selected.title}”?`)) {
                    send(buildCommand(selected.hostId, selected.id, { type: "session.interrupt", payload: {} }));
                  }
                }}
                onPrompt={(text, behavior) => {
                  send(buildCommand(selected.hostId, selected.id, {
                    type: "session.prompt",
                    payload: { text, behavior },
                  }));
                }}
              />
            )}
          </div>
        )}
      </main>

      {settingsOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button>
            <p className="eyebrow">Connection</p>
            <h2 id="settings-title">Relay settings</h2>
            <p>Credentials stay in this browser. Use TLS and a unique token outside local development.</p>
            <form onSubmit={saveSettings}>
              <label>WebSocket URL<input type="url" required value={draftSettings.url} onChange={(event) => setDraftSettings({ ...draftSettings, url: event.target.value })} /></label>
              <label>Access token<input type="password" required value={draftSettings.token} onChange={(event) => setDraftSettings({ ...draftSettings, token: event.target.value })} /></label>
              <button className="button button-primary" type="submit">Save & reconnect</button>
            </form>
            {connection.detail !== undefined && <p className="connection-detail">{connection.detail}</p>}
          </section>
        </div>
      )}

      {notice !== undefined && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
