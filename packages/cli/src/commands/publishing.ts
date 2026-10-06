import { Command } from 'commander';
import {createPublishingPreflightCommand} from './publishing-preflight.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PublishingStore, ManualPublishingAdapter, PublishingSelectionSchema, PublishingFormatsSchema,
  PublishingPlatformSchema, PublishingReceiptSchema, listPublishingCapabilities, listWorkManifests,
} from '@actalk/inkos-core';
import { findProjectRoot, log, logError } from '../utils.js';

type Options = {json?: boolean};
async function run(options: Options, task: (adapter: ManualPublishingAdapter, store: PublishingStore, root: string) => Promise<unknown> | unknown) {
  let store: PublishingStore | undefined;
  try {
    const root = findProjectRoot();
    store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    const result = await task(new ManualPublishingAdapter(root, store), store, root);
    log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {error: error instanceof Error ? error.message : String(error), code: (error as {code?: string}).code};
    if (options.json) log(JSON.stringify(failure)); else logError(failure.error);
    process.exitCode = 1;
  } finally { store?.close(); }
}

export function createPublishingCommand(): Command {
  const command = new Command('publishing').description('Prepare immutable manual publishing packages and record user-reported receipts; never uploads');
  command.addCommand(createPublishingPreflightCommand());
  command.command('capabilities').option('--json', 'Output JSON').action(() => log(JSON.stringify(listPublishingCapabilities(), null, 2)));
  command.command('map-book').argument('<platform>', PublishingPlatformSchema.options.join(', '))
    .argument('<remote-book-id>', 'Existing platform book ID, supplied by the author')
    .argument('[work-id]', 'Work ID; inferred only when exactly one Work exists')
    .requiredOption('--account <label>', 'Local account label, never a password or token')
    .option('--json', 'Output JSON')
    .action(async (platform: string, remoteBookId: string, workId: string | undefined, opts: Options & {account: string}) => run(opts, async (adapter, _store, root) => {
      if (!workId) {
        const works = await listWorkManifests(root);
        if (works.length !== 1) throw new Error('Specify work-id when the project does not contain exactly one Work.');
        workId = works[0]!.id;
      }
      return adapter.mapBook({platform: PublishingPlatformSchema.parse(platform), remoteBookId, accountLabel: opts.account, workId});
    }));
  command.command('targets').option('--json', 'Output JSON').action((opts: Options) => run(opts, (_adapter, store) => store.listTargets()));
  command.command('prepare').argument('<target-id>').requiredOption('--selection <path>', 'JSON array of exact artifactId, revisionId, number and title selections')
    .option('--formats <formats>', 'Comma-separated txt,md,epub', 'txt,md,epub').option('--json', 'Output JSON')
    .action((targetId: string, opts: Options & {selection: string; formats: string}) => run(opts, async (adapter) => {
      const chapters = PublishingSelectionSchema.parse(JSON.parse(await readFile(opts.selection, 'utf8')));
      const formats = PublishingFormatsSchema.parse(opts.formats.split(','));
      const pkg = await adapter.prepare({targetId, chapters, formats});
      return adapter.verify(pkg.manifest.id);
    }));
  command.command('list').option('--target <id>', 'Filter by book mapping').option('--json', 'Output JSON')
    .action((opts: Options & {target?: string}) => run(opts, (_adapter, store) => store.listPackages(opts.target)));
  command.command('show').argument('<package-id>').option('--json', 'Output JSON')
    .action((packageId: string, opts: Options) => run(opts, (_adapter, store) => store.getPackage(packageId)));
  command.command('verify').argument('<package-id>').option('--json', 'Output JSON')
    .action((packageId: string, opts: Options) => run(opts, adapter => adapter.verify(packageId)));
  command.command('begin').description('Record an impending human submission before using the platform; does not upload')
    .argument('<package-id>').argument('<chapter-number>')
    .requiredOption('--version <number>', 'Current package state version from show')
    .requiredOption('--event-id <id>', 'Unique local event ID; reuse only for an exact retry')
    .option('--json', 'Output JSON')
    .action((packageId: string, chapterNumber: string, opts: Options & {version: string; eventId: string}) => run(opts, adapter =>
      adapter.beginSubmission({packageId, chapterNumber: Number(chapterNumber), expectedVersion: Number(opts.version), eventId: opts.eventId})));
  command.command('receipt').description('Record author-checked platform status, never remote verification')
    .argument('<package-id>').argument('<chapter-number>')
    .requiredOption('--status <status>', 'submission_unknown, submitted_reported, published_reported, not_submitted_reported')
    .requiredOption('--evidence <text>', 'What the author observed, including a receipt/reference when available; no credentials')
    .option('--remote-chapter <id>', 'Platform chapter ID; required for published_reported')
    .requiredOption('--version <number>', 'Current package state version from show')
    .requiredOption('--event-id <id>', 'Unique local receipt event ID; reuse only for an exact retry')
    .option('--json', 'Output JSON')
    .action((packageId: string, chapterNumber: string, opts: Options & {status: string; evidence: string; remoteChapter?: string; version: string; eventId: string}) => run(opts, adapter =>
      adapter.recordReceipt({packageId, chapterNumber: Number(chapterNumber), expectedVersion: Number(opts.version), eventId: opts.eventId,
        receipt: PublishingReceiptSchema.parse({status: opts.status, evidence: opts.evidence, remoteChapterId: opts.remoteChapter})})));
  return command;
}
