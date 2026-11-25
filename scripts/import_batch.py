#!/usr/bin/env python3
"""Prepare a reviewed book selection outside public/, then publish a whole batch.

prepare SELECTION --output DIR [--offline]
publish SELECTION --bundle DIR --migration 016_example

Preparation never edits the application. Publication requires explicit text,
rights and printed-cover records in the selection; blocked books stay private.
"""
import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlparse
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from import_epub import normalize, MAX_ARCHIVE

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,79}')
VOID = {'br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'embed', 'param', 'source', 'wbr'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in {'script', 'style', 'sup', 'fnb'}:
            return ''
        if self.tag in {'br', 'c'}:
            return '\n'
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children)


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, value):
        self.stack[-1].children.append(value)


def plain(value):
    return ' '.join(value.split())


class MissingPagination(ValueError):
    pass


def ilibrary_page(raw, single_page=False):
    source = raw.decode('cp1251')
    document = Document(source).root
    roots = [n for n in document.walk() if n.attrs.get('id') == 'text']
    if len(roots) != 1:
        raise ValueError('Expected one ilibrary text region')
    blocks = []

    def visit(node, epigraph=False):
        classes = node.attrs.get('class', '').split()
        if node.tag in {'script', 'style', 'sup', 'fnb', 'iframe'} or set(classes) & {'fns', 'author', 'title', 'thdr', 'bnvin'}:
            return
        if node.tag == 'span' and plain(node.text()) == '✦':
            return  # The source's end-of-text ornament, outside the literary body.
        epigraph = epigraph or 'epigraf' in classes
        leaf_epigraph = epigraph and node.tag == 'div' and not any(
            isinstance(c, Node) and c.tag in {'div', 'z', 'pms', 'pm'} for c in node.children)
        letter = set(classes) & {'letter_presignature', 'letter_signature', 'letter_date', 'letter_formaddress'}
        date = 'notes_date' in classes
        if node.tag in {'h2', 'h3', 'h4', 'z'} or leaf_epigraph or letter or date:
            text = plain(node.text())
            if text:
                blocks.append(('heading' if node.tag.startswith('h') or date else 'paragraph', text))
            return
        for child in node.children:
            if isinstance(child, Node):
                visit(child, epigraph)
            elif child.strip():
                if epigraph:
                    blocks.append(('paragraph', plain(child)))
                else:
                    raise ValueError(f'Unrecognized literary text inside <{node.tag}>: {plain(child)[:80]}')

    visit(roots[0])
    if not any(kind == 'paragraph' for kind, _ in blocks):
        raise ValueError('No supported literary paragraphs')
    nav = [n for n in document.walk() if n.attrs.get('id') == 'toc']
    pagination = re.fullmatch(r'(\d+)\s*/\s*(\d+)', plain(nav[0].text())) if len(nav) == 1 else None
    if not pagination and not single_page:
        raise MissingPagination('Missing page count; completeness requires review')
    if not pagination and not any(n.attrs.get('id') == 'tbtm' for n in document.walk()):
        raise ValueError('Missing source footer')
    current, total = map(int, pagination.groups()) if pagination else (1, 1)
    if not 1 <= current <= total <= 500:
        raise ValueError('Invalid page count')
    next_links = [n.attrs['href'] for n in document.walk()
                  if n.tag == 'a' and n.attrs.get('title') == 'Дальше' and 'href' in n.attrs]
    if len(next_links) > 1:
        raise ValueError('Ambiguous next page')
    return blocks, current, total, next_links[0] if next_links else None, 'перешло в общественное достояние' in source


def validate_content(content, book):
    if content.get('id') != book['id'] or content.get('version') != book['version'] or not content.get('chapters'):
        raise ValueError('Invalid content identity or no chapters')
    seen = set()
    for chapter in content['chapters']:
        if not chapter.get('title') or not chapter.get('paragraphs'):
            raise ValueError('Empty chapter')
        for item in [chapter, *chapter['paragraphs']]:
            if not ID.fullmatch(item['id']) or item['id'] in seen:
                raise ValueError('Invalid or duplicate locator')
            seen.add(item['id'])
        if any(not p.get('text', '').strip() for p in chapter['paragraphs']):
            raise ValueError('Empty paragraph')


