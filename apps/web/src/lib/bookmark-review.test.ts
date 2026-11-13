import { expect, it } from 'vitest';
import { bookmarkReviews, reviewedBookmarkChange } from './bookmark-review';
const entry = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, label: 'Chapter' };
it('keeps deleted server revisions for an explicit local restoration', () => {
 const remote = { ...entry, deleted: true, revision: 7 };
 const [review] = bookmarkReviews([entry], [remote]);
 expect(review.remote).toEqual(remote);
 expect(reviewedBookmarkChange(review.local, review.remote, false)).toMatchObject({ expectedRevision: 7, bookmark: entry, deleted: false });
 expect(bookmarkReviews([], [remote])).toEqual([]);
});
it('requires an explicit server locator for deletion instead of inferring intent from local absence', () => {
 const remote = { ...entry, deleted: false, revision: 4 };
 const [review] = bookmarkReviews([], [remote]);
 expect(review.local).toBeUndefined();
 expect(reviewedBookmarkChange(undefined, remote, true)).toMatchObject({ expectedRevision: 4, bookmark: entry, deleted: true });
 expect(() => reviewedBookmarkChange(entry, undefined, true)).toThrow();
 expect(() => reviewedBookmarkChange(undefined, { ...remote, deleted: true }, true)).toThrow();
});
it('compares by edition and paragraph and sends only the reviewed fields', () => {
 const local = { ...entry, updatedAt: 'device clock', id: 'local-id' };
 const remote = { ...entry, version: '2', deleted: false, revision: 2 };
 expect(bookmarkReviews([local], [remote])).toHaveLength(2);
 expect(() => reviewedBookmarkChange(local, remote, false)).toThrow();
 const choice = reviewedBookmarkChange(local, undefined, false);
 expect(choice.expectedRevision).toBe(0);
 expect(choice.bookmark).toEqual(entry);
 expect(reviewedBookmarkChange(local, undefined, false).operationId).not.toBe(choice.operationId);
});
