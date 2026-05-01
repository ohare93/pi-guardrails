import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  ApprovalDecision,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalSource,
  ApprovalSourceContext,
  ApprovalSourceStartError,
} from "./types";

export type LocalPromptDecision = {
  decision: "approve" | "deny";
  message?: string;
  grantScope?: ApprovalDecision["grantScope"];
  metadata?: Record<string, string>;
};

export type LocalApprovalSourceOptions<Result> = {
  id?: string;
  label?: string;
  createCustomPrompt?: (
    request: ApprovalRequest,
  ) => Parameters<ExtensionContext["ui"]["custom"]>[0];
  fallbackSelect?: {
    title: (request: ApprovalRequest) => string;
    options: readonly string[];
    mapSelection(selection: string | undefined): Result;
  };
  mapResult(
    result: Result | undefined,
    request: ApprovalRequest,
  ): LocalPromptDecision;
};

function makeDecision(
  request: ApprovalRequest,
  sourceId: string,
  result: LocalPromptDecision,
): ApprovalDecision {
  return {
    brokerRequestId: request.brokerRequestId,
    correlationToken: request.correlationToken,
    sourceId,
    decision: result.decision,
    message: result.message,
    grantScope: result.grantScope,
    sourceDecidedAt: new Date().toISOString(),
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    actionFingerprint: request.metadata.actionFingerprint,
    metadata: result.metadata,
  };
}

function unavailable(sourceId: string): ApprovalSourceStartError {
  return {
    sourceId,
    kind: "unavailable",
    message: "Local Pi UI is not available for this approval request",
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("Local approval prompt was aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("Local approval prompt was aborted")),
      { once: true },
    );
  });
}

export function createLocalApprovalSource<Result>(
  options: LocalApprovalSourceOptions<Result>,
): ApprovalSource {
  const sourceId = options.id ?? "local";

  return {
    id: sourceId,
    label: options.label ?? "Local Pi",
    async start(
      request: ApprovalRequest,
      context: ApprovalSourceContext,
    ): Promise<ApprovalHandle> {
      if (!context.hasUI) throw unavailable(sourceId);

      const promptPromise = (async (): Promise<ApprovalDecision> => {
        let result: Result | undefined;

        if (options.createCustomPrompt) {
          result = (await context.piContext.ui.custom(
            options.createCustomPrompt(request) as never,
          )) as Result | undefined;
        }

        if (result === undefined && options.fallbackSelect) {
          const selection = await context.piContext.ui.select(
            options.fallbackSelect.title(request),
            [...options.fallbackSelect.options],
          );
          result = options.fallbackSelect.mapSelection(selection);
        }

        return makeDecision(
          request,
          sourceId,
          options.mapResult(result, request),
        );
      })();

      promptPromise.catch(() => undefined);

      let cancelled = false;
      const decision = Promise.race([
        promptPromise,
        waitForAbort(context.signal),
      ]).then((value) => {
        if (cancelled) throw new Error("Local approval prompt was cancelled");
        return value;
      });

      return {
        decision,
        async cancel() {
          cancelled = true;
          return { status: "cancelled" };
        },
      };
    },
  };
}