def selection(path):
    value = json.loads(Path(path).read_text())
    if value.get('schemaVersion') != 1 or not ID.fullmatch(value['id']):
        raise ValueError('Unsupported selection')
    seen = set()
    for book in value['books']:
        if not ID.fullmatch(book['id']) or book['id'] in seen or not ID.fullmatch(book['version']):
            raise ValueError('Invalid or duplicate edition')
        seen.add(book['id'])
        for key in ('title', 'author', 'genre', 'year'):
            if not isinstance(book[key], str) or not book[key].strip():
                raise ValueError(f'Missing {key}')
    return value


class Downloader:
    def __init__(self, cache, offline=False):
        self.cache, self.offline = Path(cache), offline
        self.cache.mkdir(parents=True, exist_ok=True)
        self.last_request = 0

    def get(self, url, limit=8 * 1024 * 1024):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Source must be an HTTPS URL without credentials')
        path = self.cache / digest(url.encode())
        if not path.exists():
            if self.offline:
                raise ValueError(f'Source is not cached: {url}')
            time.sleep(max(0, 1 - (time.monotonic() - self.last_request)))
            with tempfile.NamedTemporaryFile(dir=self.cache) as temporary:
                subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                                '--proto', '=https', '--proto-redir', '=https',
                                '--retry', '2', '--retry-delay', '5', '--max-time', '60',
                                '--max-filesize', str(limit), '--output', temporary.name, url], check=True)
                self.last_request = time.monotonic()
                raw = Path(temporary.name).read_bytes()
                if len(raw) > limit:
                    raise ValueError('Source exceeds size limit')
                path.write_bytes(raw)
        raw = path.read_bytes()
        if len(raw) > limit:
            raise ValueError('Cached source exceeds size limit')
        return raw


def import_book(book, downloader):
    source = book['source']
    records = []
    if source['type'] == 'epub':
        raw = downloader.get(source['url'], MAX_ARCHIVE)
        with tempfile.NamedTemporaryFile(suffix='.epub') as temporary:
            Path(temporary.name).write_bytes(raw)
            content = normalize(temporary.name, book['id'], book['version'])
        records.append({'url': source['url'], 'sha256': digest(raw)})
    elif source['type'] == 'ilibrary':
        url = source['url']
        match = re.fullmatch(r'https://ilibrary.ru/text/(\d+)/p\.(\d+)/index.html', url)
        if not match or source['scope'] not in ('page', 'work'):
            raise ValueError('Unsupported ilibrary selection')
        work_id, first_page = match.groups()
        if source['scope'] == 'work' and first_page != '1':
            raise ValueError('A complete work must start at page 1')
        chapters, paragraphs, title = [], [], ''

        def flush():
            if paragraphs:
                number = len(chapters) + 1
                chapters.append({'id': f'ch-{number}', 'title': title or (book['title'] if not chapters else f'Раздел {number}'),
                                 'paragraphs': [{'id': f'ch-{number}-p-{i}', 'text': text}
                                                for i, text in enumerate(paragraphs, 1)]})
                paragraphs.clear()

        total = None
        extra_sources = []
        while url:
            if any(r['url'] == url for r in records):
                raise ValueError('Pagination loop')
            raw = downloader.get(url)
            try:
                blocks, current, pages, next_url, public_domain = ilibrary_page(raw)
            except MissingPagination:
                index_url = f'https://ilibrary.ru/text/{work_id}/index.html'
                index_raw = downloader.get(index_url)
                index = Document(index_raw.decode('cp1251')).root
                page_links = {urljoin(index_url, n.attrs['href']) for n in index.walk()
                              if n.tag == 'a' and re.search(r'/p\.\d+/index\.html$', n.attrs.get('href', ''))}
                if page_links != {source['url']} or source['scope'] != 'work' or first_page != '1':
                    raise ValueError('Cannot establish single-page completeness from source index')
                blocks, current, pages, next_url, public_domain = ilibrary_page(raw, single_page=True)
                extra_sources.append({'url': index_url, 'sha256': digest(index_raw), 'role': 'single-page-index'})
            if total is not None and total != pages:
                raise ValueError('Page count changed during import')
            total = pages
            expected = int(first_page) + len(records)
            if current != expected:
                raise ValueError('Missing or reordered source page')
            records.append({'url': url, 'sha256': digest(raw), 'page': current,
                            'totalPages': total, 'sourceDeclaresPublicDomain': public_domain})
            for kind, text in blocks:
                if kind == 'heading':
                    flush()
                    title = text
                else:
                    paragraphs.append(text)
            if source['scope'] == 'page':
                break
            if current == total:
                if next_url:
                    raise ValueError('Unexpected next page after end')
                break
            if not next_url:
                raise ValueError('Missing next page before end')
            url = urljoin(url, next_url)
            if url != f'https://ilibrary.ru/text/{work_id}/p.{current + 1}/index.html':
                raise ValueError('Next page leaves selected work')
        flush()
        records.extend(extra_sources)
        content = {'id': book['id'], 'version': book['version'], 'chapters': chapters}
    else:
        raise ValueError('Unsupported source adapter')
    validate_content(content, book)
    if book.get('expectedSha256') and digest(json_bytes(content)) != book['expectedSha256']:
        raise ValueError('Normalized text differs from the pinned edition')
    return content, records


