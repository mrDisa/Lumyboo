import copy
import json
from pathlib import Path
import tempfile
import unittest

from import_batch import digest, import_book, json_bytes, prepare, publish, selection


def page(number=1, total=1, body='<h2>I</h2><z>Начало <i>истории</i>.</z>', next_path=None):
    navigation = f'<a title="Дальше" href="{next_path}">Дальше</a>' if next_path else ''
    return (f'<html><div id="text"><div class="title"><h1>Название</h1></div>{body}'
            '<script>malicious()</script><div class="fns"><z>Современный комментарий</z></div>'
            f'</div><span id="toc">{number}/{total}</span>{navigation}'
            '<div>Произведение перешло в общественное достояние</div></html>').encode('cp1251')


def book(id='test-book', text_id=10):
    return {'id': id, 'title': 'Книга', 'author': 'Автор', 'genre': 'Классика', 'year': '1900', 'version': '1',
            'source': {'type': 'ilibrary', 'url': f'https://ilibrary.ru/text/{text_id}/p.1/index.html', 'scope': 'work', 'edition': 'Издание'},
            'review': {'textApproved': True, 'rightsApproved': True, 'rightsBasis': 'Общественное достояние', 'description': 'Описание'},
            'cover': {'approved': True, 'id': 9, 'url': 'https://example.org/print.jpg', 'sourceUrl': 'https://example.org/source',
                      'rightsBasis': 'Печатное издание, public domain', 'sha256': digest(b'\xff\xd8\xffcover')}}


class Download:
    def __init__(self, pages):
        self.pages, self.requests = pages, []

    def get(self, url, *args):
        self.requests.append(url)
        return self.pages[url]


