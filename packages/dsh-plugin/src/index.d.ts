import type { SteerloopDshConfig } from "./bridge.js";

export const name: "steerloop-dsh-plugin";
export function apply(ctx: { on(event: string, listener: (...args: any[]) => unknown, options?: unknown): unknown; effect(setup: () => unknown, label?: string): unknown }, config?: SteerloopDshConfig): void;
export { SteerloopDshBridge } from "./bridge.js";
export { HarnessEventMapper } from "./mapping.js";
export type { SteerloopDshConfig, HarnessApprovalOutcome, HarnessApprovalRequest } from "./bridge.js";