def blockers(book):
    review = book.get('review', {})
    missing = []
    if review.get('textApproved') is not True:
        missing.append('text-review')
    if review.get('rightsApproved') is not True or not review.get('rightsBasis', '').strip():
        missing.append('rights-review')
    if not review.get('description', '').strip():
        missing.append('description')
    cover = book.get('cover') or {}
    if (cover.get('approved') is not True or not isinstance(cover.get('id'), int)
            or isinstance(cover.get('id'), bool) or cover['id'] < 6
            or not cover.get('url') or not cover.get('sourceUrl')
            or not cover.get('rightsBasis') or not re.fullmatch(r'[a-f0-9]{64}', cover.get('sha256', ''))):
        missing.append('printed-cover')
    return missing


def prepare(value, output, downloader):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for book in value['books']:
        row = {'id': book['id'], 'title': book['title'], 'author': book['author'], 'blockers': blockers(book)}
        try:
            content, sources = import_book(book, downloader)
            raw = json_bytes(content)
            (output / f'{book["id"]}.json').write_bytes(raw)
            row.update(status='prepared', sha256=digest(raw), bytes=len(raw), sources=sources,
                       chapters=len(content['chapters']), paragraphs=sum(len(c['paragraphs']) for c in content['chapters']))
        except (ValueError, OSError, KeyError, ParseError, BadZipFile, subprocess.SubprocessError) as error:
            row.update(status='failed', error=str(error))
        rows.append(row)
        print(f'{row["status"]}: {book["id"]}', flush=True)
    report = {'schemaVersion': 1, 'batch': value['id'], 'books': rows}
    (output / 'report.json').write_bytes(json_bytes(report))
    body = ''.join('<tr>' + ''.join(f'<td>{html.escape(str(cell))}</td>' for cell in
                   [r['title'], r['author'], r['status'], r.get('chapters', '—'), r.get('paragraphs', '—'), ', '.join(r['blockers']), r.get('error', '')]) + '</tr>' for r in rows)
    (output / 'report.html').write_text('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Подготовка книг</title>'
        '<style>body{font:16px system-ui;margin:32px;line-height:1.5}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:10px;text-align:left}th{background:#eee}</style>'
        f'<h1>Подготовка партии {html.escape(value["id"])}</h1><p>Подготовлено {sum(r["status"] == "prepared" for r in rows)} из {len(rows)}. '
        'Этот отчёт фиксирует подготовку; команда prepare не публикует книги. Для допуска заполните проверку текста, основания использования, описание и сведения о печатной обложке в подборке.</p>'
        '<table><thead><tr><th>Книга</th><th>Автор</th><th>Результат</th><th>Разделы</th><th>Абзацы</th><th>Что проверить</th><th>Ошибка</th></tr></thead>'
        f'<tbody>{body}</tbody></table></html>')
    return report


