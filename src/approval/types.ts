import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ApprovalRisk = "low" | "medium" | "high";

export type ApprovalGrantScope =
  | "once"
  | "file-session"
  | "dir-session"
  | "file-always"
  | "dir-always";

export type ApprovalAction = {
  kind: "tool_call" | "path_access" | "custom";
  toolName: string;
  command?: string;
  path?: string;
  inputPreview?: string;
};

export type ApprovalRequest = {
  brokerRequestId: string;
  correlationToken: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  title: string;
  body: string;
  risk?: ApprovalRisk;
  action: ApprovalAction;
  metadata: Record<string, string>;
};

export type ApprovalRequestInput = Omit<
  ApprovalRequest,
  "brokerRequestId" | "correlationToken" | "metadata"
> & {
  metadata?: Record<string, string>;
};

export type ApprovalDecision = {
  brokerRequestId: string;
  correlationToken: string;
  sourceId: string;
  sourceRequestId?: string;
  decision: "approve" | "deny";
  message?: string;
  grantScope?: ApprovalGrantScope;
  sourceDecidedAt?: string;
  sessionId?: string;
  toolCallId?: string;
  actionFingerprint: string;
  metadata?: Record<string, string>;
};

export type ApprovalSourceStartError = {
  sourceId: string;
  kind: "unavailable" | "misconfigured" | "failed";
  message: string;
};

export type CancelResult =
  | { status: "cancelled" }
  | { status: "not-supported"; message: string }
  | { status: "already-terminal"; decision: ApprovalDecision };

export type ApprovalSourceContext = {
  signal: AbortSignal;
  cwd: string;
  hasUI: boolean;
  piContext: ExtensionContext;
  sourceOrder: number;
  sourceConfig: unknown;
  redact(value: unknown): string;
  emitStatus(message: string): void;
};

export type ApprovalHandle = {
  sourceRequestId?: string;
  decision: Promise<ApprovalDecision>;
  cancel(reason: string): Promise<CancelResult>;
};

export type ApprovalSource = {
  id: string;
  label: string;
  start(
    request: ApprovalRequest,
    context: ApprovalSourceContext,
  ): Promise<ApprovalHandle>;
};

export type ApprovalStrategy = {
  approvalsRequired: number | "all";
  denyPolicy: "first-deny-veto" | "all-deny" | "ignore-denies";
  cancelLosers: boolean;
  brokerTimeoutMs: number | "none";
  operatorAbort: boolean;
  requiredSources?: string[];
  acknowledgeUnsafeIgnoreDenies?: true;
};

export type ApprovalStrategyPreset =
  | "first-terminal"
  | "all"
  | "threshold"
  | "any-approve"
  | "veto-threshold";

export type ApprovalStrategyInput = Partial<ApprovalStrategy> & {
  preset?: ApprovalStrategyPreset;
};

export type ApprovalBrokerEvent =
  | {
      type: "request-created";
      brokerRequestId: string;
      actionFingerprint: string;
    }
  | { type: "source-started"; sourceId: string; sourceRequestId?: string }
  | {
      type: "source-start-failed";
      sourceId: string;
      kind: ApprovalSourceStartError["kind"];
      message: string;
    }
  | { type: "source-decision"; sourceId: string; decision: "approve" | "deny" }
  | { type: "source-failed"; sourceId: string; message: string }
  | { type: "decision-rejected"; sourceId: string; message: string }
  | {
      type: "late-decision-ignored";
      sourceId: string;
      decision: "approve" | "deny";
    }
  | { type: "cancel-started"; sourceId: string; reason: string }
  | { type: "cancel-result"; sourceId: string; result: CancelResult["status"] }
  | {
      type: "late-terminal-during-cancel";
      sourceId: string;
      decision: "approve" | "deny";
    }
  | { type: "finalized"; decision: "approve" | "deny"; reason: string };

export type ApprovalBrokerResult = {
  brokerRequestId: string;
  request: ApprovalRequest;
  approved: boolean;
  decision: "approve" | "deny";
  reason: string;
  winningDecision?: ApprovalDecision;
  acceptedDecisions: ApprovalDecision[];
  events: ApprovalBrokerEvent[];
};

export type ApprovalBrokerLogger = {
  event(event: ApprovalBrokerEvent): void;
  warn?(message: string): void;
};
