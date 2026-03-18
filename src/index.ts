import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardrailsSettings } from "./commands/settings-command";
import { configLoader } from "./config";
import { setupGuardrailsHooks } from "./hooks";
import { pendingWarnings } from "./utils/warnings";

const extensionDir = resolve(fileURLToPath(import.meta.url), "../..");
const defaultsDocPath = resolve(extensionDir, "docs/defaults.md");
const examplesDocPath = resolve(extensionDir, "docs/examples.md");

/**
 * Guardrails Extension
 *
 * Security hooks to prevent potentially dangerous operations:
 * - policies: File access policies with per-rule protection levels
 * - permission-gate: Prompts for confirmation on dangerous commands
 *
 * Toolchain features (preventBrew, preventPython, enforcePackageManager,
 * packageManager) have been moved to @aliou/pi-toolchain. Old configs
 * containing these fields are auto-migrated on first load.
 *
 * Configuration:
 * - Global: ~/.pi/agent/extensions/guardrails.json
 * - Project: .pi/extensions/guardrails.json
 * - Command: /guardrails:settings
 */
export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const config = configLoader.getConfig();

  if (!config.enabled) return;

  setupGuardrailsHooks(pi, config);
  registerGuardrailsSettings(pi);

  pi.on("before_agent_start", (_event) => {
    const guidance = [
      "",
      "<guardrails-guidance>",
      "The guardrails extension is installed. Default policy rules and permission gate patterns are documented at:",
      `  - Defaults: ${defaultsDocPath}`,
      `  - Examples: ${examplesDocPath}`,
      "When the user tells you to not read a file or not run a command, suggest adding a guardrail rule to enforce this permanently.",
      "Consult the defaults and examples docs above when adding new guardrails — they contain ready-to-use presets.",
      "Use /guardrails:settings to configure or /guardrails:add-policy to add a new policy rule.",
      "</guardrails-guidance>",
    ].join("\n");

    return {
      systemPrompt: _event.systemPrompt + guidance,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    for (const warning of pendingWarnings.splice(0)) {
      ctx.ui.notify(warning, "warning");
    }
  });
}