def publish(value, bundle, migration, downloader, root=ROOT):
    """Preflight every eligible book before editing any repository file."""
    if not re.fullmatch(r'\d{3}_[a-z0-9_]+', migration):
        raise ValueError('Invalid migration name')
    bundle, root = Path(bundle), Path(root)
    report = json.loads((bundle / 'report.json').read_text())
    if report.get('batch') != value['id']:
        raise ValueError('Wrong batch report')
    rows = {r['id']: r for r in report['books']}
    web = root / 'apps/web/src/data/catalog.json'
    api = root / 'services/api/internal/httpapi/catalog.json'
    catalog = json.loads(web.read_text())
    if json.loads(api.read_text()) != catalog:
        raise ValueError('Existing web/API catalogs differ')
    by_id = {b['id']: b for b in catalog}
    files, additions = {}, []
    cover_hashes = {}
    for book in value['books']:
        if blockers(book):
            continue
        row = rows.get(book['id'], {})
        if row.get('status') != 'prepared':
            raise ValueError(f'No prepared content: {book["id"]}')
        raw = (bundle / f'{book["id"]}.json').read_bytes()
        if digest(raw) != row['sha256'] or len(raw) != row['bytes']:
            raise ValueError(f'Prepared content changed: {book["id"]}')
        content = json.loads(raw)
        validate_content(content, book)
        # A selection may be edited for review, but its source must still match.
        original, sources = import_book(book, downloader)
        if json_bytes(original) != raw or sources != row['sources']:
            raise ValueError(f'Source selection changed: {book["id"]}')
        cover = book['cover']
        cover_raw = downloader.get(cover['url'])
        if digest(cover_raw) != cover['sha256']:
            raise ValueError('Cover must match the reviewed source hash')
        # Preserve the source hash when a printed PNG page needs JPEG encoding.
        # The reviewed derivative is tracked separately; arbitrary local paths
        # and an unpinned conversion must never enter the publication.
        if cover.get('jpeg'):
            jpeg = cover['jpeg']
            if (not cover_raw.startswith(b'\x89PNG\r\n\x1a\n')
                    or not re.fullmatch(r'content/covers/[a-z0-9-]+\.jpg', jpeg.get('file', ''))
                    or not re.fullmatch(r'[a-f0-9]{64}', jpeg.get('sha256', ''))
                    or not jpeg.get('transformation', '').strip()):
                raise ValueError('Invalid reviewed JPEG derivative')
            derivative = root / jpeg['file']
            if not derivative.resolve().is_relative_to((root / 'content/covers').resolve()):
                raise ValueError('Invalid reviewed JPEG derivative path')
            cover_raw = derivative.read_bytes()
            if digest(cover_raw) != jpeg['sha256']:
                raise ValueError('Reviewed JPEG derivative changed')
        if not cover_raw.startswith(b'\xff\xd8\xff'):
            raise ValueError('Cover must match the reviewed JPEG hash')
        cover_path = root / f'apps/web/public/assets/cover-{cover["id"]}.jpg'
        if (cover_path in cover_hashes and cover_hashes[cover_path] != digest(cover_raw)) or (cover_path.exists() and cover_path.read_bytes() != cover_raw):
            raise ValueError('Cover number collision')
        cover_hashes[cover_path] = digest(cover_raw)
        manifest = {k: book[k] for k in ('id', 'title', 'author', 'genre', 'year', 'version')}
        manifest.update(cover=cover['id'], description=book['review']['description'], kind='full',
                        url=f'/books/{book["id"]}.json', sha256=digest(raw), bytes=len(raw),
                        rights=book['review']['rightsBasis'] + ' Обложка: ' + cover['rightsBasis'],
                        sourceUrl=book['source']['url'], coverSourceUrl=cover['sourceUrl'])
        if book['source'].get('licenseUrl'):
            manifest['licenseUrl'] = book['source']['licenseUrl']
        if book['id'] in by_id:
            if by_id[book['id']] != manifest or (root / f'apps/web/public{manifest["url"]}').read_bytes() != raw:
                raise ValueError('Refusing to replace an existing edition; use a separate edition ID')
            continue
        content_path = root / f'apps/web/public{manifest["url"]}'
        if content_path.exists():
            raise ValueError('Unregistered content file collision')
        files[content_path] = raw
        files[cover_path] = cover_raw
        additions.append(manifest)
    if not additions:
        return 0
    migrations = root / 'services/api/db/migrations'
    if any(migrations.glob(migration.split('_')[0] + '_*')):
        raise ValueError('Migration number already exists')
    catalog += additions
    files[web] = files[api] = json_bytes(catalog)
    locations = {}
    for book in catalog:
        path = root / f'apps/web/public{book["url"]}'
        content = json.loads(files[path] if path in files else path.read_bytes())
        validate_content(content, book)
        locations[book['id']] = {'version': book['version'], 'chapters': [[p['id'] for p in c['paragraphs']] for c in content['chapters']]}
    files[root / 'services/api/internal/httpapi/bookmark-locations.json'] = json_bytes(locations)
    attribution = []
    added_ids = {b['id'] for b in additions}
    for book in value['books']:
        if book['id'] in added_ids:
            attribution.append({'id': book['id'], 'version': book['version'], 'title': book['title'],
                                'author': book['author'], 'source': book['source'],
                                'sourceFiles': rows[book['id']]['sources'],
                                'textSha256': rows[book['id']]['sha256'],
                                'rightsBasis': book['review']['rightsBasis'], 'cover': book['cover']})
    attribution_path = root / f'docs/content-batches/{value["id"]}.json'
    existing_attribution = json.loads(attribution_path.read_text()) if attribution_path.exists() else []
    files[attribution_path] = json_bytes(existing_attribution + attribution)
    quote = lambda text: "'" + text.replace("'", "''") + "'"
    values = []
    for b in additions:
        values.append(' (' + ', '.join(quote(s) for s in [b['id'], b['version'], b['title'], b['author'], b['genre'], 'approved', b['rights'], b['sha256'], b['url']]) + ')')
    files[migrations / f'{migration}.up.sql'] = ('BEGIN;\nINSERT INTO book_versions(book_id,version,title,author,genre,rights_status,rights_basis,content_hash,object_key) VALUES\n' + ',\n'.join(values) + '\nON CONFLICT(book_id,version) DO NOTHING;\nCOMMIT;\n').encode()
    files[migrations / f'{migration}.down.sql'] = ('-- Foreign keys refuse rollback when reading data references these editions.\nBEGIN;\n' + ''.join(f'DELETE FROM book_versions WHERE book_id={quote(b["id"])} AND version={quote(b["version"])} AND published_at IS NULL;\n' for b in additions) + 'COMMIT;\n').encode()
    previous = {path: path.read_bytes() if path.exists() else None for path in files}
    try:
        for path, raw in files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    except OSError:
        for path, raw in previous.items():
            if raw is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(raw)
        raise
    return len(additions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('prepare', 'publish'):
        sub = commands.add_parser(command)
        sub.add_argument('selection', type=Path)
        sub.add_argument('--cache', type=Path, default=ROOT / '.content-staging/cache')
        sub.add_argument('--offline', action='store_true')
        sub.add_argument('--output' if command == 'prepare' else '--bundle', type=Path, required=True)
        if command == 'publish':
            sub.add_argument('--migration', required=True)
    args = parser.parse_args()
    value = selection(args.selection)
    destination = (args.output if args.command == 'prepare' else args.bundle).resolve()
    public = (ROOT / 'apps/web/public').resolve()
    if destination == public or public in destination.parents or args.cache.resolve() == public or public in args.cache.resolve().parents:
        parser.error('Staging and cache must be outside public/')
    downloader = Downloader(args.cache, args.offline)
    if args.command == 'prepare':
        report = prepare(value, destination, downloader)
        failures = sum(row['status'] == 'failed' for row in report['books'])
        print(f'Prepared {len(report["books"]) - failures}/{len(report["books"])}. Report: {destination / "report.html"}')
        raise SystemExit(1 if failures else 0)
    print(f'Published {publish(value, destination, args.migration, downloader)} new editions; unreviewed books were excluded.')


if __name__ == '__main__':
    main()
