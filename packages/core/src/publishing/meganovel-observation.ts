import {normalizeMegaNovelBodyText, type MegaNovelSnapshot} from './meganovel-contracts.js';

/** Pure shared comparison; absence is not evidence that a timed-out submission can be retried. */
export function compareMegaNovelChapter(snapshot: MegaNovelSnapshot,
  chapter: {number: number; title: string; content: string}, remoteChapterId?: string) {
  const found = snapshot.candidates.length === 1 ? snapshot.candidates[0] : undefined;
  const chapterIdentityMatches = Boolean(found && found.number === chapter.number
    && (!remoteChapterId || found.remoteChapterId === remoteChapterId));
  const titleMatches = Boolean(found && found.title === chapter.title);
  const contentMatches = Boolean(found && normalizeMegaNovelBodyText(found.content) === normalizeMegaNovelBodyText(chapter.content));
  const errors: Array<{code: string; message: string}> = [];
  if (!snapshot.complete) errors.push({code: 'MEGANOVEL_INCOMPLETE_LOOKUP', message: 'The remote lookup is incomplete.'});
  if (snapshot.candidates.length > 1) errors.push({code: 'MEGANOVEL_DUPLICATE_CHAPTER', message: 'Multiple remote rows match this chapter.'});
  if (found && (!chapterIdentityMatches || !titleMatches || !contentMatches)) {
    errors.push({code: 'MEGANOVEL_CONTENT_CONFLICT', message: 'Remote chapter identity, title or body differs from the retained revision.'});
  }
  return {lookupComplete: snapshot.complete, chapterFound: snapshot.candidates.length > 0,
    chapterIdentityMatches, titleMatches, contentMatches, remoteStatus: found?.status ?? null, errors};
}
