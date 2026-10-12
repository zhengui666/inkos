import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Button } from './ui/button';
import { useWorkspace } from '../runtime/hooks';
import { label } from '../runtime/projection';
import { useI18n } from '../i18n';

export function Action({ children, actionKey, onClick, disabled, primary, danger, type = 'button' }: {
  children: ReactNode; actionKey?: string; onClick?: () => void; disabled?: boolean;
  primary?: boolean; danger?: boolean; type?: 'button' | 'submit';
}) {
  const { t } = useI18n();
  const { busy } = useWorkspace();
  const working = actionKey ? busy.has(actionKey) : false;
  return <Button type={type} className="studio-button" variant={primary ? 'default' : danger ? 'destructive' : 'outline'} disabled={disabled || working} onClick={onClick} aria-busy={working}>{working ? t('Working…') : children}</Button>;
}
export function Field({ label: text, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  return <div className="field"><label htmlFor={id}>{t(text)}</label>{Children.map(children, child => {
    if (!isValidElement(child) || !['input', 'textarea', 'select'].includes(String(child.type))) return child;
    return cloneElement(child as ReactElement<any>, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) });
  })}{hint && <small id={`${id}-hint`}>{t(hint)}</small>}</div>;
}
export function Badge({ value }: { value: string }) {
  const { t } = useI18n();
  const tone = ['completed', 'published', 'configured', 'connected', 'done'].includes(value) ? 'success'
    : ['failed', 'faulted', 'aborted', 'cancelled'].includes(value) ? 'error'
    : ['waiting', 'paused', 'needs-observation', 'unknown', 'waiting-user', 'reviewing', 'unconfigured'].includes(value) ? 'attention' : '';
  return <span className={`badge ${tone}`}>{t(value).replaceAll('-', ' ')}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="empty"><h3>{t(title)}</h3><p>{typeof children === 'string' ? t(children) : children}</p></div>;
}
export function QueryState({ resource }: { resource: { loading: boolean; error: string; data: unknown; refresh: () => void } }) {
  const { t } = useI18n();
  if (resource.error) return <div className="notice error" role="alert"><span>{t(resource.error)}</span><Action onClick={resource.refresh}>{t('Retry read')}</Action></div>;
  if (resource.loading && !resource.data) return <p className="muted" role="status">{t('Loading from runtime…')}</p>;
  return null;
}
export function DataDetails({ title = 'Native details', data, open }: { title?: string; data: unknown; open?: boolean }) {
  const { t } = useI18n();
  return <details className="data-details" open={open}><summary>{t(title)}</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
}
export function Descriptions({ items }: { items: unknown[] | Record<string, unknown> | undefined }) {
  const { t } = useI18n();
  const values = Array.isArray(items) ? items : Object.values(items ?? {});
  if (!values.length) return <p className="muted small">{t('None registered')}</p>;
  return <ul className="descriptions">{values.map((item, i) => { const descriptor = typeof item === 'object' && item !== null ? item as Record<string, any> : null; return <li key={i}><strong>{t(label(item))}</strong>{(descriptor?.description ?? descriptor?.instructions) && <p>{descriptor?.description ?? descriptor?.instructions}</p>}{descriptor && descriptor.capabilities?.length > 0 && <p>{t('Capabilities:')} {descriptor.capabilities.map((value: string) => t(value)).join(', ')}</p>}</li>; })}</ul>;
}
