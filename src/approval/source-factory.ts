import type {
  ApprovalBrokerRouteConfig,
  ApprovalBrokerSourceConfig,
  ResolvedConfig,
} from "../config";
import { createAgentTickApprovalSource } from "./agent-tick-source";
import type { ApprovalSource, ApprovalStrategyInput } from "./types";

export type RouteSources = {
  sources: ApprovalSource[];
  sourceConfigs: Record<string, unknown>;
  strategy?: ApprovalStrategyInput;
  route: ApprovalBrokerRouteConfig;
};

function isEnabled(config: ApprovalBrokerSourceConfig | undefined): boolean {
  return config?.enabled !== false;
}

export function isRemoteApprovalSource(
  sourceId: string,
  config: ResolvedConfig,
): boolean {
  const source = config.approvalBroker.sources[sourceId];
  if (!source) return false;
  if (source.local === false) return true;
  return source.type === "agent-tick-cli";
}

export function routeHasEnabledRemoteSource(
  config: ResolvedConfig,
  routeName: "permissionGate" | "pathAccess",
): boolean {
  if (!config.approvalBroker.enabled) return false;
  const route = config.approvalBroker.routes[routeName] ?? {};
  for (const sourceId of route.sources ?? []) {
    const source = config.approvalBroker.sources[sourceId];
    if (isEnabled(source) && isRemoteApprovalSource(sourceId, config))
      return true;
  }
  return false;
}

export function buildApprovalRouteSources(
  config: ResolvedConfig,
  routeName: "permissionGate" | "pathAccess",
  localSource: ApprovalSource,
): RouteSources {
  const route = config.approvalBroker.routes[routeName] ?? {};
  const sourceIds = route.sources ?? ["local"];
  const sources: ApprovalSource[] = [];
  const sourceConfigs: Record<string, unknown> = {};
  const seenSourceIds = new Set<string>();
  const addSource = (source: ApprovalSource, sourceConfig: unknown) => {
    if (seenSourceIds.has(source.id)) return;
    seenSourceIds.add(source.id);
    sources.push(source);
    sourceConfigs[source.id] = sourceConfig;
  };

  for (const sourceId of sourceIds) {
    const sourceConfig = config.approvalBroker.sources[sourceId];
    if (sourceId === "local") {
      if (sourceConfig?.enabled === false) continue;
      addSource(localSource, sourceConfig);
      continue;
    }
    if (!sourceConfig || !isEnabled(sourceConfig)) continue;
    if (sourceConfig.type === "local-ui") {
      addSource(localSource, sourceConfig);
      continue;
    }
    if (sourceId === "agent-tick" || sourceConfig.type === "agent-tick-cli") {
      addSource(
        createAgentTickApprovalSource(
          sourceConfig as Parameters<typeof createAgentTickApprovalSource>[0],
        ),
        sourceConfig,
      );
    }
  }

  return {
    sources,
    sourceConfigs,
    strategy: route.strategy,
    route,
  };
}
