import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalSource,
  ApprovalSourceContext,
  ApprovalSourceStartError,
  CancelResult,
} from "./types";

export type PendingExternalRequest = {
  brokerRequestId: string;
  sourceId: "agent-tick";
  sourceRequestId?: string;
  correlationTokenHash: string;
  sessionId?: string;
  toolCallId?: string;
  createdAt: string;
};

export type PendingExternalRequestStore = {
  writeIntent(record: PendingExternalRequest): Promise<void>;
  updateCreated(
    brokerRequestId: string,
    sourceRequestId: string,
  ): Promise<void>;
  clear(brokerRequestId: string): Promise<void>;
  list(): Promise<PendingExternalRequest[]>;
};

export class JsonFilePendingExternalRequestStore
  implements PendingExternalRequestStore
{
  constructor(private readonly filePath: string) {}

  async writeIntent(record: PendingExternalRequest): Promise<void> {
    const records = (await this.list()).filter(
      (existing) => existing.brokerRequestId !== record.brokerRequestId,
    );
    records.push(record);
    await this.write(records);
  }

  async updateCreated(
    brokerRequestId: string,
    sourceRequestId: string,
  ): Promise<void> {
    const records = await this.list();
    const next = records.map((record) =>
      record.brokerRequestId === brokerRequestId
        ? { ...record, sourceRequestId }
        : record,
    );
    await this.write(next);
  }

  async clear(brokerRequestId: string): Promise<void> {
    await this.write(
      (await this.list()).filter(
        (record) => record.brokerRequestId !== brokerRequestId,
      ),
    );
  }

  async list(): Promise<PendingExternalRequest[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const value = JSON.parse(text) as unknown;
      return Array.isArray(value) ? (value as PendingExternalRequest[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(records: PendingExternalRequest[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}

export type AgentTickSourceConfig = {
  type?: "agent-tick-cli" | string;
  enabled?: boolean;
  bin?: string;
  timeout?: number | "none";
  expiresIn?: number | "none";
  requireAbandonForNoExpiry?: boolean;
  abandon?: boolean;
  extraArgs?: string[];
  store?: PendingExternalRequestStore;
};

type AgentTickEvent = {
  type?: string;
  requestId?: string;
  clientRequestId?: string;
  correlationToken?: string;
  status?: string;
  decision?: string;
  respondedAt?: string;
  response?: { choiceId?: string; message?: string };
  request?: { metadata?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
};

function makeStartError(
  sourceId: string,
  kind: ApprovalSourceStartError["kind"],
  message: string,
): ApprovalSourceStartError {
  return { sourceId, kind, message };
}

function correlationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildRequestArgs(
  request: ApprovalRequest,
  config: AgentTickSourceConfig,
) {
  const args = [
    "request",
    "--json-events",
    "--client-request-id",
    request.brokerRequestId,
    "--correlation-token",
    request.correlationToken,
    "--title",
    request.title,
    "--body",
    request.body,
    "--metadata",
    JSON.stringify({
      ...request.metadata,
      piBrokerRequestId: request.brokerRequestId,
      correlationToken: request.correlationToken,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      actionFingerprint: request.metadata.actionFingerprint,
      toolName: request.action.toolName,
      actionKind: request.action.kind,
    }),
  ];

  if (request.risk) args.push("--risk", request.risk);
  if (config.timeout === "none") args.push("--no-timeout");
  else if (typeof config.timeout === "number")
    args.push("--timeout", String(config.timeout));
  if (config.expiresIn === "none") args.push("--no-expiry");
  else if (typeof config.expiresIn === "number")
    args.push("--expires-in", String(config.expiresIn));
  args.push(...(config.extraArgs ?? []));
  return args;
}

function validateEvent(
  request: ApprovalRequest,
  event: AgentTickEvent,
  sourceRequestId?: string,
): string | undefined {
  if (event.clientRequestId !== request.brokerRequestId) {
    return "Agent Tick event clientRequestId mismatch";
  }
  if (event.correlationToken !== request.correlationToken) {
    return "Agent Tick event correlationToken mismatch";
  }
  if (sourceRequestId && event.requestId !== sourceRequestId) {
    return "Agent Tick event requestId mismatch";
  }

  const metadata = event.metadata ?? event.request?.metadata;
  if (metadata) {
    if (
      metadata.piBrokerRequestId &&
      metadata.piBrokerRequestId !== request.brokerRequestId
    ) {
      return "Agent Tick event metadata broker request mismatch";
    }
    if (
      metadata.actionFingerprint &&
      metadata.actionFingerprint !== request.metadata.actionFingerprint
    ) {
      return "Agent Tick event action fingerprint mismatch";
    }
    if (request.sessionId && metadata.sessionId !== request.sessionId) {
      return "Agent Tick event sessionId mismatch";
    }
    if (request.toolCallId && metadata.toolCallId !== request.toolCallId) {
      return "Agent Tick event toolCallId mismatch";
    }
  }

  return undefined;
}

function eventToDecision(
  request: ApprovalRequest,
  event: AgentTickEvent,
  sourceId: string,
  sourceRequestId: string,
): ApprovalDecision {
  const decision = event.decision ?? event.response?.choiceId;
  if (decision !== "approve" && decision !== "deny") {
    throw new Error(`Unsupported Agent Tick decision: ${String(decision)}`);
  }

  return {
    brokerRequestId: request.brokerRequestId,
    correlationToken: request.correlationToken,
    sourceId,
    sourceRequestId,
    decision,
    message: event.response?.message,
    grantScope: "once",
    sourceDecidedAt: event.respondedAt,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    actionFingerprint: request.metadata.actionFingerprint,
  };
}

async function readJsonFromCommand(
  bin: string,
  args: string[],
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `agent-tick exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseAbandonResponse(
  request: ApprovalRequest,
  sourceId: string,
  sourceRequestId: string,
  value: unknown,
): CancelResult {
  const response = value as {
    status?: string;
    abandoned?: boolean;
    response?: { choiceId?: string; message?: string };
    respondedAt?: string;
  };

  if (response.abandoned === false && response.status === "responded") {
    const decision = response.response?.choiceId;
    if (decision === "approve" || decision === "deny") {
      return {
        status: "already-terminal",
        decision: {
          brokerRequestId: request.brokerRequestId,
          correlationToken: request.correlationToken,
          sourceId,
          sourceRequestId,
          decision,
          message: response.response?.message,
          grantScope: "once",
          sourceDecidedAt: response.respondedAt,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          actionFingerprint: request.metadata.actionFingerprint,
        },
      };
    }
  }

  return { status: "cancelled" };
}

export function createDefaultAgentTickPendingStore(
  cwd: string,
): PendingExternalRequestStore {
  return new JsonFilePendingExternalRequestStore(
    join(cwd, ".pi", "guardrails-agent-tick-pending.json"),
  );
}

export async function reconcileAgentTickPendingRequests(
  rawConfig: AgentTickSourceConfig,
  cwd: string,
  emitStatus: (message: string) => void = () => undefined,
): Promise<void> {
  const config: AgentTickSourceConfig = {
    bin: "agent-tick",
    abandon: true,
    ...rawConfig,
  };
  const store = config.store ?? createDefaultAgentTickPendingStore(cwd);
  const records = await store.list();

  for (const record of records) {
    if (!record.sourceRequestId) {
      emitStatus(
        `Agent Tick pending approval ${record.brokerRequestId} had no remote request id; clearing orphaned intent`,
      );
      await store.clear(record.brokerRequestId);
      continue;
    }

    if (config.abandon === false) {
      emitStatus(
        `Agent Tick pending approval ${record.sourceRequestId} could not be abandoned because abandon support is disabled`,
      );
      continue;
    }

    try {
      await readJsonFromCommand(config.bin ?? "agent-tick", [
        "abandon",
        record.sourceRequestId,
        "--client-request-id",
        record.brokerRequestId,
        "--reason",
        "Guardrails restart reconciliation",
        "--json",
      ]);
      emitStatus(
        `Agent Tick pending approval ${record.sourceRequestId} reconciled and abandoned`,
      );
      await store.clear(record.brokerRequestId);
    } catch (error) {
      emitStatus(
        `Agent Tick pending approval ${record.sourceRequestId} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function createAgentTickApprovalSource(
  rawConfig: AgentTickSourceConfig = {},
): ApprovalSource {
  const sourceId = "agent-tick";
  const config: AgentTickSourceConfig = {
    bin: "agent-tick",
    timeout: "none",
    expiresIn: "none",
    requireAbandonForNoExpiry: true,
    abandon: true,
    ...rawConfig,
  };

  return {
    id: sourceId,
    label: "Agent Tick",
    async start(
      request: ApprovalRequest,
      context: ApprovalSourceContext,
    ): Promise<ApprovalHandle> {
      if (
        config.requireAbandonForNoExpiry &&
        (config.timeout === "none" || config.expiresIn === "none") &&
        config.abandon === false
      ) {
        throw makeStartError(
          sourceId,
          "misconfigured",
          "Agent Tick no-timeout/no-expiry routes require abandon support",
        );
      }

      const store =
        config.store ?? createDefaultAgentTickPendingStore(context.cwd);
      await store.writeIntent({
        brokerRequestId: request.brokerRequestId,
        sourceId,
        correlationTokenHash: correlationTokenHash(request.correlationToken),
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        createdAt: new Date().toISOString(),
      });

      const storeOperation = { current: Promise.resolve() };
      const enqueueStoreOperation = <T>(operation: () => Promise<T>) => {
        const next = storeOperation.current.then(operation, operation);
        storeOperation.current = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };

      const args = buildRequestArgs(request, config);
      const child = spawn(config.bin ?? "agent-tick", args, {
        cwd: context.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let sourceRequestId: string | undefined;
      let stdoutBuffer = "";
      let settled = false;
      let created = false;
      let startupError: Error | undefined;
      child.once("error", (error) => {
        startupError = error;
      });
      const handle: ApprovalHandle = {
        get sourceRequestId() {
          return sourceRequestId;
        },
        decision: new Promise<ApprovalDecision>((resolve, reject) => {
          const fail = async (error: Error) => {
            if (settled) return;
            settled = true;
            if (!created)
              await enqueueStoreOperation(() =>
                store.clear(request.brokerRequestId),
              ).catch(() => undefined);
            reject(error);
          };

          child.on("error", (error) => {
            void fail(error);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();
            if (text) context.emitStatus(text);
          });

          child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
            for (;;) {
              const newline = stdoutBuffer.indexOf("\n");
              if (newline === -1) break;
              const line = stdoutBuffer.slice(0, newline).trim();
              stdoutBuffer = stdoutBuffer.slice(newline + 1);
              if (!line) continue;

              let event: AgentTickEvent;
              try {
                event = JSON.parse(line) as AgentTickEvent;
              } catch (error) {
                void fail(
                  error instanceof Error ? error : new Error(String(error)),
                );
                return;
              }

              const validation = validateEvent(request, event, sourceRequestId);
              if (validation) {
                void fail(new Error(validation));
                return;
              }

              if (event.type === "created") {
                if (!event.requestId) {
                  void fail(
                    new Error("Agent Tick created event missing requestId"),
                  );
                  return;
                }
                const createdRequestId = event.requestId;
                sourceRequestId = createdRequestId;
                created = true;
                void enqueueStoreOperation(() =>
                  store.updateCreated(
                    request.brokerRequestId,
                    createdRequestId,
                  ),
                );
                context.emitStatus(
                  `Agent Tick approval request ${createdRequestId} created`,
                );
                continue;
              }

              if (event.type === "resolved") {
                if (!event.requestId) {
                  void fail(
                    new Error("Agent Tick resolved event missing requestId"),
                  );
                  return;
                }
                let decision: ApprovalDecision;
                try {
                  decision = eventToDecision(
                    request,
                    event,
                    sourceId,
                    event.requestId,
                  );
                } catch (error) {
                  void fail(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                  return;
                }
                sourceRequestId ??= event.requestId;
                settled = true;
                void enqueueStoreOperation(() =>
                  store.clear(request.brokerRequestId),
                ).catch(() => undefined);
                resolve(decision);
              }
            }
          });

          child.on("close", (code) => {
            if (settled) return;
            void fail(
              new Error(`agent-tick exited before a decision (${code})`),
            );
          });
        }),
        async cancel(reason: string) {
          if (!sourceRequestId) {
            settled = true;
            child.kill("SIGTERM");
            await enqueueStoreOperation(() =>
              store.clear(request.brokerRequestId),
            ).catch(() => undefined);
            return { status: "cancelled" };
          }

          if (config.abandon === false) {
            settled = true;
            child.kill("SIGTERM");
            return {
              status: "not-supported",
              message: "Agent Tick abandon is disabled",
            };
          }

          const response = await readJsonFromCommand(
            config.bin ?? "agent-tick",
            [
              "abandon",
              sourceRequestId,
              "--client-request-id",
              request.brokerRequestId,
              "--reason",
              reason,
              "--json",
            ],
          );
          settled = true;
          child.kill("SIGTERM");
          await enqueueStoreOperation(() =>
            store.clear(request.brokerRequestId),
          ).catch(() => undefined);
          return parseAbandonResponse(
            request,
            sourceId,
            sourceRequestId,
            response,
          );
        },
      };

      handle.decision.catch(() => undefined);

      await new Promise((resolve) => setImmediate(resolve));
      if (startupError && !created) {
        settled = true;
        await enqueueStoreOperation(() =>
          store.clear(request.brokerRequestId),
        ).catch(() => undefined);
        throw makeStartError(sourceId, "unavailable", startupError.message);
      }

      return handle;
    },
  };
}
