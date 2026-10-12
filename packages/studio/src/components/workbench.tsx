import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Button } from './ui/button';
import { useWorkspace } from '../runtime/hooks';
import { label } from '../runtime/projection';

export function Action({ children, actionKey, onClick, disabled, primary, danger, type = 'button' }: {
  children: ReactNode; actionKey?: string; onClick?: () => void; disabled?: boolean;
  primary?: boolean; danger?: boolean; type?: 'button' | 'submit';
}) {
  const { busy } = useWorkspace();
  const working = actionKey ? busy.has(actionKey) : false;
  return <Button type={type} className="studio-button" variant={primary ? 'default' : danger ? 'destructive' : 'outline'} disabled={disabled || working} onClick={onClick} aria-busy={working}>{working ? 'Working…' : children}</Button>;
}
export function Field({ label: text, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{text}</label>{Children.map(children, child => {
    if (!isValidElement(child) || !['input', 'textarea', 'select'].includes(String(child.type))) return child;
    return cloneElement(child as ReactElement<any>, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) });
  })}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function Badge({ value }: { value: string }) {
  const tone = ['completed', 'published', 'configured', 'connected', 'done'].includes(value) ? 'success'
    : ['failed', 'aborted', 'cancelled'].includes(value) ? 'error'
    : ['waiting', 'paused', 'needs-observation', 'unknown', 'waiting-user', 'reviewing', 'unconfigured'].includes(value) ? 'attention' : '';
  return <span className={`badge ${tone}`}>{value.replaceAll('-', ' ')}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p>{children}</p></div>;
}
export function QueryState({ resource }: { resource: { loading: boolean; error: string; data: unknown; refresh: () => void } }) {
  if (resource.error) return <div className="notice error" role="alert"><span>{resource.error}</span><Action onClick={resource.refresh}>Retry read</Action></div>;
  if (resource.loading && !resource.data) return <p className="muted" role="status">Loading from runtime…</p>;
  return null;
}
export function DataDetails({ title = 'Native details', data, open }: { title?: string; data: unknown; open?: boolean }) {
  return <details className="data-details" open={open}><summary>{title}</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
}
export function Descriptions({ items }: { items: unknown[] | Record<string, unknown> | undefined }) {
  const values = Array.isArray(items) ? items : Object.values(items ?? {});
  if (!values.length) return <p className="muted small">None registered</p>;
  return <ul className="descriptions">{values.map((item, i) => { const descriptor = typeof item === 'object' && item !== null ? item as Record<string, any> : null; return <li key={i}><strong>{label(item)}</strong>{(descriptor?.description ?? descriptor?.instructions) && <p>{descriptor?.description ?? descriptor?.instructions}</p>}{descriptor && descriptor.capabilities?.length > 0 && <p>Capabilities: {descriptor.capabilities.join(', ')}</p>}</li>; })}</ul>;
}
