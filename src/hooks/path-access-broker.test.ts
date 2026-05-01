import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import type { ApprovalBrokerResult, ApprovalGrantScope } from "../approval";
import type { ResolvedConfig } from "../config";
import { configLoader } from "../config";
import { setupPathAccessHook } from "./path-access";

const mockState = vi.hoisted(() => ({
  brokerResult: undefined as ApprovalBrokerResult | undefined,
  config: undefined as ResolvedConfig | undefined,
}));

vi.mock("../config", () => ({
  configLoader: {
    getConfig: vi.fn(() => mockState.config),
    getRawConfig: vi.fn(() => ({ pathAccess: { allowedPaths: [] } })),
    save: vi.fn(async () => undefined),
  },
}));

vi.mock("../approval", () => ({
  ApprovalBroker: class {
    requestApproval = vi.fn(async () => mockState.brokerResult);
  },
  buildApprovalRouteSources: vi.fn((_config, _routeName, localSource) => ({
    sources: [localSource],
    sourceConfigs: {},
    strategy: { preset: "first-terminal" },
  })),
  createLocalApprovalSource: vi.fn(() => ({ id: "local", label: "Local Pi" })),
  isRemoteApprovalSource: vi.fn(
    (sourceId: string) => sourceId === "agent-tick",
  ),
  routeHasEnabledRemoteSource: vi.fn(() => false),
}));

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  },
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

function createMockPi() {
  const handlers: ToolCallHandler[] = [];
  const pi = {
    on(event: string, handler: ToolCallHandler) {
      if (event === "tool_call") handlers.push(handler);
    },
    events: { emit: vi.fn() },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handler() {
      if (!handlers[0]) throw new Error("handler missing");
      return handlers[0];
    },
  };
}

function config(remoteGrantScopes = ["once"]): ResolvedConfig {
  return {
    version: "1",
    enabled: true,
    applyBuiltinDefaults: true,
    features: { policies: false, permissionGate: false, pathAccess: true },
    policies: { rules: [] },
    pathAccess: { mode: "ask", allowedPaths: [] },
    approvalBroker: {
      enabled: true,
      defaultStrategy: {
        preset: "first-terminal",
        approvalsRequired: 1,
        denyPolicy: "first-deny-veto",
        cancelLosers: true,
        brokerTimeoutMs: "none",
        operatorAbort: true,
      },
      sources: {
        local: { type: "local-ui", enabled: true, local: true },
        "agent-tick": {
          type: "agent-tick-cli",
          enabled: true,
          local: false,
        },
      },
      routes: {
        pathAccess: {
          sources: ["local", "agent-tick"],
          strategy: { preset: "first-terminal" },
          remoteGrantScopes: remoteGrantScopes as never,
        },
      },
    },
    permissionGate: {
      patterns: [],
      useBuiltinMatchers: true,
      requireConfirmation: true,
      allowedPatterns: [],
      autoDenyPatterns: [],
      explainCommands: false,
      explainModel: null,
      explainTimeout: 5000,
    },
  };
}

function brokerResult(
  sourceId: string,
  grantScope?: ApprovalGrantScope,
): ApprovalBrokerResult {
  const request = {
    brokerRequestId: "piapr_test",
    correlationToken: "piapr_corr_test",
    title: "Path",
    body: "Path",
    action: {
      kind: "path_access" as const,
      toolName: "read",
      path: "/etc/hosts",
    },
    metadata: { actionFingerprint: "sha256:test" },
  };
  return {
    brokerRequestId: request.brokerRequestId,
    request,
    approved: true,
    decision: "approve",
    reason: "Approval granted",
    winningDecision: {
      brokerRequestId: request.brokerRequestId,
      correlationToken: request.correlationToken,
      sourceId,
      decision: "approve",
      grantScope,
      actionFingerprint: request.metadata.actionFingerprint,
    },
    acceptedDecisions: [],
    events: [],
  };
}

async function run() {
  const { pi, handler } = createMockPi();
  setupPathAccessHook(pi);
  return handler()(
    {
      type: "tool_call",
      toolCallId: "tc_1",
      toolName: "read",
      input: { file_path: "/etc/hosts" },
    },
    createEventContext({
      cwd: "/work/project",
      hasUI: true,
    }) as ExtensionContext,
  );
}

describe("path access broker grant semantics", () => {
  beforeEach(() => {
    mockState.config = config();
    vi.mocked(configLoader.save).mockClear();
    vi.mocked(configLoader.getRawConfig).mockClear();
  });

  it("maps remote approval without an explicit scope to once only", async () => {
    mockState.brokerResult = brokerResult("agent-tick");

    await expect(run()).resolves.toBeUndefined();

    expect(configLoader.save).not.toHaveBeenCalled();
  });

  it("rejects remote scoped grants unless the route allows that scope", async () => {
    mockState.config = config(["once"]);
    mockState.brokerResult = brokerResult("agent-tick", "dir-always");

    await expect(run()).resolves.toMatchObject({
      block: true,
      reason:
        "Remote approval source agent-tick returned disallowed grant scope: dir-always",
    });
    expect(configLoader.save).not.toHaveBeenCalled();
  });

  it("persists local session grants exactly as current behavior", async () => {
    mockState.brokerResult = brokerResult("local", "file-session");

    await expect(run()).resolves.toBeUndefined();

    expect(configLoader.save).toHaveBeenCalledWith("memory", {
      pathAccess: { allowedPaths: ["/etc/hosts"] },
    });
  });

  it("fails closed for unsupported grant scopes", async () => {
    mockState.brokerResult = brokerResult("local", "root-always" as never);

    await expect(run()).resolves.toMatchObject({
      block: true,
      reason: "Approval source returned unsupported grant scope: root-always",
    });
    expect(configLoader.save).not.toHaveBeenCalled();
  });
});
