import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import { tmpdirTest as test } from "../../tests/utils/tmpdir";
import {
  createAgentTickApprovalSource,
  type PendingExternalRequest,
  type PendingExternalRequestStore,
  reconcileAgentTickPendingRequests,
} from "./agent-tick-source";
import { createApprovalRequest } from "./request";
import type { ApprovalSourceContext } from "./types";

class MemoryStore implements PendingExternalRequestStore {
  records = new Map<string, PendingExternalRequest>();

  async writeIntent(record: PendingExternalRequest): Promise<void> {
    this.records.set(record.brokerRequestId, record);
  }

  async updateCreated(
    brokerRequestId: string,
    sourceRequestId: string,
  ): Promise<void> {
    const existing = this.records.get(brokerRequestId);
    if (existing)
      this.records.set(brokerRequestId, { ...existing, sourceRequestId });
  }

  async clear(brokerRequestId: string): Promise<void> {
    this.records.delete(brokerRequestId);
  }

  async list(): Promise<PendingExternalRequest[]> {
    return [...this.records.values()];
  }
}

function request() {
  return createApprovalRequest(
    {
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "Dangerous command",
      body: "Approve once for this Pi tool call?",
      risk: "high",
      action: { kind: "tool_call", toolName: "bash", command: "sudo true" },
    },
    {
      brokerRequestId: () => "piapr_test",
      correlationToken: () => "piapr_corr_test",
    },
  );
}

function context(cwd: string): ApprovalSourceContext {
  return {
    signal: new AbortController().signal,
    cwd,
    hasUI: false,
    piContext: createEventContext({ hasUI: false }) as ExtensionContext,
    sourceOrder: 0,
    sourceConfig: undefined,
    redact: (value: unknown) => String(value),
    emitStatus: () => undefined,
  };
}

