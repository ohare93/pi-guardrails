import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import { ApprovalBroker } from "./broker";
import type {
  ApprovalBrokerEvent,
  ApprovalDecision,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalSource,
  ApprovalSourceContext,
  ApprovalSourceStartError,
  ApprovalStrategyInput,
  CancelResult,
} from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseRequest(): ApprovalRequestInput {
  return {
    sessionId: "session-1",
    toolCallId: "tool-1",
    title: "Dangerous command",
    body: "Approve once?",
    risk: "high",
    action: {
      kind: "tool_call",
      toolName: "bash",
      command: "sudo rm -rf /tmp/demo",
    },
  };
}

function makeBroker(events: ApprovalBrokerEvent[] = []) {
  return new ApprovalBroker({
    idFactory: () => "piapr_test",
    correlationTokenFactory: () => "piapr_corr_test",
    logger: { event: (event) => events.push(event) },
  });
}

class FakeSource implements ApprovalSource {
  label: string;
  request?: ApprovalRequest;
  context?: ApprovalSourceContext;
  cancelCalls: string[] = [];
  handle?: ApprovalHandle;
  private readonly decision = deferred<ApprovalDecision>();

  constructor(
    readonly id: string,
    private readonly options: {
      sourceRequestId?: string;
      startError?: ApprovalSourceStartError;
      cancelResult?: (request: ApprovalRequest) => CancelResult;
    } = {},
  ) {
    this.label = id;
  }

  async start(
    request: ApprovalRequest,
    context: ApprovalSourceContext,
  ): Promise<ApprovalHandle> {
    this.request = request;
    this.context = context;
    if (this.options.startError) throw this.options.startError;
    const handle: ApprovalHandle = {
      sourceRequestId: this.options.sourceRequestId,
      decision: this.decision.promise,
      cancel: vi.fn(async (reason: string) => {
        this.cancelCalls.push(reason);
        const result: CancelResult = this.options.cancelResult?.(request) ?? {
          status: "cancelled",
        };
        return result;
      }),
    };
    this.handle = handle;
    return handle;
  }

  approve(overrides: Partial<ApprovalDecision> = {}) {
    this.decision.resolve(this.buildDecision("approve", overrides));
  }

  deny(overrides: Partial<ApprovalDecision> = {}) {
    this.decision.resolve(this.buildDecision("deny", overrides));
  }

  fail(error: unknown) {
    this.decision.reject(error);
  }

