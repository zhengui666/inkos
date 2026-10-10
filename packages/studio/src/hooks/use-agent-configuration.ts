import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createAgentConfigurationController, createAgentConfigurationTransport, type AgentConfigurationTransport } from "./agent-configuration-controller";

export function useAgentConfiguration(transport?: AgentConfigurationTransport) {
  const controller = useMemo(() => createAgentConfigurationController(transport ?? createAgentConfigurationTransport()), [transport]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.refresh(); return () => controller.cancel(); }, [controller]);
  return { controller, snapshot };
}
