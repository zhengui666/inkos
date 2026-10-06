import {Command} from 'commander';
import {loadPublishingPreflight, publishingPreflightFailure} from '@actalk/inkos-core';
import {findProjectRoot, log} from '../utils.js';

/** Separate from the normal publishing command's mutating Store helper. */
export function createPublishingPreflightCommand(): Command {
  return new Command('preflight')
    .description('Read-only observation only: compare the current retained chapter; never authorizes publication')
    .argument('[work-id]', 'Work ID; inferred only when exactly one Work exists')
    .requiredOption('--chapter <number>', 'One existing local chapter number')
    .requiredOption('--config <path>', 'Explicit observation-only provider configuration JSON')
    .option('--json', 'Output comparisons without manuscript text, credentials or raw errors')
    .action(async (workId: string | undefined, options: {chapter: string; config: string; json?: boolean}) => {
      try {
        const result = await loadPublishingPreflight(findProjectRoot(), options.config, {workId, chapterNumber: Number(options.chapter)});
        log(JSON.stringify(result, null, 2));
        if (!result.matchesCurrentRevision) process.exitCode = 1;
      } catch (error) {
        log(JSON.stringify({observationOnly: true, publicationAuthorized: false, targetMappingChecked: false,
          retainedAttemptsChecked: false, matchesCurrentRevision: false, errors: [publishingPreflightFailure(error)]}));
        process.exitCode = 1;
      }
    });
}
