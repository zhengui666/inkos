import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishingManifestSchema, PublishingTargetSchema } from '../publishing/contracts.js';
import { PublishingStore } from '../publishing/store.js';
import {
  RemoteWorkDestinationSchema, RemoteWorkInputSchema, RemoteWorkMetadataSchema, RemoteWorkReceiptSchema,
  RemoteWorkRunSchema, remoteWorkView, type RemoteWorkInput, type RemoteWorkReceipt, type RemoteWorkRun,
} from '../publishing/work-creation-contracts.js';
import { RemoteWorkStore } from '../publishing/work-creation-store.js';

function input(workId = 'book', accountId = 'account-1', accountLabel = 'author'): RemoteWorkInput {
  return {workId, destination: {provider: 'calibrated-fixture', platform: 'meganovel', accountId, accountLabel, sessionId: 'session-1'},
    metadata: {title: 'A New Story', blurb: 'A frozen synopsis.', genre: 'Fantasy', language: 'en', aiAssisted: true}};
}
function receipt(run: RemoteWorkRun, remoteBookId = 'remote-1'): RemoteWorkReceipt {
  return {operationId: run.id, destination: run.input.destination, metadata: run.input.metadata, remoteBookId,
    observedAt: Math.max(Date.now(), run.attemptedAt ?? 0), evidence: 'Independent exact-scope readback of the saved work.',
    provenance: 'independently_observed', verifiedURL: 'https://example.test/author/books/remote-1'};
}

