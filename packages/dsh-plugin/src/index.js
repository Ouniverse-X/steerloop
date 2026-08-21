import { SteerloopDshBridge } from "./bridge.js";

export const name = "steerloop-dsh-plugin";

export function apply(ctx, config = {}) {
  const bridge = new SteerloopDshBridge(config);
  ctx.on("session/event", (session, event) => {
    bridge.handleSessionEvent(session, event);
  });
  ctx.on("approval/request", (req, next) => {
    if (config.approvals === false) return next();
    return bridge.requestApproval(req);
  }, { prepend: config.prependApprovalAnswerer !== false });
  ctx.effect(() => {
    bridge.start();
    return () => bridge.stop();
  }, "steerloop.dsh.bridge");
}

export { SteerloopDshBridge } from "./bridge.js";
export { HarnessEventMapper } from "./mapping.js";
