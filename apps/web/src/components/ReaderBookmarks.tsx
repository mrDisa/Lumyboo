import type { BookContent } from '../lib/books';
import type { Bookmark } from '../lib/db';
import { Empty, Icon } from './ui';
import styles from '../pages/Reader.module.css';

export function ReaderBookmarks({ content, bookmarks, open, remove }: {
 content: BookContent; bookmarks: Bookmark[]; open: (bookmark: Bookmark) => void; remove: (bookmark: Bookmark) => void;
}) {
 return <div className={styles.bookmarks}>
  <div className={styles.contentsIntro}><span>Сохранённые моменты</span><b>{bookmarks.length}</b></div>
  {bookmarks.length ? <ul className={styles.bookmarkList}>{bookmarks.map(bookmark => {
   const chapter = content.chapters[bookmark.chapter];
   const paragraph = chapter?.paragraphs.find(item => item.id === bookmark.paragraph);
   return <li key={bookmark.id} className={styles.bookmarkCard}>
    <button className={styles.bookmarkOpen} onClick={() => open(bookmark)}>
     <span className={styles.bookmarkHeading}><Icon name="bookmark" /><small>Глава {bookmark.chapter + 1}</small><span aria-hidden="true">→</span></span>
     <b>{bookmark.label}</b>
     {paragraph && <span className={styles.bookmarkExcerpt}>{paragraph.text}</span>}
     <small>Продолжить отсюда</small>
    </button>
    <button className="circle" aria-label={`Удалить закладку: ${bookmark.label}`} onClick={() => remove(bookmark)}><Icon name="close" /></button>
   </li>;
  })}</ul> : <Empty><span className={styles.emptyBookmark}><Icon name="bookmark" /></span>Сохрани момент, к которому хочется вернуться.<br />Нажми значок закладки над текстом.</Empty>}
 </div>;
}
