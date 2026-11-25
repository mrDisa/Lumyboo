"""Publication boundaries and interruption recovery for large content batches."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from import_batch import (Downloader, approved_catalog, clearance_blockers, cover_search_url, digest,
                          discover_covers, fingerprint, json_bytes, prepare, publish)
import test_import_batch as fixtures
from test_import_batch import Download, book, page


def cleared():
    b = book()
    b['expectedSha256'] = 'a' * 64
    b['clearance'] = {'original': 'author', 'translation': None, 'edition': 'text', 'cover': 'cover'}
    common = {'status': 'approved', 'basis': 'Test review', 'evidence': ['https://example.org/evidence'],
              'reviewer': 'fixture', 'reviewedAt': '2026-01-01', 'territories': ['RU']}
    registry = {'schemaVersion': 1, 'records': {
        'author': {**common, 'kind': 'original', 'author': b['author']},
        'text': {**common, 'kind': 'edition', 'sourceFingerprint': fingerprint(b['source']),
                 'textSha256': b['expectedSha256'], 'contributors': ['author', None]},
        'cover': {**common, 'kind': 'printed-cover', 'coverFingerprint': fingerprint(b['cover'])}}}
    value = {'schemaVersion': 2, 'id': 'batch', 'targetTerritories': ['RU'], 'books': [b]}
    return value, b, registry


class ClearanceTests(unittest.TestCase):
    def test_legacy_approval_flags_alone_cannot_publish_schema_two(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, bundle, downloader = fixtures.BatchTests().setup_bundle(root, [book()])
            value.update(schemaVersion=2, targetTerritories=['RU'])
            self.assertEqual(publish(value, bundle, '019_pipeline', downloader, root), 0)
            self.assertFalse((root / 'apps/web/public').exists())

    def test_reusable_author_does_not_clear_a_new_edition(self):
        value, b, registry = cleared()
        self.assertEqual(clearance_blockers(value, b, registry), [])
        b['source']['url'] = 'https://ilibrary.ru/text/20/p.1/index.html'
        self.assertIn('rights-edition-changed', clearance_blockers(value, b, registry))

    def test_missing_translation_and_scope_and_weak_decisions_fail_closed(self):
        for change, expected in [
            (lambda v, b, r: b['clearance'].pop('translation'), 'rights-translation-unknown'),
            (lambda v, b, r: v['targetTerritories'].append('US'), 'rights-original'),
            (lambda v, b, r: r['records']['author'].update(author='Other'), 'rights-original-author'),
            (lambda v, b, r: r['records']['text'].update(status='pending'), 'rights-edition'),
            (lambda v, b, r: r['records']['text'].update(evidence=[]), 'rights-edition'),
            (lambda v, b, r: b['cover'].update(sha256='b' * 64), 'rights-cover-changed'),
            (lambda v, b, r: b.update(expectedSha256='b' * 64), 'rights-edition-changed'),
            (lambda v, b, r: r['records']['text'].update(reviewedAt='2999-01-01'), 'rights-edition'),
        ]:
            value, b, registry = cleared()
            change(value, b, registry)
            with self.subTest(expected=expected):
                self.assertIn(expected, clearance_blockers(value, b, registry))

    def test_translation_requires_its_own_decision_and_edition_binding(self):
        value, b, registry = cleared()
        b['clearance']['translation'] = 'translator'
        self.assertIn('rights-translation', clearance_blockers(value, b, registry))
        self.assertIn('rights-edition-changed', clearance_blockers(value, b, registry))

    def test_revocation_after_preparation_is_rechecked_by_publish(self):
        value, b, registry = cleared()
        b.pop('expectedSha256')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy, bundle, downloader = fixtures.BatchTests().setup_bundle(root, [b])
            b['expectedSha256'] = json.loads((bundle / 'report.json').read_text())['books'][0]['sha256']
            registry['records']['text']['textSha256'] = b['expectedSha256']
            registry['records']['cover']['status'] = 'excluded'
            self.assertEqual(publish(value, bundle, '019_pipeline', downloader, root, registry), 0)
            self.assertFalse((root / 'apps/web/public').exists())

    def test_excluded_book_never_downloads_and_stale_text_cannot_clear_it(self):
        value, b, registry = cleared()
        registry['records']['author']['status'] = 'excluded'
        with tempfile.TemporaryDirectory() as directory:
            downloader = Download({})
            report = prepare(value, directory, downloader, registry)
            self.assertEqual(report['summary']['excluded'], 1)
            self.assertEqual(downloader.requests, [])

    def test_cleared_schema_two_can_publish_with_reviewed_printed_cover(self):
        value, b, registry = cleared()
        b.pop('expectedSha256')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, bundle, downloader = fixtures.BatchTests().setup_bundle(root, [b])
            b['expectedSha256'] = json.loads((bundle / 'report.json').read_text())['books'][0]['sha256']
            registry['records']['text']['textSha256'] = b['expectedSha256']
            self.assertEqual(publish(value, bundle, '019_pipeline', downloader, root, registry), 1)
            self.assertTrue((root / 'apps/web/public/assets/cover-9.jpg').is_file())

    def test_wrong_cover_bytes_keep_prepared_text_out_of_ready(self):
        value, b, registry = cleared()
        b.pop('expectedSha256')
        downloader = Download({b['source']['url']: page(), b['cover']['url']: b'wrong-image'})
        content, _ = fixtures.import_book(b, downloader)
        b['expectedSha256'] = digest(json_bytes(content))
        registry['records']['text']['textSha256'] = b['expectedSha256']
        with tempfile.TemporaryDirectory() as directory:
            report = prepare(value, directory, downloader, registry)
            self.assertEqual(report['books'][0]['status'], 'prepared')
            self.assertEqual(report['books'][0]['coverStatus'], 'failed')
            self.assertEqual(report['summary']['ready'], 0)
            self.assertIn('cover-download', report['books'][0]['blockers'])


class PagesClearanceTests(unittest.TestCase):
    def setup_catalog(self, root):
        value, b, registry = cleared()
        catalog_path = root / 'apps/web/src/data/catalog.json'
        catalog_path.parent.mkdir(parents=True)
        catalog_path.write_bytes(json_bytes([{'id': b['id'], 'title': b['title'], 'author': b['author'],
            'version': b['version'], 'kind': 'full', 'cover': 9, 'sha256': b['expectedSha256']}]))
        cover = root / 'apps/web/public/assets/cover-9.jpg'
        cover.parent.mkdir(parents=True)
        cover.write_bytes(b'\xff\xd8\xffcover')
        batches = root / 'content/batches'
        batches.mkdir(parents=True)
        (batches / 'a-strict.json').write_bytes(json_bytes(value))
        legacy = copy.deepcopy(value)
        legacy['schemaVersion'] = 1
        (batches / 'z-legacy.json').write_bytes(json_bytes(legacy))
        (root / 'content/rights-registry.json').write_bytes(json_bytes(registry))
        return registry, cover

    def test_pages_cannot_bypass_revoked_registry_via_legacy_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry, _ = self.setup_catalog(root)
            self.assertEqual(len(approved_catalog(root)), 1)
            registry['records']['cover']['status'] = 'excluded'
            (root / 'content/rights-registry.json').write_bytes(json_bytes(registry))
            self.assertEqual(approved_catalog(root), [])

    def test_pages_rejects_changed_printed_cover(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, cover = self.setup_catalog(root)
            cover.write_bytes(b'other image')
            with self.assertRaisesRegex(ValueError, 'cover differs'):
                approved_catalog(root)


class ResumeTests(unittest.TestCase):
    def test_resume_reuses_text_but_recomputes_review_and_checks_cached_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            b = book()
            downloader = Downloader(root / 'cache', offline=True)
            cache = downloader.cache / digest(b['source']['url'].encode())
            cache.write_bytes(page())
            value = {'id': 'batch', 'schemaVersion': 1, 'books': [b]}
            output = root / 'output'
            first = prepare(value, output, downloader)
            b['review']['rightsApproved'] = False
            with patch('import_batch.import_book', side_effect=AssertionError('must not parse again')):
                second = prepare(value, output, downloader)
            self.assertEqual(first['summary']['reused'], 0)
            self.assertEqual(second['summary']['reused'], 1)
            self.assertIn('rights-review', second['books'][0]['blockers'])
            cache.write_bytes(page(body='<h2>I</h2><z>Changed.</z>'))
            third = prepare(value, output, downloader)
            self.assertEqual(third['summary']['reused'], 0)
            self.assertNotEqual(first['books'][0]['sha256'], third['books'][0]['sha256'])
            (output / 'test-book.json').write_text('{}')
            self.assertEqual(prepare(value, output, downloader)['summary']['reused'], 0)
            b['source']['edition'] = 'Different edition'
            self.assertEqual(prepare(value, output, downloader)['summary']['reused'], 0)

    def test_checkpoint_survives_interruption_before_final_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            b = book()
            d = Downloader(root / 'cache', offline=True)
            (d.cache / digest(b['source']['url'].encode())).write_bytes(page())
            value = {'id': 'batch', 'books': [b, book('second-book', 20)]}
            report = prepare(value, root / 'out', d)
            self.assertEqual(report['summary']['failed'], 1)
            (root / 'out/report.json').unlink()
            resumed = prepare(value, root / 'out', d)
            self.assertTrue(resumed['books'][0]['reused'])
            self.assertFalse(resumed['books'][1]['reused'])


class CoverDiscoveryTests(unittest.TestCase):
    def test_license_search_claim_never_becomes_an_approved_printed_cover(self):
        b = book()
        b['cover'] = None
        before = copy.deepcopy(b)
        response = {'query': {'pages': {'1': {'title': 'File:Maybe.jpg', 'imageinfo': [{
            'url': 'https://example.org/cover.jpg', 'mime': 'image/jpeg',
            'extmetadata': {'LicenseShortName': {'value': 'Public domain'}}}]}}}}
        downloader = Download({cover_search_url(b): json_bytes(response)})
        with tempfile.TemporaryDirectory() as directory:
            report = discover_covers({'id': 'batch', 'books': [b]}, directory, downloader)
            candidate = report['books'][0]['candidates'][0]
            self.assertFalse(candidate['rightsApproved'])
            self.assertFalse(candidate['printedEditionVerified'])
            self.assertEqual(b, before)


if __name__ == '__main__':
    unittest.main()
