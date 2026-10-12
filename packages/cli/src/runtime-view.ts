export type Work = { id: string; title: string; profile: string; locale?: string; plan: Record<string, any>; [key: string]: any };
export type NativeTask = {
  id: number; kind: string; owner?: number; conversationId?: number; abortRequested?: boolean;
  state: { status: string; outcome?: { status: string; [key: string]: any }; [key: string]: any };
  [key: string]: any;
};
export type TaskGraph = { tasks: Record<string, any> };
export type RuntimeStatus = {
  pid: number; rootDir: string; works: Work[]; targets: any[]; distributions: any[];
  tasks: NativeTask[]; taskGraph: TaskGraph; usage: any; plugins: any; model: any;
};
export type RuntimeEvent = { type: string; data?: any };
export type ConversationRecord = { id: number; parent?: any; owner?: any };
export type ConversationView = {
  conversation?: ConversationRecord; entries: any[]; inbox?: any; usage?: any; agent?: any;
  docs?: Record<string, any>; [key: string]: any;
};
export type SubmissionRecord = { id: number; conversationId: number; type: string; status: string; requestId?: string; [key: string]: any };

/** Completion is a native outcome, never a top-level task.status. */
export function taskOutcome(task: NativeTask): string | undefined { return task.state.outcome?.status; }

export function recordTaskExit(task: NativeTask): void {
  const outcome = taskOutcome(task);
  if (outcome && outcome !== "completed") process.exitCode = 1;
}

export function taskTree(graph: TaskGraph): string[] {
  const nodes = Object.values(graph.tasks);
  const rows: string[] = [];
  const visited = new Set<number>();
  const visit = (task: any, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const outcome = task.state.outcome;
    const state = typeof outcome === "string" ? `${task.state.status} (${outcome})` : outcome?.status ?? task.state.status;
    rows.push(`${"  ".repeat(depth)}${task.id} ${task.kind} · ${state}${task.abortRequested ? " · abort requested" : ""}`);
    for (const child of nodes.filter(node => node.owner === task.id)) visit(child, depth + 1);
  };
  for (const node of nodes.filter(node => node.owner === undefined || !graph.tasks[String(node.owner)])) visit(node, 0);
  for (const node of nodes) visit(node, 0);
  return rows;
}

/** Read native EntryRecord.model messages without storing a second transcript. */
export function conversationMessages(view?: ConversationView): Array<{ key: string; role: string; content: string }> {
  return (view?.entries ?? []).flatMap((entry, index) => {
    if (entry.kind === "inkos.note") return [{ key: String(entry.id ?? index), role: "note", content: String(entry.data?.text ?? "") }];
    const messages = entry.model ?? (entry.role ? [entry] : []);
    return messages.map((message: any, part: number) => ({
      key: `${entry.id ?? index}:${part}`,
      role: message.role ?? "message",
      content: typeof message.content === "string" ? message.content : (message.content ?? []).map((block: any) => {
        if (block.type === "text") return block.text;
        if (block.type === "toolCall") return `[${block.name}] ${JSON.stringify(block.arguments)}`;
        return "";
      }).filter(Boolean).join("\n"),
    }));
  });
}
