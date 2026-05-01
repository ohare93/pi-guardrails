import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalAction,
  ApprovalRequest,
  ApprovalRequestInput,
} from "./types";

function normalizeFingerprintString(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(normalizeFingerprintString(value));
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function fingerprintApprovalAction(action: ApprovalAction): string {
  const canonical = stableStringify({
    kind: action.kind,
    toolName: action.toolName,
    command: action.command,
    path:
      action.kind === "path_access" && action.path
        ? action.path.replace(/\\/g, "/")
        : action.path,
    inputPreview: action.inputPreview,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function createBrokerRequestId(): string {
  return `piapr_${randomUUID()}`;
}

export function createCorrelationToken(): string {
  return `piapr_corr_${randomUUID()}`;
}

export function createApprovalRequest(
  input: ApprovalRequestInput,
  ids: {
    brokerRequestId?: () => string;
    correlationToken?: () => string;
  } = {},
): ApprovalRequest {
  const brokerRequestId = (ids.brokerRequestId ?? createBrokerRequestId)();
  const correlationToken = (ids.correlationToken ?? createCorrelationToken)();
  const actionFingerprint = fingerprintApprovalAction(input.action);

  return {
    ...input,
    brokerRequestId,
    correlationToken,
    metadata: {
      ...(input.metadata ?? {}),
      actionFingerprint,
    },
  };
}
