import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createAgentConfigurationController, createAgentConfigurationTransport, type AgentConfigurationTransport } from "./agent-configuration-controller";

const defaultTransport = createAgentConfigurationTransport();

export function useAgentConfiguration(transport?: AgentConfigurationTransport) {
  const controller = useMemo(() => createAgentConfigurationController(transport ?? defaultTransport), [transport]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.refresh(); return () => controller.cancel(); }, [controller]);
  const login = snapshot.state?.connection?.login;
  useEffect(() => {
    if (login?.status !== "pending" || snapshot.authBlocking) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await controller.refreshState(); if (active && controller.getSnapshot().state?.connection?.login?.status === "pending") timer = setTimeout(() => { void poll(); }, 2000); };
    timer = setTimeout(() => { void poll(); }, 2000);
    // Navigation detaches browser work. Returning reads the same service-owned attempt, never restarts login.
    return () => { active = false; clearTimeout(timer); };
  }, [controller, snapshot.target.harness, snapshot.target.contextKey, login?.loginId, login?.status, snapshot.authBlocking]);
  const piAttempt = snapshot.piLoginAttempt;
  useEffect(() => {
    if (snapshot.target.harness !== "pi" || !piAttempt || ["saved", "closed", "failed", "unknown"].includes(piAttempt.status) || snapshot.piAuthBusy) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await controller.refreshPiLogin();
      const current = controller.getSnapshot();
      if (active && current.target.harness === "pi" && current.piLoginAttempt?.handle === piAttempt.handle
        && !["saved", "closed", "failed", "unknown"].includes(current.piLoginAttempt.status) && !current.piAuthBusy)
        timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    // Cleanup detaches browser reads; it never closes or replays the service-owned login.
    return () => { active = false; clearTimeout(timer); };
  }, [controller, snapshot.target.harness, snapshot.target.contextKey, piAttempt?.handle, piAttempt?.status, piAttempt?.prompt?.promptId, snapshot.piAuthBusy]);
  return { controller, snapshot };
}
