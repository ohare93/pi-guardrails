import { createApprovalRequest } from "./request";
import {
  requiredApprovalCount,
  resolveApprovalStrategy,
  validateApprovalStrategy,
} from "./strategy";
import type {
  ApprovalBrokerEvent,
  ApprovalBrokerLogger,
  ApprovalBrokerResult,
  ApprovalDecision,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalSource,
  ApprovalSourceStartError,
  ApprovalStrategy,
  ApprovalStrategyInput,
} from "./types";

interface SourceState {
  source: ApprovalSource;
  order: number;
  status: "starting" | "pending" | "approved" | "denied" | "failed";
  handle?: ApprovalHandle;
  decision?: ApprovalDecision;
  failure?: string;
}

export interface ApprovalBrokerOptions {
  sources: ApprovalSource[];
  strategy?: ApprovalStrategyInput;
  defaultStrategy?: ApprovalStrategyInput;
  cwd: string;
  hasUI: boolean;
  piContext: Parameters<ApprovalSource["start"]>[1]["piContext"];
  sourceConfigs?: Record<string, unknown>;
  signal?: AbortSignal;
  redact?: (value: unknown) => string;
  emitStatus?: (message: string) => void;
}

export interface ApprovalBrokerDefaults {
  idFactory?: () => string;
  correlationTokenFactory?: () => string;
  logger?: ApprovalBrokerLogger;
}

interface SettledDecision {
  state: SourceState;
  decision?: ApprovalDecision;
  error?: unknown;
}

function defaultRedact(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}

