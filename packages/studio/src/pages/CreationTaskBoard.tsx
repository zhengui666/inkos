import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, BookOpen, CheckCircle2, AlertCircle, Settings2 } from 'lucide-react';
import { postApi, putApi, useApi } from '../hooks/use-api';
import { tr } from '../lib/app-language';
import type { CreationPlan, CreationTask, RemoteWorkView } from '@actalk/inkos-core';

type Task = CreationTask & {
  canResume: boolean; status: string; writtenChapters: number; reviewedChapters: number; publishedChapters: number;
  currentChapter: number; stage: string; remoteWork?: RemoteWorkView | null;
  receipts: Array<{ chapter: number; revisionId?: string; publication?: { status: string; remoteChapterId?: string; evidence?: string } }>;
};
type Board = { tasks: Task[]; defaults: { language: string; platform: string | null };
  runtime: { running: boolean; phase: string; error?: string }; publication: {
    configured: boolean; configurationStatus?: 'path_provided' | 'missing';
    remoteBookCreation: boolean; emptyBookFirstChapter?: boolean; requiresExistingRemoteBook?: boolean;
  } };
const stages: Record<string, [string, string]> = {
  queued: ['等待启动', 'Queued'], planning: ['规划故事', 'Planning'], writing: ['正在写作', 'Writing'],
  reviewing: ['独立审稿', 'Reviewing'], revising: ['修改缺陷', 'Revising'], publishing: ['发布与回读', 'Publishing / readback'],
  blocked: ['需要处理', 'Needs attention'], paused: ['暂停已请求', 'Pause requested'], completed: ['已完结并发布', 'Completed and published'],
};
const label = (stage: string) => { const pair = stages[stage]; return pair ? tr(...pair) : stage; };
const draftKey = 'inkos.creation.pending.v1';
function savedDraft(): { id: string; kind: 'long' | 'short'; brief: string } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    return value && typeof value.id === 'string' && ['long', 'short'].includes(value.kind) && typeof value.brief === 'string' ? value : undefined;
  } catch { return undefined; }
}

