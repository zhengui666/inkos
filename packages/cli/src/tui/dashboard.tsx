import { randomUUID } from "node:crypto";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { RuntimeClient } from "../runtime.js";
import { conversationMessages, taskTree } from "../runtime-view.js";
import { watchRuntimeEvents } from "../events.js";
import { applyRuntimeEvent, emptyRuntimeState, eventRequiresRefresh, loadRuntimeState, type RuntimeTuiState } from "./runtime-state.js";
import { submitTuiInput, TUI_COMMANDS, type BusyPolicy } from "./runtime-input.js";
import { applySlashSuggestion, getSlashSuggestions } from "./slash-autocomplete.js";
import { buildInputHistory, moveHistoryCursor, type InputHistoryState } from "./input-history.js";
import type { TuiLocale } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { WARM_ACCENT, WARM_MUTED, WARM_BORDER, WARM_REPLY, ROLE_USER, STATUS_ERROR } from "./theme.js";

export type InkTuiAppProps = {
  client: RuntimeClient; projectName: string; locale: TuiLocale; initialConversationId?: number; signal: AbortSignal;
};

export function InkTuiApp({ client, projectName, locale, initialConversationId, signal }: InkTuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<RuntimeTuiState>(emptyRuntimeState);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [whenBusy, setWhenBusy] = useState<BusyPolicy>("followUp");
  const [scroll, setScroll] = useState(0);
  const pending = useRef(false);
  const activeClient = useRef(client);
  const refresh = useRef<() => void>(() => {});
  const history = useRef<InputHistoryState>({ cursor: null, draft: "" });
  const english = locale === "en";

  useEffect(() => {
    const watch = new AbortController();
    const detach = () => watch.abort();
    if (signal.aborted) detach();
    signal.addEventListener("abort", detach, { once: true });
    let loading = false;
    let requested = false;
    const reload = async () => {
      requested = true;
      if (loading || watch.signal.aborted) return;
      loading = true;
      try {
        while (requested && !watch.signal.aborted) {
          requested = false;
          const next = await loadRuntimeState(activeClient.current, conversationId);
          if (!watch.signal.aborted) setState(current => ({ ...next, agentEvents: current.agentEvents }));
        }
      } catch (failure) { if (!watch.signal.aborted) setError(String(failure)); }
      finally { loading = false; }
    };
    refresh.current = () => { void reload(); };
    setState(current => ({ ...current, conversation: undefined, agentEvents: [] }));
    setConnected(false);
    void reload();
    void watchRuntimeEvents(activeClient.current, event => {
      if (watch.signal.aborted) return;
      setState(current => applyRuntimeEvent(current, event));
      if (eventRequiresRefresh(event)) void reload();
    }, { conversationId, signal: watch.signal, onConnection: setConnected,
      onClient: next => { activeClient.current = next; },
    }).catch(failure => {
      if (!watch.signal.aborted) setError(String(failure));
    });
    return () => { detach(); signal.removeEventListener("abort", detach); };
  }, [client, conversationId, signal]);

  const messages = conversationMessages(state.conversation);
  const suggestions = getSlashSuggestions(input, TUI_COMMANDS);
  useInput((value, key) => {
    if (key.ctrl && (value === "c" || value === "d")) { exit(); return; }
    if (key.pageUp) setScroll(current => current + 4);
    if (key.pageDown) setScroll(current => Math.max(0, current - 4));
    if (key.tab && suggestions.length) { setInput(applySlashSuggestion(input, suggestions, 0)); return; }
    if (!submitting && (key.upArrow || key.downArrow)) {
      const next = moveHistoryCursor(buildInputHistory(messages), history.current, input, key.upArrow ? "up" : "down");
      history.current = next.state;
      setInput(next.value);
    }
  });

  const submit = async (value: string) => {
    value = value.trim();
    if (!value || pending.current) return;
    if (/^\/(quit|exit)$/.test(value)) { exit(); return; }
    const busy = /^\/busy\s+(steer|followUp|reject)$/.exec(value);
    if (busy) { setWhenBusy(busy[1] as BusyPolicy); setInput(""); return; }
    pending.current = true;
    setSubmitting(true);
    setError("");
    setInput("");
    setScroll(0);
    history.current = { cursor: null, draft: "" };
    const requestId = randomUUID();
    try {
      const result = await submitTuiInput(activeClient.current, value, { conversationId, requestId, whenBusy });
      if (result.conversationId !== undefined) setConversationId(result.conversationId);
      if (result.output !== undefined) setNotice(typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2));
      else if (result.submission) setNotice(`Submission ${result.submission.id} · ${result.submission.status} · request ${requestId}`);
      else setNotice(`Conversation ${result.conversationId}`);
      refresh.current();
    } catch (failure) {
      setError(`${String(failure)} · request ${requestId}. Not automatically resubmitted.`);
      refresh.current();
    } finally { pending.current = false; setSubmitting(false); }
  };

  const end = Math.max(0, messages.length - scroll);
  const visible = messages.slice(Math.max(0, end - 10), end);
  const graphRows = taskTree(state.graph);
  const inbox = state.conversation?.inbox ?? state.conversation?.docs?.["pi.inbox"];
  const usage = state.conversation?.usage ?? state.status?.usage;
  const recent = state.agentEvents.at(-1);
  return <Box flexDirection="column" paddingX={1}>
    <Text color={WARM_ACCENT} bold>InkOS · {projectName} · PID {state.status?.pid ?? client.endpoint.pid}</Text>
    <Text color={WARM_MUTED}>{connected ? (english ? "Watching" : "已连接") : (english ? "Reconnecting (tasks keep running)" : "重连中（任务继续运行）")} · {JSON.stringify(state.status?.model ?? null)}</Text>
    <Text color={WARM_MUTED}>{english ? "Conversation" : "会话"}: {conversationId ?? "new"} · {state.conversations.map(item => item.id).join(", ") || "none"} · busy={whenBusy}</Text>
    <Box borderStyle="single" borderColor={WARM_BORDER} flexDirection="column" marginTop={1}>
      <Text color={WARM_ACCENT}>{english ? "Task tree" : "任务树"}</Text>
      {graphRows.length ? graphRows.slice(-10).map((row, index) => <Text key={index} color={WARM_MUTED}>{row}</Text>) : <Text color={WARM_MUTED}>{english ? "No live tasks" : "暂无运行任务"}</Text>}
      <Text color={WARM_MUTED}>{english ? "Works" : "作品"}: {state.status?.works.map(work => `${work.id} (${work.title})`).join(" · ") || "none"}</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {visible.map(message => <Box key={message.key} flexDirection="column" marginBottom={1}>
        <Text color={message.role === "user" ? ROLE_USER : WARM_ACCENT}>{message.role}</Text>
        <Text color={WARM_REPLY}>{renderMarkdown(message.content)}</Text>
      </Box>)}
      {!messages.length && <Text color={WARM_MUTED}>{english ? "Chat here or /help. /note saves without calling a model." : "输入聊天或 /help。/note 可保存笔记，不调用模型。"}</Text>}
      {notice && <Text color={WARM_MUTED}>{notice}</Text>}
      {error && <Text color={STATUS_ERROR}>{error}</Text>}
    </Box>
    <Text color={WARM_MUTED}>inbox={JSON.stringify(inbox ?? null)} · usage={JSON.stringify(usage ?? null)}</Text>
    {recent && <Text color={WARM_MUTED}>event: {recent.type ?? JSON.stringify(recent)}</Text>}
    <Box borderStyle="round" borderColor={WARM_ACCENT} paddingX={1} marginTop={1}>
      <Text color={WARM_ACCENT}>› </Text>
      <TextInput value={input} onChange={setInput} onSubmit={value => { void submit(value); }}
        focus={!submitting} placeholder={submitting ? (english ? "Submitting…" : "提交中…") : (english ? "Message or /command" : "聊天或 /命令")} />
    </Box>
    {suggestions.length > 0 && <Text color={WARM_MUTED}>{suggestions.slice(0, 4).join(" · ")}</Text>}
    <Text color={WARM_MUTED}>{english ? "Enter send · Tab complete · PgUp/PgDn scroll · Ctrl-C leave (runtime stays running)" : "回车发送 · Tab 补全 · PgUp/PgDn 滚动 · Ctrl-C 退出（runtime 保持运行）"}</Text>
  </Box>;
}
