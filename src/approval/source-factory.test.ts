import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../config";
import { buildApprovalRouteSources } from "./source-factory";
import type { ApprovalSource } from "./types";

const localSource: ApprovalSource = {
  id: "local",
  label: "Local Pi",
  async start() {
    throw new Error("not used");
  },
};

function configWithApprovalBroker(
  approvalBroker: Partial<ResolvedConfig["approvalBroker"]>,
): ResolvedConfig {
  return {
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
      sources: {},
      routes: {},
      ...approvalBroker,
    },
  } as ResolvedConfig;
}

describe("buildApprovalRouteSources", () => {
  it("ignores unknown route source ids and does not duplicate the local source", () => {
    const localConfig = { type: "local-ui", enabled: true, local: true };
    const config = configWithApprovalBroker({
      sources: { local: localConfig },
      routes: {
        permissionGate: { sources: ["local", "unknown-local", "local"] },
      },
    });

    const route = buildApprovalRouteSources(
      config,
      "permissionGate",
      localSource,
    );

    expect(route.sources.map((source) => source.id)).toEqual(["local"]);
    expect(route.sourceConfigs.local).toBe(localConfig);
  });

  it("does not implicitly enable Agent Tick when the source config is missing", () => {
    const config = configWithApprovalBroker({
      sources: {},
      routes: { permissionGate: { sources: ["agent-tick"] } },
    });

    const route = buildApprovalRouteSources(
      config,
      "permissionGate",
      localSource,
    );

    expect(route.sources).toEqual([]);
    expect(route.sourceConfigs).toEqual({});
  });
});
