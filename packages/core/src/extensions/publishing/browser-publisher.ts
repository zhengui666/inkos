import { defineExtension, section } from '@earendil-works/pi-durable';
import type { InkExtension } from '../../runtime/plugins.js';
import { BrowserRunDoc } from '../browser/documents.js';

export const BROWSER_PUBLISHING_SKILL = `Use the current site's visible UI through actual MCP browser tools.
Observe the configured entry, visible account ID, existing work and selected artifact first. Follow actual links and pagination; titles alone are not unique identities.
In observe mode do not type into an autosaving editor or create/save/submit anything. Reopen existing details independently and read the exact title and full body.
Report absent only after a complete scoped inventory. After an interrupted intent, a missing row or a draft-looking editor is NOT positive notApplied evidence; report unknown unless the UI establishes the intent never happened.
For mutate publish: if no remote work exists, find the actual create-work control from the current snapshot; fill target metadata including its supplied cover, save once, capture the real ID from the actual URL, and reopen it independently before adding an artifact. No pre-existing saved artifact ID is required for the first artifact.
For update: reopen the existing actual artifact ID and edit it in place; never create another artifact, and do not invoke a publish action as an update substitute.
Preserve the supplied title/body exactly. Observe the real save/preview/submit dialog, make truthful content disclosures, and issue its final confirmation once. On a timeout stop; do not retry a mutation. The parent will observe independently.
Return actual author/reader URLs and remote IDs through inkos_browser_report. submitted means accepted by the author UI, not publicly published; published needs a real independently reopened reader with the same ID and full content.`;
export function createBrowserPublisherExtension(input: {
  id?: string; label?: string; capabilities?: Array<'create-work' | 'publish' | 'update'>; skill?: string;
} = {}): InkExtension {
  const id = input.id ?? 'browser';
  return { ...defineExtension({
    name: `inkos.publisher.${id}`,
    sections: [section(`publisher-${id}`, async (prompt, context) => {
      const run = await prompt.read.snapshot(BrowserRunDoc, prompt.conversationId, context);
      return run?.target?.platform === id ? BROWSER_PUBLISHING_SKILL + '\n' + (input.skill ?? '') : undefined;
    })],
  }), publishers: [{ id, label: input.label ?? 'Browser', capabilities: input.capabilities ?? ['create-work', 'publish', 'update'] }] };
}
export default createBrowserPublisherExtension();