export function CreationTaskBoard({ onOpenWork }: { onOpenWork(id: string): void }) {
  const { data, loading, error, refetch } = useApi<Board>('/creation-tasks');
  const [initial] = useState(savedDraft);
  const [kind, setKind] = useState<'long' | 'short'>(initial?.kind ?? 'long');
  const [brief, setBrief] = useState(initial?.brief ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [starting, setStarting] = useState(false);
  const startAdmission = useRef(false);
  const request = useRef(initial);
  const admission = useRef(false);
  useEffect(() => { const timer = setInterval(() => { void refetch(); }, 5000); return () => clearInterval(timer); }, [refetch]);
  const submit = async () => {
    if (admission.current || brief.trim().length < 5) return;
    admission.current = true; setBusy(true); setFailure(undefined);
    if (!request.current || request.current.kind !== kind || request.current.brief !== brief.trim()) {
      request.current = { id: crypto.randomUUID(), kind, brief: brief.trim() };
    }
    try {
      // Retain the same identity through a lost response and browser refresh.
      localStorage.setItem(draftKey, JSON.stringify(request.current));
      const result = await postApi<{ runtimeError?: string }>('/creation-tasks', request.current);
      localStorage.removeItem(draftKey); request.current = undefined; setBrief('');
      if (result.runtimeError) setFailure(result.runtimeError);
      await refetch();
    } catch (e) { setFailure(String(e)); }
    finally { admission.current = false; setBusy(false); }
  };
  const retryRunner = async () => {
    if (startAdmission.current) return;
    startAdmission.current = true; setStarting(true); setFailure(undefined);
    try {
      const result = await postApi<{ runtimeError?: string }>('/creation-tasks/runner/start');
      if (result.runtimeError) setFailure(result.runtimeError);
      await refetch();
    } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); }
    finally { startAdmission.current = false; setStarting(false); }
  };
  return <section className="space-y-6 mb-14" aria-label={tr('创作任务看板', 'Creation task board')}>
    <div>
      <div className="text-xs font-semibold tracking-widest text-primary mb-2">INKOS · {tr('自动创作', 'AUTONOMOUS CREATION')}</div>
      <h1 className="font-serif text-3xl md:text-4xl">{tr('一个想法，写到完结', 'From an idea to a finished story')}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{tr('选长篇或短篇，再写两三句话。系统规划、写作、审稿和修订；发布需满足下方平台能力与配置条件，只有核验后的回执才计为已发布。', 'Choose long or short fiction and describe it in a few sentences. InkOS plans, writes, reviews and revises. Publication depends on the platform support and setup below; only verified receipts count as published.')}</p>
    </div>
    {data && <div role="note" aria-label={tr('发布前提', 'Publication prerequisites')} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm space-y-2">
      <p className="font-medium">{tr('发布前提', 'Publication prerequisites')}</p>
      <p>{data.publication.configurationStatus === 'path_provided' || data.publication.configured
        ? tr('已提供发布配置路径，尚不代表账号、绑定或远端发布已验证。', 'A publishing configuration path is present; the account, binding and remote publication are not yet verified.')
        : tr('尚未提供发布配置。请先配置发布目标、账号和远端作品绑定。', 'No publishing configuration is present. Set up the destination, account and remote-book binding first.')}</p>
      {(!data.publication.remoteBookCreation || data.publication.emptyBookFirstChapter === false) && <p>{tr('当前内置发布仅支持已绑定的 MegaNovel 远端作品；不支持自动新建远端书籍，也不支持向空书提交首章。新作品无法仅凭这两项输入完成自动发布，这些缺失能力仍需实现与验证，不能仅靠登录或配置解决。', 'Built-in publishing currently supports bound existing MegaNovel books. Automatic remote-book creation and first-chapter submission to an empty book are unsupported. These two fields alone cannot publish a new work; the missing capabilities still need implementation and verification, beyond sign-in or configuration.')}</p>}
      <p>{tr('自动操作还需平台明确授权；登录和配置不代表已获授权。本看板未核验平台授权、内容资格或真实发布结果，也不保证签约或收益。', 'Automated access also requires platform authorization. Sign-in and configuration do not establish that permission. This board has not verified platform authorization, content eligibility or real publication, and does not guarantee a contract or income.')}</p>
      <p className="text-xs text-muted-foreground">{tr('配置未就绪时，任务会显示阻塞原因；保留的稿件、待提交或审核中均不等于已发布。登录、实名/税务及合同仍需必要设置或确认。', 'Missing setup is shown as a task blocker. Retained drafts, pending submissions and platform review do not count as published. Sign-in, identity/tax and contract steps still require the necessary setup or confirmation.')}</p>
    </div>}
    {!data && <p role="status" className="text-sm text-muted-foreground">{loading ? tr('正在读取任务与发布能力…', 'Loading tasks and publication support…') : tr('任务与发布能力尚未读取成功，请重试。', 'Tasks and publication support could not be loaded. Please retry.')}</p>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-sm">
      <fieldset disabled={busy} className="flex gap-3">
        <legend className="sr-only">{tr('小说类别', 'Story length')}</legend>
        {(['long', 'short'] as const).map(value => <label key={value} className={`flex-1 rounded-xl border px-4 py-3 cursor-pointer ${kind === value ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <input type="radio" name="creation-kind" value={value} checked={kind === value} onChange={() => setKind(value)} className="mr-2" />
          <span className="font-medium">{value === 'long' ? tr('长篇小说', 'Long novel') : tr('短篇小说', 'Short story')}</span>
          <span className="block mt-1 text-xs text-muted-foreground">{value === 'long' ? tr('有明确终点的长线故事', 'A sustained story with a finite ending') : tr('完整起承转合，一篇收束', 'A complete, self-contained story')}</span>
        </label>)}
      </fieldset>
      <label className="block text-sm font-medium" htmlFor="creation-brief">{tr('内容大概', 'Your story idea')}</label>
      <textarea id="creation-brief" required minLength={5} maxLength={4000} rows={3} value={brief} disabled={busy} onChange={e => setBrief(e.target.value)}
        placeholder={tr('例如：一名能看见失物记忆的修表师，意外发现亡父留下的表正在倒计时。每找回一段记忆，他就会失去自己的一段过去。', 'A watchmaker can see the memories of lost objects. His late father’s watch starts counting down, and each recovered memory costs one of his own.')}
        className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm resize-y focus:outline-primary" />
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-muted-foreground">{tr('语言和篇幅由故事规划推导；规划启动后仍可暂停调整后续篇幅和终点。', 'Planning infers language and length. After planning starts, pause to adjust future length and the ending.')}</p>
        <button disabled={busy || brief.trim().length < 5} className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-3 rounded-xl text-sm font-semibold disabled:opacity-50"><Plus size={16} />{busy ? tr('正在保存…', 'Saving…') : tr('开始自动创作', 'Start creating')}</button>
      </div>
    </form>
    {(error || failure) && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm break-words">{failure ?? error}</p>}
    {error && <button type="button" disabled={loading} onClick={() => void refetch()} className="text-sm underline disabled:opacity-50">{tr('重新读取任务', 'Retry task status')}</button>}
    {data?.runtime.error && <div role="status" className="text-sm rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">{tr('任务已保存，执行器需要恢复：', 'Tasks are saved. The runner needs attention: ')}{data.runtime.error}<button disabled={starting} className="ml-3 underline disabled:opacity-50" onClick={() => void retryRunner()}>{starting ? tr('正在重试…', 'Retrying…') : tr('重试启动', 'Retry runner')}</button></div>}
    <div className="flex items-center justify-between"><h2 className="font-semibold">{tr('创作任务', 'Creation tasks')} <span className="text-muted-foreground">{data?.tasks.length ?? 0}</span></h2>
      <span className="text-xs text-muted-foreground">{data ? data.runtime.running ? tr('自动运行中', 'Runner active') : tr('进度持久保存', 'Progress saved durably') : tr('状态待确认', 'Status unconfirmed')}</span></div>
    <div className="grid gap-4">{data?.tasks.map(task => <TaskCard key={task.id} task={task} refresh={refetch} onOpenWork={onOpenWork} />)}
      {data?.tasks.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{tr('从上面的两项输入开始。已有作品不会被自动启动或改写。', 'Start with the two fields above. Existing works are not automatically started or rewritten.')}</p>}
    </div>
  </section>;
}

function TaskCard({ task, refresh, onOpenWork }: { task: Task; refresh(): Promise<void>; onOpenWork(id: string): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<CreationPlan>(task.plan);
  const planVersion = useRef(task.version);
  const admission = useRef(false);
  const action = async (name: string) => {
    if (admission.current) return;
    admission.current = true; setBusy(true); setError(undefined);
    try { await postApi(`/creation-tasks/${task.id}/${name}`, { version: task.version }); await refresh(); }
    catch (e) { setError(String(e)); await refresh(); }
    finally { admission.current = false; setBusy(false); }
  };
  const save = async () => {
    if (admission.current || task.desiredState !== 'paused' || task.phase === 'completed') return;
    admission.current = true; setBusy(true); setError(undefined);
    try { await putApi(`/creation-tasks/${task.id}/plan`, { version: planVersion.current, plan }); setEditing(false); await refresh(); }
    catch (e) { setError(String(e)); await refresh(); }
    finally { admission.current = false; setBusy(false); }
  };
  const locked = task.foundationAttempts > 0;
  return <article className="rounded-2xl border border-border bg-card p-5 space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0"><div className="flex items-center gap-2 text-xs text-muted-foreground mb-2"><BookOpen size={14} />{task.request.kind === 'short' ? tr('短篇', 'Short') : tr('长篇', 'Long')} · {task.plan.language.toUpperCase()} · {task.plan.platform ?? tr('待选平台', 'Platform needed')}</div>
        <h3 className="font-semibold break-words">{task.plan.title}</h3><p className="mt-1 text-xs text-muted-foreground">{task.planStatus === 'ready' ? tr('已规划 / 题材：', 'Planned / genre: ') : tr('规划前暂定 / 题材：', 'Provisional / genre: ')}{task.plan.genre}</p></div>
      <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${task.status === 'completed' ? 'bg-emerald-500/10 text-emerald-600' : task.status === 'blocked' ? 'bg-amber-500/10 text-amber-600' : 'bg-primary/10 text-primary'}`}>
        {task.status === 'completed' ? <CheckCircle2 size={13} /> : task.status === 'blocked' ? <AlertCircle size={13} /> : null}{label(task.status)}</span>
    </div>
    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{task.request.brief}</p>
    {task.plan.blurb && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{tr('公开作品简介', 'Public book blurb')}</summary><p className="mt-2">{task.plan.blurb}</p></details>}
    {task.planSummary && <p className="text-xs text-muted-foreground">{task.planSummary}</p>}
    {task.endingIntent && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{tr('计划结局（含剧透）', 'Planned resolution (spoilers)')}</summary><p className="mt-2">{task.endingIntent}</p></details>}
    <div className="grid grid-cols-3 gap-3 text-sm"><div>{tr('已写', 'Written')} <b>{task.writtenChapters}/{task.plan.targetChapters}</b></div><div>{tr('已审', 'Reviewed')} <b>{task.reviewedChapters}</b></div><div>{tr('已发布', 'Published')} <b>{task.publishedChapters}</b></div></div>
    <div className="h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, task.publishedChapters / task.plan.targetChapters * 100)}%` }} /></div>
    <p className="text-xs text-muted-foreground">{tr('计划终点：', 'Planned ending: ')}{task.plan.targetChapters}{tr(' 章，每章约 ', ' chapters, approximately ')}{task.plan.chapterWordCount}{tr(' 字。完结后停止，不自动延长。', ' words/characters each. Stops at the ending; no silent extension.')}{task.currentChapter > 0 && ` · ${tr('当前第', 'Current chapter ')}${task.currentChapter} · ${label(task.stage)}`}</p>
    {task.remoteWork && <details className="text-xs rounded-lg border border-border p-3"><summary className="cursor-pointer">{tr('远端建书：', 'Remote book creation: ')}{task.remoteWork.status}</summary>
      <p className="mt-2 break-words">{task.remoteWork.blocker?.message}</p>
      <p className="mt-2">{tr('已提交创建次数：', 'Creation attempts: ')}{task.remoteWork.attempts} · {tr('持久阶段：', 'Retained phase: ')}{task.remoteWork.phase}</p>
      {task.remoteWork.receipt && <p className="mt-2 break-words">{task.remoteWork.receipt.remoteBookId} · {task.remoteWork.receipt.evidence}{task.remoteWork.receipt.verifiedURL && <a className="ml-2 underline" href={task.remoteWork.receipt.verifiedURL} target="_blank" rel="noopener noreferrer">{tr('已核验作品', 'Verified work')}</a>}</p>}
      <p className="mt-2">{tr('建书回执不代表章节已发布；创建结果不确定时只对账。', 'A book-creation receipt is not chapter publication. Uncertain creation is reconciled without another create request.')}</p>
    </details>}
    {task.error && <div role="status" className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3 text-sm break-words"><b>{task.error.code}</b><p className="mt-1 whitespace-pre-wrap">{task.error.message}</p></div>}
    {task.canResume === false && task.phase !== 'completed' && <p className="text-xs text-muted-foreground">{tr('此自动运行已停止。稿件和回执均已保留，请查看作品与错误详情；本按钮不会重置审稿预算或重放不确定的提交。', 'This automatic run has stopped. Drafts and receipts are retained for inspection. Review budgets and uncertain submissions will not be reset.')}</p>}
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    {task.desiredState === 'paused' && <p className="text-xs text-muted-foreground">{tr('停止启动后续步骤；已在进行的操作会安全结束并保留回执。', 'No new steps will start. An in-flight operation settles safely and keeps its receipt.')}</p>}
    <div className="flex gap-3 flex-wrap text-sm">
      {task.status !== 'completed' && task.canResume !== false && <button disabled={busy} onClick={() => void action(task.desiredState === 'paused' || task.status === 'blocked' ? 'resume' : 'pause')} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 disabled:opacity-50">{task.desiredState === 'paused' || task.status === 'blocked' ? <Play size={14} /> : <Pause size={14} />}{task.desiredState === 'paused' || task.status === 'blocked' ? tr('继续', 'Resume') : tr('暂停', 'Pause')}</button>}
      {task.error?.code === 'CREATION_TRANSIENT_BACKOFF' && task.desiredState === 'run' && <button disabled={busy} onClick={() => void action('resume')} className="rounded-lg border border-border px-3 py-2">{tr('提前重试', 'Retry now')}</button>}
      {task.status === 'blocked' && task.desiredState !== 'paused' && <button disabled={busy} onClick={() => void action('pause')} className="rounded-lg border border-border px-3 py-2">{tr('暂停后调整', 'Pause to adjust')}</button>}
      <button disabled={task.desiredState !== 'paused' || busy || task.phase === 'completed'} onClick={() => { setPlan(task.plan); planVersion.current = task.version; setError(undefined); setEditing(!editing); }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 disabled:opacity-40"><Settings2 size={14} />{tr('调整计划', 'Edit plan')}</button>
      {task.foundation === 'completed' && <button onClick={() => onOpenWork(task.workId)} className="text-primary px-2 py-2">{tr('查看作品', 'Open work')}</button>}
    </div>
    {editing && <form onSubmit={e => { e.preventDefault(); void save(); }} className="grid sm:grid-cols-2 gap-3 rounded-xl bg-muted/30 p-4 text-sm">
      {(['title', 'genre', 'platform'] as const).map(key => <label key={key}>{key === 'title' ? tr('书名', 'Title') : key === 'genre' ? tr('题材', 'Genre') : tr('发布平台', 'Platform')}<input required disabled={locked || busy} value={plan[key] ?? ''} onChange={e => setPlan({ ...plan, [key]: e.target.value })} className="block mt-1 w-full border border-border rounded-lg bg-background p-2 disabled:opacity-50" /></label>)}
      <label>{tr('语言', 'Language')}<select disabled={locked || busy} value={plan.language} onChange={e => setPlan({ ...plan, language: e.target.value as 'zh' | 'en' })} className="block mt-1 w-full border border-border rounded-lg bg-background p-2"><option value="zh">中文</option><option value="en">English</option></select></label>
      <label>{tr('完结章数', 'Ending chapter')}<input disabled={busy || task.desiredState !== 'paused'} type="number" required min={Math.max(1, task.currentChapter)} max={2000} value={plan.targetChapters} onChange={e => setPlan({ ...plan, targetChapters: Number(e.target.value) })} className="block mt-1 w-full border border-border rounded-lg bg-background p-2" /></label>
      <label>{tr('后续每章篇幅', 'Future chapter length')}<input disabled={busy || task.desiredState !== 'paused'} type="number" required min={1} max={20000} value={plan.chapterWordCount} onChange={e => setPlan({ ...plan, chapterWordCount: Number(e.target.value) })} className="block mt-1 w-full border border-border rounded-lg bg-background p-2" /></label>
      <p className="sm:col-span-2 text-xs text-muted-foreground">{tr('已写章节保留原样。调整只影响后续计划；发布账号和远端书籍绑定需在发布配置中完成。', 'Existing chapters stay intact. Plan edits affect future work. Configure the publishing account and remote-book binding separately.')}</p>
      <button disabled={busy || task.desiredState !== 'paused' || task.phase === 'completed'} className="rounded-lg bg-primary text-primary-foreground px-3 py-2">{tr('保存计划', 'Save plan')}</button><button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-border px-3 py-2">{tr('取消', 'Cancel')}</button>
    </form>}
    {task.receipts.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{tr('发布回执', 'Publication receipts')} ({task.receipts.length})</summary><ul className="mt-2 space-y-2">{task.receipts.map(receipt => <li key={receipt.chapter} className="rounded-lg bg-muted/30 p-2 break-words">{tr('第', 'Chapter ')}{receipt.chapter} · {receipt.publication?.status} · {receipt.publication?.remoteChapterId ?? tr('等待远端编号', 'Remote ID pending')}<br />{receipt.publication?.evidence}<br />{receipt.revisionId}</li>)}</ul></details>}
  </article>;
}
