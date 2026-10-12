import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { rpc } from './api';
import type { RuntimeStatus } from './types';

export function useRuntime(conversationId?: number) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState('');
  const [agentEvents, setAgentEvents] = useState<unknown>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [version, setVersion] = useState(0);
  const invalidate = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    rpc<RuntimeStatus>('status', {}, abort.signal).then(value => { setStatus(value); setError(''); }).catch(e => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => abort.abort();
  }, [version]);
  useEffect(() => {
    setAgentEvents(null);
    const events = new EventSource(`/api/v1/events${conversationId === undefined ? '' : `?conversationId=${conversationId}`}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    events.onopen = () => { setConnection('connected'); invalidate(); };
    events.onerror = () => setConnection('reconnecting');
    events.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.type === 'snapshot') { setStatus(value.data); setError(''); }
      if (value.type === 'agentEvents') setAgentEvents(value.data);
      if (['snapshot', 'changed', 'taskGraph', 'agentEvents'].includes(value.type)) {
        if (!timer) timer = setTimeout(() => { timer = undefined; invalidate(); }, 80);
      }
    };
    events.addEventListener('runtime-error', event => { setError(JSON.parse((event as MessageEvent).data).error); setConnection('reconnecting'); });
    return () => { clearTimeout(timer); events.close(); };
  }, [invalidate, conversationId]);
  return { status, error, connection, version, invalidate, agentEvents };
}
export type WorkspaceContext = ReturnType<typeof useRuntime> & {
  run: <T>(key: string, action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  busy: Set<string>;
};
export const Workspace = createContext<WorkspaceContext>(null!);
export const useWorkspace = () => useContext(Workspace);

/** Only current read projections live in React. No submissions are replayed here. */
export function useResource<T>(method: string, params: Record<string, unknown> = {}, enabled = true) {
  const { version } = useWorkspace();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const identity = useRef('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const serialized = JSON.stringify(params);
  useEffect(() => {
    const nextIdentity = `${method}:${serialized}`;
    if (identity.current !== nextIdentity) { setData(null); setError(''); identity.current = nextIdentity; }
    if (!enabled) { setLoading(false); setData(null); return; }
    const controller = new AbortController();
    setLoading(true);
    rpc<T>(method, JSON.parse(serialized), controller.signal).then(value => {
      if (!controller.signal.aborted) { setData(value); setError(''); setLoading(false); }
    }).catch(e => {
      if (!controller.signal.aborted) { setError(e.message); setLoading(false); }
    });
    return () => controller.abort();
  }, [method, serialized, version, revision, enabled]);
  return { data, error, loading, refresh: () => setRevision(v => v + 1) };
}
export function useActions(invalidate: () => void) {
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState(new Set<string>());
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const run = async <T,>(key: string, action: () => Promise<T>, success = 'Saved') => {
    if (pending.current.has(key)) return;
    pending.current.add(key); setBusy(new Set(pending.current)); setNotice(null);
    try {
      const result = await action(); invalidate(); setNotice({ text: success, error: false }); return result;
    } catch (e) {
      setNotice({ text: `${e instanceof Error ? e.message : String(e)} — Read the latest state before retrying.`, error: true });
    } finally {
      pending.current.delete(key); setBusy(new Set(pending.current));
    }
  };
  return { run, busy, notice, dismiss: () => setNotice(null) };
}