async function writeFakeAgentTick(
  dir: string,
  mode:
    | "approve"
    | "mismatch"
    | "never"
    | "abandon-responded"
    | "abandon-fails",
) {
  const bin = join(dir, `agent-tick-${mode}.mjs`);
  const callsFile = join(dir, `calls-${mode}.jsonl`);
  const script = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const callsFile = ${JSON.stringify(callsFile)};
appendFileSync(callsFile, JSON.stringify(process.argv.slice(2)) + '\\n');
const command = process.argv[2];
const event = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (command === 'request') {
  event({ type: 'created', requestId: 'agt_123', clientRequestId: 'piapr_test', correlationToken: 'piapr_corr_test', request: { metadata: { piBrokerRequestId: 'piapr_test', sessionId: 'session-1', toolCallId: 'tool-1' } } });
  if (${JSON.stringify(mode)} === 'never' || ${JSON.stringify(mode)} === 'abandon-responded') setInterval(() => {}, 1000);
  else if (${JSON.stringify(mode)} === 'mismatch') event({ type: 'resolved', requestId: 'agt_123', clientRequestId: 'piapr_old', correlationToken: 'piapr_corr_test', decision: 'approve', response: { choiceId: 'approve' } });
  else event({ type: 'resolved', requestId: 'agt_123', clientRequestId: 'piapr_test', correlationToken: 'piapr_corr_test', decision: 'approve', response: { choiceId: 'approve', message: 'ok' } });
} else if (command === 'abandon') {
  if (${JSON.stringify(mode)} === 'abandon-fails') {
    console.error('abandon failed');
    process.exit(1);
  }
  if (${JSON.stringify(mode)} === 'abandon-responded') console.log(JSON.stringify({ requestId: 'agt_123', clientRequestId: 'piapr_test', status: 'responded', abandoned: false, response: { choiceId: 'deny', message: 'No' } }));
  else console.log(JSON.stringify({ requestId: 'agt_123', clientRequestId: 'piapr_test', status: 'abandoned', abandoned: true }));
} else {
  process.exit(2);
}
`;
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { bin, callsFile };
}

async function waitFor(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("timeout waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createAgentTickApprovalSource", () => {
  test("parses created/resolved events, validates correlation, and stores sourceRequestId", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "approve");
    const store = new MemoryStore();
    const source = createAgentTickApprovalSource({ bin: fake.bin, store });

    const handle = await source.start(request(), context(tmpdir));
    const decision = await handle.decision;

    expect(handle.sourceRequestId).toBe("agt_123");
    expect(decision).toMatchObject({
      decision: "approve",
      sourceId: "agent-tick",
      sourceRequestId: "agt_123",
      grantScope: "once",
      message: "ok",
    });
    expect(await store.list()).toEqual([]);
  });

  test("rejects stale or mismatched Agent Tick events", async ({ tmpdir }) => {
    const fake = await writeFakeAgentTick(tmpdir, "mismatch");
    const source = createAgentTickApprovalSource({
      bin: fake.bin,
      store: new MemoryStore(),
    });

    const handle = await source.start(request(), context(tmpdir));

    await expect(handle.decision).rejects.toThrow("clientRequestId mismatch");
  });

  test("calls agent-tick abandon when cancelled and never answers the request", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "never");
    const source = createAgentTickApprovalSource({
      bin: fake.bin,
      store: new MemoryStore(),
    });
    const handle = await source.start(request(), context(tmpdir));

    await waitFor(() => handle.sourceRequestId === "agt_123");
    await expect(handle.cancel("local approval won")).resolves.toEqual({
      status: "cancelled",
    });

    const calls = (await readFile(fake.callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((call) => call[0] === "abandon")).toBe(true);
    expect(calls.flat()).not.toContain("approve");
    expect(calls.flat()).not.toContain("deny");
  });

  test("handles abandon returning an already-responded decision", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "abandon-responded");
    const source = createAgentTickApprovalSource({
      bin: fake.bin,
      store: new MemoryStore(),
    });
    const handle = await source.start(request(), context(tmpdir));

    await waitFor(() => handle.sourceRequestId === "agt_123");

    await expect(handle.cancel("local approval won")).resolves.toMatchObject({
      status: "already-terminal",
      decision: { decision: "deny", message: "No" },
    });
  });

  test("fails closed when no-timeout/no-expiry is configured without abandon support", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "approve");
    const source = createAgentTickApprovalSource({
      bin: fake.bin,
      abandon: false,
      timeout: "none",
      expiresIn: "none",
    });

    await expect(
      source.start(request(), context(tmpdir)),
    ).rejects.toMatchObject({
      kind: "misconfigured",
    });
  });

  test("rejects start as unavailable when the agent-tick executable is missing", async ({
    tmpdir,
  }) => {
    const source = createAgentTickApprovalSource({
      bin: join(tmpdir, "missing-agent-tick"),
      store: new MemoryStore(),
    });

    await expect(
      source.start(request(), context(tmpdir)),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  test("reconciles pending requests by abandoning known Agent Tick request ids", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "approve");
    const store = new MemoryStore();
    await store.writeIntent({
      brokerRequestId: "piapr_orphan",
      sourceId: "agent-tick",
      sourceRequestId: "agt_orphan",
      correlationTokenHash: "hash",
      createdAt: new Date().toISOString(),
    });

    await reconcileAgentTickPendingRequests(
      { bin: fake.bin, store },
      tmpdir,
      () => undefined,
    );

    expect(await store.list()).toEqual([]);
    const calls = (await readFile(fake.callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toContainEqual([
      "abandon",
      "agt_orphan",
      "--client-request-id",
      "piapr_orphan",
      "--reason",
      "Guardrails restart reconciliation",
      "--json",
    ]);
  });

  test("keeps pending records when reconciliation cannot abandon the remote request", async ({
    tmpdir,
  }) => {
    const fake = await writeFakeAgentTick(tmpdir, "abandon-fails");
    const store = new MemoryStore();
    await store.writeIntent({
      brokerRequestId: "piapr_orphan",
      sourceId: "agent-tick",
      sourceRequestId: "agt_orphan",
      correlationTokenHash: "hash",
      createdAt: new Date().toISOString(),
    });
    const statuses: string[] = [];

    await reconcileAgentTickPendingRequests(
      { bin: fake.bin, store },
      tmpdir,
      (message) => statuses.push(message),
    );

    expect(await store.list()).toHaveLength(1);
    expect(statuses.join("\n")).toContain("reconciliation failed");
  });
});
