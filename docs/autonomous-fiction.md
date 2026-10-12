# Unattended fiction

Studio has three destinations: **Model configuration**, **Extensions**, and **Works & revisions**. Research, native task controls, saved revisions, targets and publishing receipts live inside a work. Language/theme changes and reconnects only change the view; they do not start tasks.

## Start a run

1. Configure a real provider/model. Create a fiction work and choose its manuscript locale and author brief.
2. In **Unattended writing**, configure ranking URLs and an installed ranking reader. Check sources without a model call; 403, empty and unreadable responses remain errors.
3. Choose chapter/research intervals and run duration (defaults: one chapter/hour, research every six hours, 24 hours). An empty work can explicitly adopt the generated original topic/title. Existing content/title is not replaced.
4. Start the timed run. A native `inkos.autonomy` task acquires evidence, chooses an original topic/book title, plans chapter titles, runs content planning/composition/review/necessary revision/save, then sleeps until the next chapter or research refresh. Later runs retain an established story blueprint. The persisted `inkos.autonomy.deadline` task interrupts the run at its original end time, even after restart or while paused.
5. Saved content derives separate native distribution tasks for each enabled target. With no target, writing stays local. To publish, configure a legitimate account, destination/remote-work mapping and installed publisher/browser capability. Captcha, login, contract/payment and unknown remote outcomes remain visible per-target actions; they are not treated as success. Previously saved versions can be queued explicitly.

Failures retry after five minutes, doubling up to one hour and bounded by the run deadline. Content recovery keeps the same artifact/revision identity and adopts saved drafts/edits/reviews rather than blindly generating a replacement. The next chapter is paced from the successful save. A publisher problem does not stop the unattended creation task. Pause is boundary intent; **Stop run** uses native cancellation and leaves the work paused with its saved drafts intact.

The runtime must remain available. If stopped or the machine is suspended, it resumes the persisted task/deadline on reopen; it cannot execute while offline. A configured task or a short deadline test is not evidence of completed 24-hour operation or real publication.

## Extend ranking acquisition

Use an official extension plus `rankingSources` on `InkExtension`:

```ts
import { defineExtension } from '@earendil-works/pi-durable';
import type { InkExtension } from '@actalk/inkos-core';

const extension: InkExtension = Object.assign(defineExtension({ name: 'my.research' }), {
  rankingSources: [{
    id: 'my-ranking', label: 'My ranking source', description: 'Read the configured public ranking.',
    async read(config, signal) {
      const response = await fetch(config.url, { signal });
      if (!response.ok) throw new Error(`Source returned ${response.status}`);
      // Parse only genuine evidence. An authenticated/dynamic source may reuse installed official MCP tools.
      return response.text();
    },
  }],
});
export default extension;
```

Readers receive `{ id, source, url, label? }` and the native cancellation signal. The built-in `public-page` reader fetches HTML/plain text and stores up to 32,000 characters with the source URL/time. Acquisition is memoized per research round in the native task. Topic evidence quotes must match the acquired text; model suggestions are not authoritative ranking facts.

Named RPCs are `ranking.read`, `autonomy.configure`, `autonomy.start`, and `autonomy.stop`. `autonomy.start` accepts `{workId, durationMs?, requestId?}`; duplicate requests/active starts reuse the existing run and never extend its deadline. Default duration is 86,400,000ms. No secondary scheduler, execution ledger or browser transport is introduced.