function normalizeStartError(
  sourceId: string,
  error: unknown,
): ApprovalSourceStartError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error
  ) {
    const candidate = error as Partial<ApprovalSourceStartError>;
    return {
      sourceId: candidate.sourceId ?? sourceId,
      kind:
        candidate.kind === "unavailable" ||
        candidate.kind === "misconfigured" ||
        candidate.kind === "failed"
          ? candidate.kind
          : "failed",
      message: String(candidate.message),
    };
  }

  return {
    sourceId,
    kind: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function missingRequiredSources(
  strategy: ApprovalStrategy,
  sources: ApprovalSource[],
): string[] {
  if (!strategy.requiredSources?.length) return [];
  const configured = new Set(sources.map((source) => source.id));
  return strategy.requiredSources.filter(
    (sourceId) => !configured.has(sourceId),
  );
}

function validateDecision(
  request: ApprovalRequest,
  state: SourceState,
  decision: ApprovalDecision,
): string | undefined {
  if (decision.brokerRequestId !== request.brokerRequestId) {
    return `decision brokerRequestId mismatch for ${state.source.id}`;
  }
  if (decision.correlationToken !== request.correlationToken) {
    return `decision correlationToken mismatch for ${state.source.id}`;
  }
  if (decision.sourceId !== state.source.id) {
    return `decision sourceId mismatch for ${state.source.id}`;
  }
  if (
    state.handle?.sourceRequestId &&
    decision.sourceRequestId !== state.handle.sourceRequestId
  ) {
    return `decision sourceRequestId mismatch for ${state.source.id}`;
  }
  if (request.sessionId && decision.sessionId !== request.sessionId) {
    return `decision sessionId mismatch for ${state.source.id}`;
  }
  if (request.toolCallId && decision.toolCallId !== request.toolCallId) {
    return `decision toolCallId mismatch for ${state.source.id}`;
  }
  if (decision.actionFingerprint !== request.metadata.actionFingerprint) {
    return `decision actionFingerprint mismatch for ${state.source.id}`;
  }
  return undefined;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortErrorMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : signal.reason
      ? String(signal.reason)
      : "operator aborted approval request";
}

export class ApprovalBroker {
  private readonly idFactory?: () => string;
  private readonly correlationTokenFactory?: () => string;
  private readonly logger?: ApprovalBrokerLogger;

  constructor(defaults: ApprovalBrokerDefaults = {}) {
    this.idFactory = defaults.idFactory;
    this.correlationTokenFactory = defaults.correlationTokenFactory;
    this.logger = defaults.logger;
  }

  async requestApproval(
    input: ApprovalRequestInput,
    options: ApprovalBrokerOptions,
  ): Promise<ApprovalBrokerResult> {
    const request = createApprovalRequest(input, {
      brokerRequestId: this.idFactory,
      correlationToken: this.correlationTokenFactory,
    });
    const strategy = resolveApprovalStrategy(
      options.strategy,
      options.defaultStrategy,
    );
    const sources: ApprovalSource[] = [];
    const seenSourceIds = new Set<string>();
    for (const source of options.sources) {
      if (seenSourceIds.has(source.id)) {
        this.logger?.warn?.(
          `approvalBroker route configured duplicate source id "${source.id}"; ignoring duplicate`,
        );
        continue;
      }
      seenSourceIds.add(source.id);
      sources.push(source);
    }
    const states: SourceState[] = sources.map((source, order) => ({
      source,
      order,
      status: "starting",
    }));
    const events: ApprovalBrokerEvent[] = [];
    const acceptedDecisions: ApprovalDecision[] = [];
    const controller = new AbortController();
    const redact = options.redact ?? defaultRedact;
    const emitStatus = options.emitStatus ?? (() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finalizeStarted = false;
    let finalResult: ApprovalBrokerResult | undefined;
    let resolveResult: (result: ApprovalBrokerResult) => void = () => undefined;
    const resultPromise = new Promise<ApprovalBrokerResult>((resolve) => {
      resolveResult = resolve;
    });
    let settlementBatch: SettledDecision[] = [];
    let batchQueued = false;

    const record = (event: ApprovalBrokerEvent) => {
      events.push(event);
      this.logger?.event(event);
    };

    record({
      type: "request-created",
      brokerRequestId: request.brokerRequestId,
      actionFingerprint: request.metadata.actionFingerprint,
    });

    const missing = missingRequiredSources(strategy, sources);
    if (missing.length > 0) {
      record({
        type: "finalized",
        decision: "deny",
        reason: `Required approval source(s) not configured: ${missing.join(", ")}`,
      });
      return {
        brokerRequestId: request.brokerRequestId,
        request,
        approved: false,
        decision: "deny",
        reason: `Required approval source(s) not configured: ${missing.join(", ")}`,
        acceptedDecisions,
        events,
      };
    }

    for (const warning of validateApprovalStrategy(strategy)) {
      this.logger?.warn?.(warning);
    }

    if (
      strategy.denyPolicy === "ignore-denies" &&
      strategy.acknowledgeUnsafeIgnoreDenies !== true
    ) {
      const reason =
        "ignore-denies strategy requires acknowledgeUnsafeIgnoreDenies: true";
      record({ type: "finalized", decision: "deny", reason });
      return {
        brokerRequestId: request.brokerRequestId,
        request,
        approved: false,
        decision: "deny",
        reason,
        acceptedDecisions,
        events,
      };
    }

    const complete = async (
      decision: "approve" | "deny",
      reason: string,
      winningDecision?: ApprovalDecision,
    ) => {
      if (finalizeStarted) return;
      finalizeStarted = true;
      if (timeout) clearTimeout(timeout);
      controller.abort(reason);
      record({ type: "finalized", decision, reason });

      if (strategy.cancelLosers) {
        const cancellations = states
          .filter((state) => {
            if (!state.handle) return false;
            if (!winningDecision) return true;
            return state.source.id !== winningDecision.sourceId;
          })
          .map(async (state) => {
            record({
              type: "cancel-started",
              sourceId: state.source.id,
              reason,
            });
            try {
              const result = await state.handle?.cancel(reason);
              if (!result) return;
              record({
                type: "cancel-result",
                sourceId: state.source.id,
                result: result.status,
              });
              if (result.status === "already-terminal") {
                const rejected = validateDecision(
                  request,
                  state,
                  result.decision,
                );
                if (rejected) {
                  record({
                    type: "decision-rejected",
                    sourceId: state.source.id,
                    message: rejected,
                  });
                } else {
                  record({
                    type: "late-terminal-during-cancel",
                    sourceId: state.source.id,
                    decision: result.decision.decision,
                  });
                }
              }
            } catch (error) {
              record({
                type: "source-failed",
                sourceId: state.source.id,
                message: failureMessage(error),
              });
            }
          });
        await Promise.allSettled(cancellations);
      }

      finalResult = {
        brokerRequestId: request.brokerRequestId,
        request,
        approved: decision === "approve",
        decision,
        reason,
        winningDecision,
        acceptedDecisions: [...acceptedDecisions],
        events: [...events],
      };
      resolveResult(finalResult);
    };

    const evaluate = () => {
      if (finalizeStarted) return;

      const required = requiredApprovalCount(strategy, states.length);
      const approvals = states.filter((state) => state.status === "approved");
      const denials = states.filter((state) => state.status === "denied");
      const pending = states.filter(
        (state) => state.status === "starting" || state.status === "pending",
      );
      const possibleApprovals = approvals.length + pending.length;

      if (strategy.denyPolicy === "first-deny-veto" && denials.length > 0) {
        const denied = denials[0];
        void complete(
          "deny",
          denied.decision?.message ?? "Approval denied by source",
          denied.decision,
        );
        return;
      }

      if (approvals.length >= required) {
        const winner = approvals.sort((a, b) => a.order - b.order)[0];
        void complete(
          "approve",
          winner.decision?.message ?? "Approval granted",
          winner.decision,
        );
        return;
      }

      if (possibleApprovals < required) {
        void complete(
          "deny",
          "Approval threshold is impossible to reach",
          denials[0]?.decision,
        );
        return;
      }

      if (
        strategy.denyPolicy === "all-deny" &&
        pending.length === 0 &&
        approvals.length < required
      ) {
        void complete(
          "deny",
          denials[0]?.decision?.message ??
            "All approval sources denied or abstained",
          denials[0]?.decision,
        );
      }
    };

    const processSettlements = () => {
      batchQueued = false;
      const batch = settlementBatch.sort(
        (a, b) => a.state.order - b.state.order,
      );
      settlementBatch = [];
      const validDecisions: Array<{
        state: SourceState;
        decision: ApprovalDecision;
      }> = [];

      for (const settled of batch) {
        const { state } = settled;
        if (settled.error) {
          if (finalizeStarted) continue;
          state.status = "failed";
          state.failure = failureMessage(settled.error);
          record({
            type: "source-failed",
            sourceId: state.source.id,
            message: state.failure,
          });
          continue;
        }

        const decision = settled.decision;
        if (!decision) continue;
        const rejected = validateDecision(request, state, decision);
        if (rejected) {
          if (!finalizeStarted) {
            state.status = "failed";
            state.failure = rejected;
          }
          record({
            type: "decision-rejected",
            sourceId: state.source.id,
            message: rejected,
          });
          continue;
        }

        if (finalizeStarted) {
          record({
            type: "late-decision-ignored",
            sourceId: state.source.id,
            decision: decision.decision,
          });
          continue;
        }

        validDecisions.push({ state, decision });
      }

      const orderedDecisions = validDecisions.sort(
        (a, b) => a.state.order - b.state.order,
      );
      const decisionsToRecord =
        strategy.denyPolicy === "first-deny-veto" &&
        orderedDecisions.some((item) => item.decision.decision === "deny")
          ? [
              ...orderedDecisions.filter(
                (item) => item.decision.decision === "deny",
              ),
              ...orderedDecisions.filter(
                (item) => item.decision.decision !== "deny",
              ),
            ]
          : orderedDecisions;

      for (const { state, decision } of decisionsToRecord) {
        if (finalizeStarted) {
          record({
            type: "late-decision-ignored",
            sourceId: state.source.id,
            decision: decision.decision,
          });
          continue;
        }

        state.status = decision.decision === "approve" ? "approved" : "denied";
        state.decision = decision;
        acceptedDecisions.push(decision);
        record({
          type: "source-decision",
          sourceId: state.source.id,
          decision: decision.decision,
        });
      }

      evaluate();
    };

    const queueSettlement = (settled: SettledDecision) => {
      settlementBatch.push(settled);
      if (batchQueued) return;
      batchQueued = true;
      queueMicrotask(processSettlements);
    };

    if (options.signal && strategy.operatorAbort) {
      if (options.signal.aborted) {
        void complete("deny", abortErrorMessage(options.signal));
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            void complete(
              "deny",
              abortErrorMessage(options.signal as AbortSignal),
            );
          },
          { once: true },
        );
      }
    }

    if (strategy.brokerTimeoutMs !== "none") {
      timeout = setTimeout(() => {
        void complete(
          "deny",
          `Approval timed out after ${strategy.brokerTimeoutMs}ms`,
        );
      }, strategy.brokerTimeoutMs);
    }

    for (const state of states) {
      void (async () => {
        if (finalizeStarted) return;
        try {
          const handle = await state.source.start(request, {
            signal: controller.signal,
            cwd: options.cwd,
            hasUI: options.hasUI,
            piContext: options.piContext,
            sourceOrder: state.order,
            sourceConfig: options.sourceConfigs?.[state.source.id],
            redact,
            emitStatus,
          });

          if (finalizeStarted) {
            await handle.cancel("Approval already finalized");
            return;
          }

          state.handle = handle;
          state.status = "pending";
          record({
            type: "source-started",
            sourceId: state.source.id,
            sourceRequestId: handle.sourceRequestId,
          });
          handle.decision.then(
            (decision) => queueSettlement({ state, decision }),
            (error) => queueSettlement({ state, error }),
          );
        } catch (error) {
          if (finalizeStarted) return;
          const startError = normalizeStartError(state.source.id, error);
          state.status = "failed";
          state.failure = startError.message;
          record({
            type: "source-start-failed",
            sourceId: state.source.id,
            kind: startError.kind,
            message: startError.message,
          });
          evaluate();
        }
      })();
    }

    evaluate();

    return resultPromise.then((result) => finalResult ?? result);
  }
}
