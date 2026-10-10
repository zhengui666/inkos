import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createOwnershipLockSpace, SQLITE_OWNER_TOKEN_PREFIX } from "@actalk/inkos-core";
import type { StudioChatRequestSnapshot } from "../shared/session-request.js";

const queues = new Map<string, Promise<void>>();
const activeOwners = new Set<string>();
type RequestOwner = NonNullable<StudioChatRequestSnapshot["owner"]>;
type LockSpace = ReturnType<typeof createOwnershipLockSpace>;
type OwnerLock = NonNullable<ReturnType<LockSpace["tryAcquire"]>>;
type LocalOwner = { status: "pending" | "binding" | "bound"; sessionKey?: string; handle?: OwnerLock };

export class ChatRequestAdmissionError extends Error {
  constructor(readonly code: "CHAT_REQUEST_ALREADY_RUNNING" | "CHAT_REQUEST_ID_REUSED", message: string) { super(message); }
}

/** Studio transport state, separate from the transcript's model/tool history. */
export class ChatRequestStore {
  private readonly locks: LockSpace;
  private readonly owners = new Map<string, LocalOwner>();

  constructor(private readonly root: string) {
    this.locks = createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"));
  }

  createOwner(): RequestOwner {
    const instanceId = `${SQLITE_OWNER_TOKEN_PREFIX}${randomUUID()}`;
    this.owners.set(instanceId, { status: "pending" });
    activeOwners.add(instanceId);
    return { pid: process.pid, instanceId };
  }

  releaseOwner(owner: RequestOwner): void {
    const local = this.owners.get(owner.instanceId);
    if (!local) return;
    try { local.handle?.release(); }
    finally {
      // An absent prefixed token is never a historical fixture or a fresh pending owner.
      this.owners.delete(owner.instanceId);
      activeOwners.delete(owner.instanceId);
    }
  }

  private alreadyRunning(): ChatRequestAdmissionError {
    return new ChatRequestAdmissionError("CHAT_REQUEST_ALREADY_RUNNING",
      "The saved request still has a live owner. Stop it in its original server before starting another request.");
  }

  private isKernelOwner(owner: RequestOwner | undefined): boolean {
    return owner?.instanceId.startsWith(SQLITE_OWNER_TOKEN_PREFIX) ?? false;
  }

  private hasLegacyLiveOwner(snapshot: StudioChatRequestSnapshot): boolean {
    if (!snapshot.owner) return false; // Ownerless historical snapshots retain the orphan restart policy.
    if (snapshot.owner.pid === process.pid) return activeOwners.has(snapshot.owner.instanceId);
    try { process.kill(snapshot.owner.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }

  private path(sessionId: string): string {
    return resolve(this.root, ".inkos", "chat-requests", `${encodeURIComponent(sessionId)}.json`);
  }

  private async enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.locks.key("studio-chat-state", sessionId), previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.locks.withStateLock("studio-chat-state", sessionId, operation));
    const settled = next.then(() => {}, () => {});
    queues.set(key, settled);
    try { return await next; } finally { if (queues.get(key) === settled) queues.delete(key); }
  }

