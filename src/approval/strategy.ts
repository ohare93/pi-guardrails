import type { ApprovalStrategy, ApprovalStrategyInput } from "./types";

const FIRST_TERMINAL: ApprovalStrategy = {
  approvalsRequired: 1,
  denyPolicy: "first-deny-veto",
  cancelLosers: true,
  brokerTimeoutMs: "none",
  operatorAbort: true,
};

const PRESET_DEFAULTS: Record<
  NonNullable<ApprovalStrategyInput["preset"]>,
  ApprovalStrategy
> = {
  "first-terminal": FIRST_TERMINAL,
  all: {
    approvalsRequired: "all",
    denyPolicy: "first-deny-veto",
    cancelLosers: true,
    brokerTimeoutMs: "none",
    operatorAbort: true,
  },
  threshold: {
    approvalsRequired: 1,
    denyPolicy: "first-deny-veto",
    cancelLosers: true,
    brokerTimeoutMs: "none",
    operatorAbort: true,
  },
  "any-approve": {
    approvalsRequired: 1,
    denyPolicy: "all-deny",
    cancelLosers: true,
    brokerTimeoutMs: "none",
    operatorAbort: true,
  },
  "veto-threshold": {
    approvalsRequired: 1,
    denyPolicy: "first-deny-veto",
    cancelLosers: true,
    brokerTimeoutMs: "none",
    operatorAbort: true,
  },
};

export function resolveApprovalStrategy(
  input?: ApprovalStrategyInput,
  fallback?: ApprovalStrategyInput,
): ApprovalStrategy {
  const inputPreset = input?.preset;
  const preset = inputPreset ?? fallback?.preset ?? "first-terminal";
  const base = PRESET_DEFAULTS[preset];

  const fallbackValue = <K extends keyof ApprovalStrategy>(key: K) => {
    if (inputPreset && (key === "approvalsRequired" || key === "denyPolicy")) {
      return undefined;
    }
    return fallback?.[key];
  };

  return {
    ...base,
    approvalsRequired:
      input?.approvalsRequired ??
      fallbackValue("approvalsRequired") ??
      base.approvalsRequired,
    denyPolicy:
      input?.denyPolicy ?? fallbackValue("denyPolicy") ?? base.denyPolicy,
    cancelLosers:
      input?.cancelLosers ?? fallbackValue("cancelLosers") ?? base.cancelLosers,
    brokerTimeoutMs:
      input?.brokerTimeoutMs ??
      fallbackValue("brokerTimeoutMs") ??
      base.brokerTimeoutMs,
    operatorAbort:
      input?.operatorAbort ??
      fallbackValue("operatorAbort") ??
      base.operatorAbort,
    requiredSources:
      input?.requiredSources ??
      fallbackValue("requiredSources") ??
      base.requiredSources,
    acknowledgeUnsafeIgnoreDenies:
      input?.acknowledgeUnsafeIgnoreDenies ??
      fallbackValue("acknowledgeUnsafeIgnoreDenies") ??
      base.acknowledgeUnsafeIgnoreDenies,
  };
}

export function requiredApprovalCount(
  strategy: ApprovalStrategy,
  configuredSourceCount: number,
): number {
  if (strategy.approvalsRequired === "all")
    return Math.max(1, configuredSourceCount);
  if (!Number.isFinite(strategy.approvalsRequired)) return 1;
  return Math.max(1, Math.floor(strategy.approvalsRequired));
}

export function validateApprovalStrategy(strategy: ApprovalStrategy): string[] {
  const warnings: string[] = [];
  if (
    strategy.approvalsRequired !== "all" &&
    (!Number.isFinite(strategy.approvalsRequired) ||
      strategy.approvalsRequired < 1)
  ) {
    warnings.push(
      "approvalBroker strategy approvalsRequired must be a positive number; using 1",
    );
  }
  if (strategy.denyPolicy === "ignore-denies") {
    warnings.push(
      "approvalBroker strategy uses ignore-denies; this is unsafe for security gates",
    );
  }
  if (strategy.brokerTimeoutMs === "none" && !strategy.operatorAbort) {
    warnings.push(
      "approvalBroker strategy with no timeout should enable operatorAbort",
    );
  }
  return warnings;
}