class BatchTests(unittest.TestCase):
    def test_collects_all_pages_and_keeps_epigraph_and_its_author(self):
        b = book()
        first = '<div class="epigraf"><div style="text-align:right">Стрелялись мы.</div><div class="epigraf_author">Баратынский.</div><z>Эпиграф.</z><div class="epigraf_source">Имя автора</div></div><h2>I</h2><z>Один<sup>1</sup>.</z>'
        d = Download({b['source']['url']: page(1, 2, first, '/text/10/p.2/index.html'),
                      'https://ilibrary.ru/text/10/p.2/index.html': page(2, 2, '<h2>II</h2><z>Конец.</z>')})
        content, sources = import_book(b, d)
        self.assertEqual([c['title'] for c in content['chapters']], ['Книга', 'I', 'II'])
        texts = [p['text'] for c in content['chapters'] for p in c['paragraphs']]
        self.assertEqual(texts, ['Стрелялись мы.', 'Баратынский.', 'Эпиграф.', 'Имя автора', 'Один.', 'Конец.'])
        self.assertEqual(len(sources), 2)

    def test_selected_story_does_not_import_rest_of_collection(self):
        b = book()
        b['source'].update(scope='page', url='https://ilibrary.ru/text/10/p.5/index.html')
        d = Download({b['source']['url']: page(5, 6, next_path='/text/10/p.6/index.html')})
        content, sources = import_book(b, d)
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(d.requests), 1)
        self.assertEqual(len(content['chapters']), 1)

    def test_rejects_missing_reordered_or_external_pages(self):
        b = book()
        for raw in [page(1, 2), page(2, 2), page(1, 2, next_path='https://evil.example/text')]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                import_book(b, Download({b['source']['url']: raw}))

    def test_single_page_requires_source_index_and_complete_footer(self):
        b = book()
        raw = page().replace(b'<span id="toc">1/1</span>', b'').replace(b'<div>\xcf', b'<div id="tbtm">\xcf')
        index_url = 'https://ilibrary.ru/text/10/index.html'
        d = Download({b['source']['url']: raw, index_url: b'<a href="/text/10/p.1/index.html">text</a>'})
        content, sources = import_book(b, d)
        self.assertEqual(len(content['chapters']), 1)
        self.assertEqual(sources[-1]['role'], 'single-page-index')
        d.pages[index_url] += b'<a href="/text/10/p.2/index.html">more</a>'
        with self.assertRaisesRegex(ValueError, 'single-page completeness'):
            import_book(b, d)

    def test_changed_pinned_edition_is_rejected(self):
        b = book()
        b['expectedSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'pinned edition'):
            import_book(b, Download({b['source']['url']: page()}))

    def test_unknown_literary_blocks_are_reported_instead_of_silently_lost(self):
        b = book()
        with self.assertRaisesRegex(ValueError, 'Unrecognized literary text'):
            import_book(b, Download({b['source']['url']: page(body='<div>Литературная строка</div><z>Текст.</z>')}))

    def test_reports_failure_and_continues_independent_books(self):
        b, other = book(), book('second-book', 20)
        d = Download({b['source']['url']: b'<html>Not a book</html>', other['source']['url']: page()})
        with tempfile.TemporaryDirectory() as directory:
            result = prepare({'id': 'batch', 'books': [b, other]}, directory, d)
            self.assertEqual([r['status'] for r in result['books']], ['failed', 'prepared'])
            self.assertFalse((Path(directory) / 'test-book.json').exists())

    def test_corrupt_epub_does_not_abort_following_books(self):
        b, other = book(), book('second-book', 20)
        b['source'] = {'type': 'epub', 'url': 'https://example.org/book.epub'}
        d = Download({b['source']['url']: b'not a zip archive', other['source']['url']: page()})
        with tempfile.TemporaryDirectory() as directory:
            report = prepare({'id': 'batch', 'books': [b, other]}, directory, d)
            self.assertEqual([r['status'] for r in report['books']], ['failed', 'prepared'])

    def setup_bundle(self, root, books):
        for p in ['apps/web/src/data/catalog.json', 'services/api/internal/httpapi/catalog.json']:
            path = root / p
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('[]\n')
        (root / 'services/api/db/migrations').mkdir(parents=True)
        value = {'schemaVersion': 1, 'id': 'batch', 'books': books}
        pages = {b['source']['url']: page() for b in books}
        pages['https://example.org/print.jpg'] = b'\xff\xd8\xffcover'
        d = Download(pages)
        bundle = root / 'staging'
        prepare(value, bundle, d)
        return value, bundle, d

    def test_unreviewed_books_never_enter_public_and_approved_batch_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pending = book('pending-book', 20)
            pending['review']['rightsApproved'] = False
            value, bundle, d = self.setup_bundle(root, [book(), pending])
            self.assertEqual(publish(value, bundle, '016_batch', d, root), 1)
            self.assertEqual(publish(value, bundle, '016_batch', d, root), 0)
            self.assertFalse((root / 'apps/web/public/books/pending-book.json').exists())
            catalog = json.loads((root / 'apps/web/src/data/catalog.json').read_text())
            self.assertEqual([b['id'] for b in catalog], ['test-book'])
            self.assertEqual(json.loads((root / 'services/api/internal/httpapi/catalog.json').read_text()), catalog)
            locations = json.loads((root / 'services/api/internal/httpapi/bookmark-locations.json').read_text())
            self.assertIn('test-book', locations)
            self.assertTrue((root / 'services/api/db/migrations/016_batch.up.sql').exists())
            self.assertTrue((root / 'docs/content-batches/batch.json').exists())

    def test_rejects_tampering_before_any_repository_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, bundle, d = self.setup_bundle(root, [book(), book('second-book', 20)])
            (bundle / 'second-book.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'changed'):
                publish(value, bundle, '016_batch', d, root)
            self.assertEqual((root / 'apps/web/src/data/catalog.json').read_text(), '[]\n')
            self.assertFalse((root / 'apps/web/public').exists())

    def test_rejects_changed_source_and_existing_edition_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, bundle, d = self.setup_bundle(root, [book()])
            changed = copy.deepcopy(value)
            changed['books'][0]['source']['scope'] = 'page'
            # Even if bytes match for a one-page work, a modified source URL cannot pass.
            changed['books'][0]['source']['url'] = 'https://ilibrary.ru/text/20/p.1/index.html'
            d.pages[changed['books'][0]['source']['url']] = page()
            with self.assertRaisesRegex(ValueError, 'selection changed'):
                publish(changed, bundle, '016_batch', d, root)
            publish(value, bundle, '016_batch', d, root)
            value['books'][0]['title'] = 'Подмена издания'
            with self.assertRaisesRegex(ValueError, 'replace an existing edition'):
                publish(value, bundle, '017_replacement', d, root)

    def test_rejects_cover_hash_and_migration_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, bundle, d = self.setup_bundle(root, [book()])
            d.pages['https://example.org/print.jpg'] = b'\xff\xd8\xffdifferent'
            with self.assertRaisesRegex(ValueError, 'JPEG hash'):
                publish(value, bundle, '016_batch', d, root)
            d.pages['https://example.org/print.jpg'] = b'\xff\xd8\xffcover'
            (root / 'services/api/db/migrations/016_other.up.sql').write_text('existing')
            with self.assertRaisesRegex(ValueError, 'Migration number'):
                publish(value, bundle, '016_batch', d, root)
            self.assertFalse((root / 'apps/web/public').exists())

    def test_selection_rejects_path_injection_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'batch.json'
            for books in [[book('../escape')], [book(), book()]]:
                path.write_bytes(json_bytes({'schemaVersion': 1, 'id': 'batch', 'books': books}))
                with self.assertRaises(ValueError):
                    selection(path)


if __name__ == '__main__':
    unittest.main()