  private async writeUnlocked(snapshot: StudioChatRequestSnapshot): Promise<void> {
    await mkdir(join(this.root, ".inkos", "chat-requests"), { recursive: true });
    const path = this.path(snapshot.sessionId), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  /** Acquire before entering state; a tentative owner also proves an old kernel owner is gone. */
  private bindOwner(snapshot: StudioChatRequestSnapshot): LocalOwner {
    const owner = snapshot.owner, local = owner && this.owners.get(owner.instanceId);
    if (!owner || owner.pid !== process.pid || local?.status !== "pending") {
      throw new Error("Chat request admission requires a fresh local owner.");
    }
    const handle = this.locks.tryAcquire("studio-chat-owner", snapshot.sessionId);
    if (!handle) throw this.alreadyRunning();
    const binding: LocalOwner = { status: "binding", sessionKey: handle.key, handle };
    this.owners.set(owner.instanceId, binding);
    return binding;
  }

  private isBound(owner: RequestOwner | undefined, sessionId: string): boolean {
    if (!owner || owner.pid !== process.pid) return false;
    const local = this.owners.get(owner.instanceId);
    return local?.status === "bound" && local.sessionKey === this.locks.key("studio-chat-owner", sessionId);
  }

  private async withBinding<T>(snapshot: StudioChatRequestSnapshot, operation: () => Promise<T>): Promise<T> {
    const binding = this.bindOwner(snapshot), token = snapshot.owner!.instanceId;
    try {
      const result = await operation();
      if (this.owners.get(token) !== binding) throw new Error("Chat request owner was released during admission.");
      binding.status = "bound";
      return result;
    } catch (error) {
      binding.handle!.release();
      if (this.owners.get(token) === binding) this.owners.set(token, { status: "pending" });
      throw error;
    }
  }

  private merge(current: StudioChatRequestSnapshot | null, incoming: StudioChatRequestSnapshot,
    mode: "replace" | "update"): StudioChatRequestSnapshot | undefined {
    if (current?.requestId !== incoming.requestId) return incoming;
    if (current.status === "cancelled") return undefined;
    if (current.cancelRequestedAt !== undefined) return { ...incoming, cancelRequestedAt: current.cancelRequestedAt,
      ...(incoming.status !== "running" ? { status: "cancelled", completedAt: incoming.completedAt ?? Date.now(),
        retry: undefined, error: undefined } : {}) };
    if (mode === "update" && current.status !== "running" && incoming.status === "running") return undefined;
    return incoming;
  }

  async save(snapshot: StudioChatRequestSnapshot, mode: "replace" | "update" = "replace"): Promise<void> {
    const owner = snapshot.owner;
    const fresh = mode === "replace" && snapshot.status === "running" && this.isKernelOwner(owner)
      && this.owners.get(owner!.instanceId)?.status === "pending";
    const write = () => this.enqueue(snapshot.sessionId, async () => {
      let current = await this.readUnlocked(snapshot.sessionId);
      if (mode === "update" && current?.requestId !== snapshot.requestId) return;
      if (this.isKernelOwner(owner) && !fresh && !this.isBound(owner, snapshot.sessionId)) return;
      if (mode === "update" && this.isKernelOwner(current?.owner)
        && (current!.owner!.instanceId !== owner?.instanceId || !this.isBound(owner, snapshot.sessionId))) return;
      if (fresh) {
        current = await this.recoverUnlocked(snapshot.sessionId, true);
        if (current?.status === "running") throw this.alreadyRunning();
        if (current?.requestId === snapshot.requestId) throw new ChatRequestAdmissionError("CHAT_REQUEST_ID_REUSED",
          "This request ID has already been used. Reload its saved result instead of resubmitting it.");
      }
      // Historical fixtures may still be written, but cannot overwrite a kernel-owned live slot.
      let probe: OwnerLock | undefined;
      try {
        if (!fresh && mode === "replace" && current && !this.isBound(owner, snapshot.sessionId)) {
          if (this.isKernelOwner(current.owner)) {
            probe = this.locks.tryAcquire("studio-chat-owner", snapshot.sessionId);
            if (!probe) throw this.alreadyRunning();
          } else if (this.hasLegacyLiveOwner(current)
            && (current.requestId !== snapshot.requestId || current.owner?.instanceId !== owner?.instanceId)) {
            throw this.alreadyRunning();
          }
        }
        if (!fresh && mode === "replace" && this.isKernelOwner(owner)
          && (current?.requestId !== snapshot.requestId || current.owner?.instanceId !== owner?.instanceId)) return;
        if (fresh && this.owners.get(owner!.instanceId)?.status !== "binding") {
          throw new Error("Chat request owner was released during admission.");
        }
        const merged = this.merge(current, snapshot, mode);
        if (merged) await this.writeUnlocked(merged);
      } finally { probe?.release(); }
    });
    if (fresh) await this.withBinding(snapshot, write); else await write();
  }

  /** Read, validate and occupy the shared session slot while retaining its owner lock. */
  async admit(snapshot: StudioChatRequestSnapshot,
    validate: (saved: StudioChatRequestSnapshot | null) => StudioChatRequestSnapshot = () => snapshot,
  ): Promise<StudioChatRequestSnapshot> {
    const { sessionId, requestId, owner } = snapshot;
    const instanceId = owner?.instanceId, pid = owner?.pid;
    return this.withBinding(snapshot, () => this.enqueue(sessionId, async () => {
      const saved = await this.recoverUnlocked(sessionId, true);
      if (saved?.status === "running") throw this.alreadyRunning();
      if (saved?.requestId === requestId) throw new ChatRequestAdmissionError("CHAT_REQUEST_ID_REUSED",
        "This request ID has already been used. Reload its saved result instead of resubmitting it.");
      // This callback is synchronous validation; it may not change the admission's lock domain or identity.
      const admitted = validate(saved);
      if (admitted.sessionId !== sessionId || admitted.requestId !== requestId
        || admitted.owner?.instanceId !== instanceId || admitted.owner?.pid !== pid) {
        throw new Error("Chat request validation changed the admission identity.");
      }
      if (this.owners.get(instanceId!)?.status !== "binding") throw new Error("Chat request owner was released during admission.");
      await this.writeUnlocked(admitted);
      return admitted;
    }));
  }

  private async recoverUnlocked(sessionId: string, ownsSlot = false): Promise<StudioChatRequestSnapshot | null> {
    const saved = await this.readUnlocked(sessionId);
    if (!saved || saved.status !== "running") return saved;
    let probe: OwnerLock | undefined;
    try {
      if (this.isKernelOwner(saved.owner)) {
        if (!ownsSlot) {
          probe = this.locks.tryAcquire("studio-chat-owner", sessionId);
          if (!probe) return saved;
        }
      } else if (this.hasLegacyLiveOwner(saved)) return saved;
      const snapshot: StudioChatRequestSnapshot = saved.cancelRequestedAt !== undefined
        ? { ...saved, status: "cancelled", completedAt: Date.now(), retry: undefined, error: undefined }
        : { ...saved, status: "failed", completedAt: Date.now(), error: {
          code: "CHAT_REQUEST_INTERRUPTED", message: "The request owner stopped before this request finished. Continue from the saved results.",
        } };
      await this.writeUnlocked(snapshot);
      return snapshot;
    } finally { probe?.release(); }
  }

  /** Reconcile under the state lock, probing an owner without waiting for it. */
  async recover(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
    return this.enqueue(sessionId, () => this.recoverUnlocked(sessionId));
  }

  /** Persist the user's intent before signalling a live controller. */
  async cancel(sessionId: string, liveRequestId?: string): Promise<StudioChatRequestSnapshot | null> {
    return this.enqueue(sessionId, async () => {
      const saved = await this.readUnlocked(sessionId);
      if (!saved || liveRequestId !== undefined && saved.requestId !== liveRequestId) return null;
      if (saved.status !== "running" && !(saved.status === "failed" && saved.error?.code === "CHAT_REQUEST_INTERRUPTED")) return null;
      let probe: OwnerLock | undefined;
      try {
        const live = this.isKernelOwner(saved.owner)
          ? !(probe = this.locks.tryAcquire("studio-chat-owner", sessionId)) : this.hasLegacyLiveOwner(saved);
        if (live && liveRequestId === undefined) return null;
        const snapshot: StudioChatRequestSnapshot = { ...saved, cancelRequestedAt: saved.cancelRequestedAt ?? Date.now(),
          ...(!live ? { status: "cancelled", completedAt: Date.now(), retry: undefined, error: undefined } : {}) };
        await this.writeUnlocked(snapshot);
        return snapshot;
      } finally { probe?.release(); }
    });
  }

  private async readUnlocked(sessionId: string): Promise<StudioChatRequestSnapshot | null> {
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
    return this.enqueue(sessionId, () => this.readUnlocked(sessionId));
  }

  async delete(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, () => rm(this.path(sessionId), { force: true }));
  }
}