  buildDecision(
    decision: "approve" | "deny",
    overrides: Partial<ApprovalDecision> = {},
  ): ApprovalDecision {
    if (!this.request) throw new Error(`${this.id} has not started`);
    return {
      brokerRequestId: this.request.brokerRequestId,
      correlationToken: this.request.correlationToken,
      sourceId: this.id,
      sourceRequestId: this.options.sourceRequestId,
      decision,
      sessionId: this.request.sessionId,
      toolCallId: this.request.toolCallId,
      actionFingerprint: this.request.metadata.actionFingerprint,
      ...overrides,
    };
  }
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

async function runBroker(
  sources: ApprovalSource[],
  strategy?: ApprovalStrategyInput,
  extra?: { signal?: AbortSignal; events?: ApprovalBrokerEvent[] },
) {
  const broker = makeBroker(extra?.events);
  return broker.requestApproval(baseRequest(), {
    sources,
    strategy,
    cwd: "/work/project",
    hasUI: true,
    piContext: createEventContext() as ExtensionContext,
    signal: extra?.signal,
  });
}

describe("ApprovalBroker", () => {
  it("lets the first terminal decision win for first-terminal and cancels losers", async () => {
    const local = new FakeSource("local");
    const remote = new FakeSource("agent-tick");
    const resultPromise = runBroker([local, remote], {
      preset: "first-terminal",
    });

    await tick();
    local.approve();

    const result = await resultPromise;
    expect(result.approved).toBe(true);
    expect(result.winningDecision?.sourceId).toBe("local");
    expect(remote.cancelCalls).toHaveLength(1);
  });

  it("lets same-turn denial veto an approval for first-deny-veto", async () => {
    const local = new FakeSource("local");
    const remote = new FakeSource("agent-tick");
    const resultPromise = runBroker([local, remote], {
      preset: "first-terminal",
    });

    await tick();
    local.approve();
    remote.deny({ message: "No" });

    await expect(resultPromise).resolves.toMatchObject({
      approved: false,
      reason: "No",
      winningDecision: { sourceId: "agent-tick", decision: "deny" },
    });
  });

  it("logs loser terminal decisions returned during cancellation and ignores them", async () => {
    const events: ApprovalBrokerEvent[] = [];
    const local = new FakeSource("local");
    let remote!: FakeSource;
    remote = new FakeSource("agent-tick", {
      cancelResult: (request): CancelResult => ({
        status: "already-terminal",
        decision: remote.buildDecision("deny", {
          brokerRequestId: request.brokerRequestId,
        }),
      }),
    });
    const resultPromise = runBroker(
      [local, remote],
      { preset: "first-terminal" },
      { events },
    );

    await tick();
    local.approve();

    const result = await resultPromise;
    expect(result.approved).toBe(true);
    expect(events).toContainEqual({
      type: "late-terminal-during-cancel",
      sourceId: "agent-tick",
      decision: "deny",
    });
  });

  it("treats start unavailable as an abstention and blocks only when the threshold is impossible", async () => {
    const unavailable = new FakeSource("missing", {
      startError: {
        sourceId: "missing",
        kind: "unavailable",
        message: "not available",
      },
    });
    const local = new FakeSource("local");
    const firstTerminal = runBroker([unavailable, local], {
      preset: "first-terminal",
    });

    await tick();
    local.approve();
    await expect(firstTerminal).resolves.toMatchObject({ approved: true });

    const blocked = await runBroker(
      [
        new FakeSource("missing", {
          startError: {
            sourceId: "missing",
            kind: "unavailable",
            message: "not available",
          },
        }),
        new FakeSource("local"),
      ],
      {
        preset: "threshold",
        approvalsRequired: 2,
      },
    );
    expect(blocked).toMatchObject({
      approved: false,
      reason: "Approval threshold is impossible to reach",
    });
  });

  it("treats decision rejection as source abstention", async () => {
    const broken = new FakeSource("broken");
    const local = new FakeSource("local");
    const resultPromise = runBroker([broken, local], {
      preset: "first-terminal",
    });

    await tick();
    broken.fail(new Error("network lost"));
    await tick();
    local.approve();

    await expect(resultPromise).resolves.toMatchObject({ approved: true });
  });

  it("blocks and cancels when brokerTimeoutMs expires", async () => {
    vi.useFakeTimers();
    const pending = new FakeSource("pending");
    const resultPromise = runBroker([pending], {
      preset: "first-terminal",
      brokerTimeoutMs: 25,
    });

    await tick();
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toMatchObject({
      approved: false,
      reason: "Approval timed out after 25ms",
    });
    expect(pending.cancelCalls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("operator abort cancels active sources and blocks with no timeout configured", async () => {
    const controller = new AbortController();
    const pending = new FakeSource("pending");
    const resultPromise = runBroker(
      [pending],
      {
        preset: "first-terminal",
        brokerTimeoutMs: "none",
        operatorAbort: true,
      },
      { signal: controller.signal },
    );

    await tick();
    controller.abort("operator denied");

    await expect(resultPromise).resolves.toMatchObject({
      approved: false,
      reason: "operator denied",
    });
    expect(pending.cancelCalls).toHaveLength(1);
  });

  it("supports all, threshold, any-approve, veto-threshold, and requiredSources edge cases", async () => {
    const a = new FakeSource("a");
    const b = new FakeSource("b");
    const allPromise = runBroker([a, b], { preset: "all" });
    await tick();
    a.approve();
    await tick();
    b.approve();
    await expect(allPromise).resolves.toMatchObject({ approved: true });

    const t1 = new FakeSource("a");
    const t2 = new FakeSource("b");
    const t3 = new FakeSource("c");
    const thresholdPromise = runBroker([t1, t2, t3], {
      preset: "threshold",
      approvalsRequired: 2,
    });
    await tick();
    t3.approve();
    t2.approve();
    const threshold = await thresholdPromise;
    expect(threshold.approved).toBe(true);
    expect(threshold.winningDecision?.sourceId).toBe("b");

    const anyA = new FakeSource("a");
    const anyB = new FakeSource("b");
    const anyPromise = runBroker([anyA, anyB], { preset: "any-approve" });
    await tick();
    anyA.deny();
    await tick();
    anyB.approve();
    await expect(anyPromise).resolves.toMatchObject({ approved: true });

    const vetoA = new FakeSource("a");
    const vetoB = new FakeSource("b");
    const vetoPromise = runBroker([vetoA, vetoB], {
      preset: "veto-threshold",
      approvalsRequired: 2,
    });
    await tick();
    vetoB.deny({ message: "No" });
    await expect(vetoPromise).resolves.toMatchObject({
      approved: false,
      reason: "No",
    });

    await expect(
      runBroker([new FakeSource("local")], {
        preset: "first-terminal",
        requiredSources: ["agent-tick"],
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason: "Required approval source(s) not configured: agent-tick",
    });
  });

  it("fails closed instead of approving zero-source or zero-threshold routes", async () => {
    await expect(runBroker([], { preset: "all" })).resolves.toMatchObject({
      approved: false,
      reason: "Approval threshold is impossible to reach",
    });

    const source = new FakeSource("local");
    const resultPromise = runBroker([source], {
      preset: "threshold",
      approvalsRequired: 0,
    });
    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await tick();
    expect(settled).toBe(false);
    source.approve();
    await expect(resultPromise).resolves.toMatchObject({ approved: true });
  });

  it("does not count duplicate source ids as independent approvals", async () => {
    const first = new FakeSource("local");
    const duplicate = new FakeSource("local");

    await expect(
      runBroker([first, duplicate], {
        preset: "threshold",
        approvalsRequired: 2,
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason: "Approval threshold is impossible to reach",
    });
  });

  it("lets route presets replace fallback preset defaults", async () => {
    const broker = makeBroker();
    const a = new FakeSource("a");
    const b = new FakeSource("b");
    const resultPromise = broker.requestApproval(baseRequest(), {
      sources: [a, b],
      strategy: { preset: "all" },
      defaultStrategy: {
        preset: "first-terminal",
        approvalsRequired: 1,
        denyPolicy: "first-deny-veto",
        cancelLosers: true,
        brokerTimeoutMs: "none",
        operatorAbort: true,
      },
      cwd: "/work/project",
      hasUI: true,
      piContext: createEventContext() as ExtensionContext,
    });

    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await tick();
    a.approve();
    await tick();
    expect(settled).toBe(false);
    b.approve();

    await expect(resultPromise).resolves.toMatchObject({ approved: true });
  });

  it("rejects ignore-denies unless explicitly acknowledged", async () => {
    await expect(
      runBroker([new FakeSource("local")], {
        preset: "threshold",
        approvalsRequired: 1,
        denyPolicy: "ignore-denies",
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason:
        "ignore-denies strategy requires acknowledgeUnsafeIgnoreDenies: true",
    });
  });

  it.each([
    ["brokerRequestId", { brokerRequestId: "piapr_old" }],
    ["correlationToken", { correlationToken: "piapr_corr_old" }],
    ["sessionId", { sessionId: "old-session" }],
    ["toolCallId", { toolCallId: "old-tool" }],
    ["actionFingerprint", { actionFingerprint: "sha256:old" }],
  ] as const)("rejects replayed decisions with mismatched %s", async (_name, overrides) => {
    const source = new FakeSource("local");
    const events: ApprovalBrokerEvent[] = [];
    const resultPromise = runBroker(
      [source],
      { preset: "first-terminal" },
      { events },
    );

    await tick();
    source.approve(overrides);

    const result = await resultPromise;
    expect(result.approved).toBe(false);
    expect(events.some((event) => event.type === "decision-rejected")).toBe(
      true,
    );
  });

  it("logs decisions that arrive after finalization as late and ignores them", async () => {
    const events: ApprovalBrokerEvent[] = [];
    const local = new FakeSource("local");
    const remote = new FakeSource("agent-tick");
    const resultPromise = runBroker(
      [local, remote],
      { preset: "first-terminal" },
      { events },
    );

    await tick();
    local.approve();
    const result = await resultPromise;
    expect(result.approved).toBe(true);

    remote.deny();
    await tick();

    expect(events).toContainEqual({
      type: "late-decision-ignored",
      sourceId: "agent-tick",
      decision: "deny",
    });
  });
});
