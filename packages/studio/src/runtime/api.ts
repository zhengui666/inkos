export async function rpc<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/${method.split('.').join('/')}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal,
  });
  const result = await response.json().catch(() => { throw new Error('Studio service is not reachable. Start Studio for this project, then retry.'); });
  if (!response.ok) throw new Error(result.error ?? `Studio API ${response.status}`);
  return result as T;
}
export function requestId(): string { return crypto.randomUUID(); }