describe('remote Work creation ledger', () => {
  let root: string, databasePath: string, store: RemoteWorkStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inkos-remote-work-store-'));
    databasePath = join(root, '.inkos', 'harness.sqlite');
    store = new RemoteWorkStore(databasePath);
  });
  afterEach(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  function observed(value = input(), remoteBookId = 'remote-1') {
    const reserved = store.reserve(value);
    const begun = store.beginCreation(reserved.id, reserved.version);
    return store.recordObserved(begun.id, begun.version, receipt(begun, remoteBookId));
  }
  function sql<T>(read: (database: DatabaseSync) => T): T {
    const database = new DatabaseSync(databasePath);
    try { return read(database); } finally { database.close(); }
  }

  it('reserves once before mutation and returns detached, strictly frozen input on read', () => {
    const value = input();
    const run = store.reserve(value);
    expect(run).toMatchObject({phase: 'ready', attempts: 0, attemptedAt: null, receipt: null, targetId: null,
      unverifiedRemoteBookId: null, blocker: null, version: 0});
    expect(store.reserve(input())).toEqual(run);
    value.metadata.title = 'Changed outside the ledger';
    run.input.destination.accountId = 'Changed returned value';
    expect(store.forWork('book')!.input).toEqual(input());
    expect(store.list()).toEqual([store.get(run.id)]);
    expect(store.forWork('missing')).toBeUndefined();
    expect(() => store.get('missing')).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_MISSING'}));
    expect(sql(db => db.prepare('SELECT COUNT(*) AS count FROM publishing_targets').get()!.count)).toBe(0);
  });

  it('rejects every changed frozen destination or metadata field rather than resetting an operation', () => {
    const run = store.reserve(input());
    const mutations: RemoteWorkInput[] = [
      {...input(), destination: {...input().destination, provider: 'another-provider'}},
      {...input(), destination: {...input().destination, platform: 'qidian'}},
      {...input(), destination: {...input().destination, accountLabel: 'alias'}},
      {...input(), destination: {...input().destination, accountId: 'account-2'}},
      {...input(), destination: {...input().destination, sessionId: 'session-2'}},
      {...input(), metadata: {...input().metadata, title: 'Another title'}},
      {...input(), metadata: {...input().metadata, title: ' A New Story'}},
      {...input(), metadata: {...input().metadata, blurb: 'Another synopsis'}},
      {...input(), metadata: {...input().metadata, genre: 'Mystery'}},
      {...input(), metadata: {...input().metadata, language: 'zh'}},
      {...input(), metadata: {...input().metadata, aiAssisted: false}},
    ];
    for (const mutation of mutations) {
      expect(() => store.reserve(mutation)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_INPUT_CONFLICT'}));
    }
    expect(store.get(run.id)).toEqual(run);
  });

  it('serializes duplicate reservations and competing attempts across two store handles', async () => {
    const other = new RemoteWorkStore(databasePath);
    try {
      const [one, two] = await Promise.all([Promise.resolve().then(() => store.reserve(input())),
        Promise.resolve().then(() => other.reserve(input()))]);
      expect(one).toEqual(two);
      const attempts = await Promise.allSettled([
        Promise.resolve().then(() => store.beginCreation(one.id, one.version)),
        Promise.resolve().then(() => other.beginCreation(two.id, two.version)),
      ]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failed = attempts.find(result => result.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason.code).toBe('REMOTE_WORK_VERSION_CONFLICT');
      expect(other.get(one.id)).toMatchObject({phase: 'create_unknown', attempts: 1, version: 1});
      expect(store.list()).toHaveLength(1);
    } finally { other.close(); }
  });

  it('persists uncertainty first, retains it across blockers and restart, and never resets attempts', () => {
    const run = store.reserve(input());
    const begun = store.beginCreation(run.id, run.version);
    const blocked = store.setBlocker(begun.id, begun.version, {status: 'reconciliation_required', code: 'TIMEOUT', message: 'The mutation result is unknown.'});
    expect(remoteWorkView(blocked)).toMatchObject({status: 'reconciliation_required', phase: 'create_unknown', attempts: 1});
    store.close(); store = new RemoteWorkStore(databasePath);
    const restored = store.reserve(input());
    expect(restored).toEqual(blocked);
    const cleared = store.setBlocker(restored.id, restored.version, null);
    expect(remoteWorkView(cleared).status).toBe('create_unknown');
    expect(cleared.attemptedAt).toBe(begun.attemptedAt);
    expect(() => store.beginCreation(cleared.id, cleared.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECONCILIATION_REQUIRED'}));
  });

  it('blocks mutation until a readiness blocker is explicitly cleared and does not bump unchanged state', () => {
    const run = store.reserve(input());
    const blocker = {status: 'needs_setup' as const, code: 'PORT_UNAVAILABLE', message: 'No calibrated creation port.'};
    const blocked = store.setBlocker(run.id, run.version, blocker);
    expect(store.setBlocker(blocked.id, blocked.version, blocker)).toEqual(blocked);
    expect(remoteWorkView(blocked).status).toBe('needs_setup');
    expect(() => store.beginCreation(blocked.id, blocked.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_BLOCKED'}));
    const ready = store.setBlocker(blocked.id, blocked.version, null);
    expect(ready.phase).toBe('ready');
    expect(store.beginCreation(ready.id, ready.version).attempts).toBe(1);
  });

  it('cannot observe, hint or bind without a durable mutation attempt', () => {
    const run = store.reserve(input());
    expect(() => store.recordObserved(run.id, run.version, receipt(run))).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_ATTEMPT_MISSING'}));
    expect(() => store.recordHint(run.id, run.version, 'remote-1')).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_ATTEMPT_MISSING'}));
    expect(() => store.bindObserved(run.id, run.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_OBSERVATION_REQUIRED'}));
    expect(store.get(run.id)).toEqual(run);
  });

  it('persists only an unverified hint until an independent exact-ID observation arrives', () => {
    const run = store.reserve(input());
    const begun = store.beginCreation(run.id, run.version);
    const hinted = store.recordHint(begun.id, begun.version, 'remote-1');
    expect(hinted).toMatchObject({phase: 'create_unknown', receipt: null, targetId: null, unverifiedRemoteBookId: 'remote-1'});
    expect(store.recordHint(hinted.id, hinted.version, 'remote-1')).toEqual(hinted);
    expect(() => store.recordHint(hinted.id, hinted.version, 'remote-2')).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECEIPT_CONFLICT'}));
    expect(() => store.recordObserved(hinted.id, hinted.version, receipt(hinted, 'remote-2'))).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECEIPT_CONFLICT'}));
    expect(() => store.bindObserved(hinted.id, hinted.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_OBSERVATION_REQUIRED'}));
    store.close(); store = new RemoteWorkStore(databasePath);
    expect(store.get(hinted.id)).toEqual(hinted);
    const seen = store.recordObserved(hinted.id, hinted.version, receipt(hinted));
    expect(seen.phase).toBe('observed');
    expect(() => store.recordHint(seen.id, seen.version, 'remote-2')).toThrow();
    expect(store.bindObserved(seen.id, seen.version).phase).toBe('bound');
  });

  it('rejects wrong operation, full destination scope, frozen metadata and stale evidence time', () => {
    const run = store.reserve(input());
    const begun = store.beginCreation(run.id, run.version);
    const valid = receipt(begun);
    const variants: RemoteWorkReceipt[] = [
      {...valid, operationId: 'other-operation'},
      ...Object.entries({provider: 'different', platform: 'qidian', accountLabel: 'alias', accountId: 'other', sessionId: 'other'})
        .map(([key, value]) => ({...valid, destination: {...valid.destination, [key]: value}} as RemoteWorkReceipt)),
      ...Object.entries({title: 'different', blurb: 'different', genre: 'different', language: 'zh', aiAssisted: false})
        .map(([key, value]) => ({...valid, metadata: {...valid.metadata, [key]: value}} as RemoteWorkReceipt)),
      {...valid, observedAt: begun.attemptedAt! - 1},
    ];
    for (const variant of variants) {
      expect(() => store.recordObserved(begun.id, begun.version, variant)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECEIPT_CONFLICT'}));
    }
    expect(store.get(run.id)).toEqual(begun);
  });

  it('never replaces a receipt, its independent evidence, observation time, URL or remote ID', () => {
    const seen = observed();
    expect(store.recordObserved(seen.id, seen.version, seen.receipt!)).toEqual(seen);
    for (const patch of [{remoteBookId: 'remote-2'}, {evidence: 'Changed evidence'}, {observedAt: seen.receipt!.observedAt + 1},
      {verifiedURL: 'https://example.test/changed'}]) {
      expect(() => store.recordObserved(seen.id, seen.version, {...seen.receipt!, ...patch}))
        .toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECEIPT_CONFLICT'}));
    }
    expect(store.get(seen.id)).toEqual(seen);
  });

  it('creates an independently observed target only with a durable matching proof and idempotent bound read', () => {
    const seen = observed();
    const bound = store.bindObserved(seen.id, seen.version);
    expect(bound).toMatchObject({phase: 'bound', attempts: 1, receipt: seen.receipt, blocker: null});
    const publishing = new PublishingStore(databasePath);
    try {
      expect(publishing.getTarget(bound.targetId!)).toMatchObject({verification: 'independently_observed',
        observedAccountId: 'account-1', creationOperationId: bound.id, workId: 'book', remoteBookId: 'remote-1'});
      expect(publishing.listTargets()).toHaveLength(1);
    } finally { publishing.close(); }
    const proof = sql(db => db.prepare('SELECT * FROM publishing_remote_work_bindings WHERE operation_id=?').get(bound.id)!);
    expect(proof).toMatchObject({work_id: 'book', account_id: 'account-1', remote_book_id: 'remote-1', target_id: bound.targetId});
    expect(JSON.parse(String(proof.receipt_json))).toEqual(seen.receipt);
    expect(store.bindObserved(bound.id, bound.version)).toEqual(bound);
    store.close(); store = new RemoteWorkStore(databasePath);
    expect(store.get(bound.id)).toEqual(bound);
    expect(store.bindObserved(bound.id, bound.version)).toEqual(bound);
  });

  it('enforces actual-account identity across labels, providers and sessions', () => {
    const first = observed();
    store.bindObserved(first.id, first.version);
    const aliasInput = input('another-book', 'account-1', 'another-label');
    aliasInput.destination.provider = 'other-provider';
    aliasInput.destination.sessionId = 'other-session';
    const alias = observed(aliasInput);
    expect(() => store.bindObserved(alias.id, alias.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_BINDING_CONFLICT'}));
    expect(store.get(alias.id)).toEqual(alias);
    expect(sql(db => db.prepare('SELECT COUNT(*) AS count FROM publishing_targets').get()!.count)).toBe(1);
  });

  it('does not report bound after loss of its durable independent proof', () => {
    const seen = observed();
    const bound = store.bindObserved(seen.id, seen.version);
    sql(db => db.prepare('DELETE FROM publishing_remote_work_bindings WHERE operation_id=?').run(bound.id));
    expect(() => store.get(bound.id)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_INTEGRITY'}));
    expect(() => store.forWork('book')).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_INTEGRITY'}));
    expect(() => store.list()).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_INTEGRITY'}));
  });

  it('permits account-local remote IDs in distinct actual accounts with distinct labels', () => {
    const first = observed();
    const one = store.bindObserved(first.id, first.version);
    const second = observed(input('other-book', 'account-2', 'other-author'));
    const two = store.bindObserved(second.id, second.version);
    expect(one.targetId).not.toBe(two.targetId);
    expect(sql(db => db.prepare('SELECT COUNT(*) AS count FROM publishing_remote_work_bindings').get()!.count)).toBe(2);
  });

  it('rejects label collisions even when actual account IDs differ', () => {
    const first = observed();
    store.bindObserved(first.id, first.version);
    const second = observed(input('other-book', 'account-2', 'author'));
    expect(() => store.bindObserved(second.id, second.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_BINDING_CONFLICT'}));
  });

  it('fails closed on legacy unknown-account aliases without guessing even for a different real account', () => {
    const publishing = new PublishingStore(databasePath);
    try { publishing.mapBook({workId: 'legacy-book', platform: 'meganovel', accountLabel: 'legacy-label', remoteBookId: 'remote-1'}); }
    finally { publishing.close(); }
    const seen = observed(input('book', 'another-actual-account', 'author'));
    expect(() => store.bindObserved(seen.id, seen.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_AMBIGUOUS_TARGET'}));
    expect(store.get(seen.id)).toEqual(seen);
  });

  it('preserves legacy target JSON and immutable package bytes when reusing an exact legacy mapping', () => {
    const publishing = new PublishingStore(databasePath);
    const target = publishing.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'author', remoteBookId: 'remote-1'});
    const manifest = PublishingManifestSchema.parse({
      version: 1, adapter: 'manual', id: 'legacy-package', operationKey: 'legacy-operation', createdAt: target.createdAt,
      target, title: 'Legacy package', language: 'en',
      chapters: [{artifactId: 'chapter-1', revisionId: 'revision-1', number: 1, title: 'One', sourcePath: 'works/book/source/1.md', packagePath: 'chapters/1_chapter.md'}],
      formats: ['txt'], files: [{path: 'exports/book.txt', byteLength: 4, contentBase64: 'dGV4dA=='}], remoteVerified: false,
    });
    publishing.reservePreparation(manifest, '.prepare-legacy');
    publishing.registerPackage(manifest);
    publishing.close();
    const targetBytes = JSON.stringify(target, null, 3);
    const manifestBytes = JSON.stringify(manifest, null, 2);
    sql(db => {
      db.prepare('UPDATE publishing_targets SET target_json=? WHERE id=?').run(targetBytes, target.id);
      db.prepare('UPDATE publishing_packages SET manifest_json=? WHERE id=?').run(manifestBytes, manifest.id);
    });
    const seen = observed();
    const bound = store.bindObserved(seen.id, seen.version);
    expect(bound.targetId).toBe(target.id);
    expect(sql(db => db.prepare('SELECT target_json FROM publishing_targets WHERE id=?').get(target.id)!.target_json)).toBe(targetBytes);
    expect(sql(db => db.prepare('SELECT manifest_json FROM publishing_packages WHERE id=?').get(manifest.id)!.manifest_json)).toBe(manifestBytes);
    expect(JSON.parse(targetBytes).verification).toBe('user_supplied');
    expect(sql(db => db.prepare('SELECT receipt_json FROM publishing_remote_work_bindings WHERE target_id=?').get(target.id))).toBeDefined();
  });

  it('uses the separate proof to distinguish accounts after reusing a legacy target', () => {
    const publishing = new PublishingStore(databasePath);
    try { publishing.mapBook({workId: 'book', platform: 'meganovel', accountLabel: 'author', remoteBookId: 'remote-1'}); }
    finally { publishing.close(); }
    const first = observed();
    store.bindObserved(first.id, first.version);
    const second = observed(input('different-book', 'account-2', 'other-author'));
    expect(store.bindObserved(second.id, second.version).phase).toBe('bound');
  });

  it('retains observed proof across a crash before binding and resumes without recreating', () => {
    const seen = observed();
    store.close(); store = new RemoteWorkStore(databasePath);
    expect(store.reserve(input())).toEqual(seen);
    expect(() => store.beginCreation(seen.id, seen.version)).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_RECONCILIATION_REQUIRED'}));
    expect(store.bindObserved(seen.id, seen.version).phase).toBe('bound');
  });

  it.each(['proof', 'phase'])('rolls target and proof back together when the %s write fails', stage => {
    const seen = observed();
    sql(db => db.exec(stage === 'proof'
      ? "CREATE TRIGGER fail_binding BEFORE INSERT ON publishing_remote_work_bindings BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;"
      : `CREATE TRIGGER fail_binding BEFORE UPDATE ON publishing_remote_work_runs
          WHEN NEW.run_json LIKE '%"phase":"bound"%' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`));
    expect(() => store.bindObserved(seen.id, seen.version)).toThrow('simulated crash');
    expect(store.get(seen.id)).toEqual(seen);
    expect(sql(db => db.prepare('SELECT COUNT(*) AS count FROM publishing_targets').get()!.count)).toBe(0);
    expect(sql(db => db.prepare('SELECT COUNT(*) AS count FROM publishing_remote_work_bindings').get()!.count)).toBe(0);
    sql(db => db.exec('DROP TRIGGER fail_binding'));
    store.close(); store = new RemoteWorkStore(databasePath);
    expect(store.bindObserved(seen.id, seen.version).phase).toBe('bound');
  });

  it('rejects stale receipt, hint, blocker and bind writes across handles', () => {
    const run = store.reserve(input());
    const begun = store.beginCreation(run.id, run.version);
    const other = new RemoteWorkStore(databasePath);
    try {
      const seen = other.recordObserved(begun.id, begun.version, receipt(begun));
      for (const mutate of [
        () => store.recordObserved(begun.id, begun.version, seen.receipt!),
        () => store.recordHint(begun.id, begun.version, 'remote-1'),
        () => store.setBlocker(begun.id, begun.version, null),
        () => store.bindObserved(begun.id, begun.version),
      ]) expect(mutate).toThrowError(expect.objectContaining({code: 'REMOTE_WORK_VERSION_CONFLICT'}));
      const bound = other.bindObserved(seen.id, seen.version);
      expect(store.bindObserved(bound.id, bound.version)).toEqual(bound);
    } finally { other.close(); }
  });

  it('supports isolated in-memory usage with the same binding guarantees', () => {
    const memory = new RemoteWorkStore(':memory:');
    try {
      const ready = memory.reserve(input());
      const begun = memory.beginCreation(ready.id, ready.version);
      const seen = memory.recordObserved(begun.id, begun.version, receipt(begun));
      expect(memory.bindObserved(seen.id, seen.version).phase).toBe('bound');
    } finally { memory.close(); }
  });
});

describe('remote Work creation strict contracts', () => {
  it('requires nonempty full scopes, exact metadata, and explicit truthful declaration', () => {
    for (const key of ['provider', 'accountLabel', 'accountId', 'sessionId']) {
      expect(RemoteWorkDestinationSchema.safeParse({...input().destination, [key]: '   '}).success).toBe(false);
    }
    for (const key of ['title', 'blurb', 'genre']) {
      expect(RemoteWorkMetadataSchema.safeParse({...input().metadata, [key]: '   '}).success).toBe(false);
    }
    expect(RemoteWorkMetadataSchema.safeParse({...input().metadata, aiAssisted: undefined}).success).toBe(false);
    expect(RemoteWorkInputSchema.safeParse({...input(), allowUnsafe: true}).success).toBe(false);
    expect(RemoteWorkDestinationSchema.safeParse({...input().destination, configuration: {}}).success).toBe(false);
  });

  it('rejects unsafe receipt URLs, fabricated provenance, empty evidence, invalid times and injected configuration', () => {
    const value = {operationId: 'operation', destination: input().destination, metadata: input().metadata,
      remoteBookId: 'remote-1', observedAt: 1, evidence: 'Independent observation', provenance: 'independently_observed'};
    for (const verifiedURL of ['http://example.test', 'https://user@example.test', 'https://user:secret@example.test',
      'javascript:alert(1)', 'file:///tmp/book', 'not a URL', ' https://example.test', 'https://example.test/\npath']) {
      expect(RemoteWorkReceiptSchema.safeParse({...value, verifiedURL}).success).toBe(false);
    }
    for (const patch of [{provenance: 'user_reported'}, {evidence: ' '}, {observedAt: -1}, {observedAt: Infinity},
      {configuration: {endpoint: 'https://example.test'}}, {accountId: 'other'}]) {
      expect(RemoteWorkReceiptSchema.safeParse({...value, ...patch}).success).toBe(false);
    }
    expect(RemoteWorkReceiptSchema.safeParse({...value, verifiedURL: 'https://example.test/book/1'}).success).toBe(true);
  });

  it('prevents target provenance fields through the existing manual mapping API', () => {
    const publishing = new PublishingStore(':memory:');
    try {
      const value = {workId: 'book', platform: 'meganovel' as const, accountLabel: 'author', remoteBookId: 'remote-1'};
      expect(() => publishing.mapBook({...value, verification: 'independently_observed', observedAccountId: 'account', creationOperationId: 'operation'} as never)).toThrow();
      const target = publishing.mapBook(value);
      expect(target.verification).toBe('user_supplied');
      expect(PublishingTargetSchema.safeParse({...target, verification: 'independently_observed'}).success).toBe(false);
      expect(PublishingTargetSchema.safeParse({...target, observedAccountId: 'account', creationOperationId: 'operation'}).success).toBe(false);
    } finally { publishing.close(); }
  });

  it('rejects phase/history mismatches and a hint masquerading as a bound result', () => {
    const ready = {id: 'operation', input: input(), version: 0, phase: 'ready', attempts: 0, attemptedAt: null,
      receipt: null, targetId: null, unverifiedRemoteBookId: null, blocker: null, createdAt: 0, updatedAt: 0};
    expect(RemoteWorkRunSchema.safeParse(ready).success).toBe(true);
    for (const patch of [{phase: 'bound'}, {phase: 'observed'}, {attempts: 1}, {attempts: 2},
      {unverifiedRemoteBookId: 'remote-1'}, {targetId: 'target'}, {phase: 'create_unknown', attempts: 1}]) {
      expect(RemoteWorkRunSchema.safeParse({...ready, ...patch}).success).toBe(false);
    }
  });
});
