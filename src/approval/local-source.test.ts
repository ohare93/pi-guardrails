import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import { createLocalApprovalSource } from "./local-source";
import { createApprovalRequest } from "./request";
import type { ApprovalSourceContext } from "./types";

function request() {
  return createApprovalRequest(
    {
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "Path access",
      body: "Approve access?",
      action: { kind: "path_access", toolName: "read", path: "/etc/hosts" },
    },
    {
      brokerRequestId: () => "piapr_test",
      correlationToken: () => "piapr_corr_test",
    },
  );
}

function context(overrides: Partial<ApprovalSourceContext> = {}) {
  const controller = new AbortController();
  return {
    controller,
    value: {
      signal: controller.signal,
      cwd: "/work/project",
      hasUI: true,
      piContext: createEventContext() as ExtensionContext,
      sourceOrder: 0,
      sourceConfig: undefined,
      redact: (value: unknown) => String(value),
      emitStatus: vi.fn(),
      ...overrides,
    } satisfies ApprovalSourceContext,
  };
}

describe("createLocalApprovalSource", () => {
  it("returns approve or deny from custom UI results", async () => {
    const source = createLocalApprovalSource<"yes" | "no">({
      createCustomPrompt: () =>
        (() => ({
          render: () => [],
          invalidate: () => undefined,
        })) as never,
      mapResult: (result) => ({
        decision: result === "yes" ? "approve" : "deny",
      }),
    });
    const ctx = context();
    ctx.value.piContext.ui.custom = vi.fn(
      async () => "yes",
    ) as ExtensionContext["ui"]["custom"];

    const handle = await source.start(request(), ctx.value);

    await expect(handle.decision).resolves.toMatchObject({
      decision: "approve",
      sourceId: "local",
      brokerRequestId: "piapr_test",
      correlationToken: "piapr_corr_test",
    });
  });

  it("rejects as unavailable with no UI", async () => {
    const source = createLocalApprovalSource<string>({
      mapResult: () => ({ decision: "deny" }),
    });
    const ctx = context({ hasUI: false });

    await expect(source.start(request(), ctx.value)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("falls back to select when custom returns undefined", async () => {
    const source = createLocalApprovalSource<"approve" | "deny">({
      createCustomPrompt: () =>
        (() => ({
          render: () => [],
          invalidate: () => undefined,
        })) as never,
      fallbackSelect: {
        title: () => "Approve?",
        options: ["Allow once", "Deny"],
        mapSelection: (selection) =>
          selection === "Allow once" ? "approve" : "deny",
      },
      mapResult: (result) => ({
        decision: result === "approve" ? "approve" : "deny",
      }),
    });
    const ctx = context();
    ctx.value.piContext.ui.custom = vi.fn(
      async () => undefined,
    ) as ExtensionContext["ui"]["custom"];
    ctx.value.piContext.ui.select = vi.fn(
      async () => "Allow once",
    ) as ExtensionContext["ui"]["select"];

    const handle = await source.start(request(), ctx.value);

    await expect(handle.decision).resolves.toMatchObject({
      decision: "approve",
    });
    expect(ctx.value.piContext.ui.select).toHaveBeenCalled();
  });

  it("aborts when the broker signal is aborted", async () => {
    const source = createLocalApprovalSource<string>({
      createCustomPrompt: () =>
        (() => ({
          render: () => [],
          invalidate: () => undefined,
        })) as never,
      mapResult: () => ({ decision: "approve" }),
    });
    const ctx = context();
    ctx.value.piContext.ui.custom = vi.fn(
      () => new Promise(() => undefined),
    ) as ExtensionContext["ui"]["custom"];

    const handle = await source.start(request(), ctx.value);
    ctx.controller.abort();

    await expect(handle.decision).rejects.toThrow("aborted");
  });

  it("preserves scoped path grants", async () => {
    const source = createLocalApprovalSource<"file-always">({
      mapResult: () => ({ decision: "approve", grantScope: "file-always" }),
    });
    const ctx = context();

    const handle = await source.start(request(), ctx.value);

    await expect(handle.decision).resolves.toMatchObject({
      decision: "approve",
      grantScope: "file-always",
    });
  });
});
