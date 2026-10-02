import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { StudioChatRequestSnapshot } from "../shared/session-request.js";

const queues = new Map<string, Promise<void>>();
const activeOwners = new Set<string>();
type RequestOwner = NonNullable<StudioChatRequestSnapshot["owner"]>;

export class ChatRequestAdmissionError extends Error {
  constructor(readonly code: "CHAT_REQUEST_ALREADY_RUNNING" | "CHAT_REQUEST_ID_REUSED", message: string) { super(message); }
}

/** Studio transport state, separate from the transcript's model/tool history. */
export class ChatRequestStore {
  constructor(private readonly root: string) {}

  createOwner(): RequestOwner {
    const instanceId = randomUUID();
    activeOwners.add(instanceId);
    return { pid: process.pid, instanceId };
  }

  releaseOwner(owner: RequestOwner): void { activeOwners.delete(owner.instanceId); }

  private hasLiveOwner(snapshot: StudioChatRequestSnapshot): boolean {
    if (!snapshot.owner) return false; // Legacy snapshots retain the existing restart policy.
    if (snapshot.owner.pid === process.pid) return activeOwners.has(snapshot.owner.instanceId);
    try { process.kill(snapshot.owner.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }

  private path(sessionId: string): string {
    return resolve(this.root, ".inkos", "chat-requests", `${encodeURIComponent(sessionId)}.json`);
  }

  private async enqueue<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    const key = this.path(sessionId), previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    const settled = next.then(() => {}, () => {});
    queues.set(key, settled);
    try { return await next; } finally { if (queues.get(key) === settled) queues.delete(key); }
  }

  private async write(snapshot: StudioChatRequestSnapshot): Promise<void> {
    await mkdir(join(this.root, ".inkos", "chat-requests"), { recursive: true });
    const path = this.path(snapshot.sessionId), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async save(snapshot: StudioChatRequestSnapshot, mode: "replace" | "update" = "replace"): Promise<void> {
    await this.enqueue(snapshot.sessionId, async () => {
      const current = await this.read(snapshot.sessionId);
      if (mode === "update" && current?.requestId !== snapshot.requestId) return;
      if (current?.requestId === snapshot.requestId) {
        if (current.status === "cancelled") return;
        if (current.cancelRequestedAt !== undefined) snapshot = { ...snapshot,
          cancelRequestedAt: current.cancelRequestedAt,
          ...(snapshot.status !== "running" ? { status: "cancelled", retry: undefined } : {}) };
      }
      await this.write(snapshot);
    });
  }

  /** Read, validate and occupy the shared session slot in one store queue turn. */
  async admit(snapshot: StudioChatRequestSnapshot,
    validate: (saved: StudioChatRequestSnapshot | null) => StudioChatRequestSnapshot = () => snapshot,
  ): Promise<StudioChatRequestSnapshot> {
    return this.enqueue(snapshot.sessionId, async () => {
      const saved = await this.recoverSaved(snapshot.sessionId);
      if (saved?.status === "running") throw new ChatRequestAdmissionError("CHAT_REQUEST_ALREADY_RUNNING",
        "The saved request still has a live owner. Stop it in its original server before starting another request.");
      if (saved?.requestId === snapshot.requestId) throw new ChatRequestAdmissionError("CHAT_REQUEST_ID_REUSED",
        "This request ID has already been used. Reload its saved result instead of resubmitting it.");
      const admitted = validate(saved);
      await this.write(admitted);
      return admitted;
    });
  }

  private async recoverSaved(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
    const saved = await this.read(sessionId);
    if (!saved || saved.status !== "running" || this.hasLiveOwner(saved)) return saved;
    const snapshot: StudioChatRequestSnapshot = saved.cancelRequestedAt !== undefined
      ? { ...saved, status: "cancelled", completedAt: Date.now(), retry: undefined, error: undefined }
      : { ...saved, status: "failed", completedAt: Date.now(), error: {
        code: "CHAT_REQUEST_INTERRUPTED", message: "The request owner stopped before this request finished. Continue from the saved results.",
      } };
    await this.write(snapshot);
    return snapshot;
  }

  /** Reconcile under the same queue as writes, without interrupting any live owner. */
  async recover(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
    return this.enqueue(sessionId, () => this.recoverSaved(sessionId));
  }

  /** Persist the user's intent before signalling a live controller. */
  async cancel(sessionId: string, liveRequestId?: string): Promise<StudioChatRequestSnapshot | null> {
    return this.enqueue(sessionId, async () => {
      const saved = await this.read(sessionId);
      if (!saved || liveRequestId !== undefined && saved.requestId !== liveRequestId) return null;
      if (saved.status !== "running" && !(saved.status === "failed" && saved.error?.code === "CHAT_REQUEST_INTERRUPTED")) return null;
      const live = this.hasLiveOwner(saved);
      if (live && liveRequestId === undefined) return null;
      const snapshot: StudioChatRequestSnapshot = { ...saved, cancelRequestedAt: Date.now(),
        ...(!live ? { status: "cancelled", completedAt: Date.now(), retry: undefined, error: undefined } : {}) };
      await this.write(snapshot);
      return snapshot;
    });
  }

  private async read(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
    try {
      const snapshot = JSON.parse(await readFile(this.path(sessionId), "utf8")) as StudioChatRequestSnapshot;
      if (snapshot.sessionId !== sessionId || typeof snapshot.requestId !== "string"
        || typeof snapshot.startedAt !== "number"
        || !["running", "completed", "failed", "cancelled"].includes(snapshot.status)
        || snapshot.owner !== undefined && (!Number.isInteger(snapshot.owner.pid) || snapshot.owner.pid < 1 || typeof snapshot.owner.instanceId !== "string")) {
        throw new Error("Invalid Studio chat request snapshot.");
      }
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async load(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
    await queues.get(this.path(sessionId));
    return this.read(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, () => rm(this.path(sessionId), { force: true }));
  }
}
