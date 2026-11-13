#!/usr/bin/env python3
"""Trusted editor CLI: EPUB -> plain-text chapter JSON. Never runs book HTML.
Images, complex layout and footnote navigation are not supported by this first spike.
"""
import argparse
import hashlib
import json
import posixpath
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

MAX_ARCHIVE = 20 * 1024 * 1024
MAX_UNPACKED = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024


def xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('DTD and entity declarations are not supported')
    return ET.fromstring(raw)


def resolve(base, relative):
    if not relative or re.search(r'[:\\?#]', relative) or relative.startswith('/'):
        raise ValueError('Only internal relative EPUB paths are supported')
    result = posixpath.normpath(posixpath.join(base, relative))
    if result.startswith('../') or result == '..':
        raise ValueError('Resource escapes archive root')
    return result


def normalize(path, book_id, version):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', book_id):
        raise ValueError('Invalid book id')
    if Path(path).stat().st_size > MAX_ARCHIVE:
        raise ValueError('Archive is too large')
    with zipfile.ZipFile(path) as archive:
        names = set()
        total = 0
        for info in archive.infolist():
            name = info.filename
            if name in names or name.startswith('/') or '\\' in name or '..' in PurePosixPath(name).parts:
                raise ValueError('Duplicate or unsafe archive path')
            names.add(name)
            if info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Encrypted entries and symlinks are not supported')
            total += info.file_size
            if info.file_size > MAX_FILE or total > MAX_UNPACKED or len(names) > 2000:
                raise ValueError('Unpacked EPUB exceeds limits')
        if archive.read('mimetype').strip() != b'application/epub+zip':
            raise ValueError('Not an EPUB archive')
        container = xml(archive.read('META-INF/container.xml'))
        rootfile = container.find('.//{*}rootfile')
        if rootfile is None:
            raise ValueError('Missing package document')
        package_path = resolve('', rootfile.attrib['full-path'])
        package = xml(archive.read(package_path))
        if 'META-INF/encryption.xml' in names:
            raise ValueError('Encrypted EPUB is not supported')
        manifest = {item.attrib['id']: item for item in package.findall('.//{*}manifest/{*}item')}
        chapters = []
        for ref in package.findall('.//{*}spine/{*}itemref'):
            if ref.attrib.get('linear', 'yes') == 'no':
                continue
            item = manifest[ref.attrib['idref']]
            if item.attrib.get('media-type') != 'application/xhtml+xml':
                raise ValueError('Spine must contain XHTML text')
            document = xml(archive.read(resolve(posixpath.dirname(package_path), item.attrib['href'])))
            body = document.find('.//{*}body')
            if body is None:
                raise ValueError('Missing chapter body')
            unsupported = {'script', 'iframe', 'object', 'embed', 'img', 'svg', 'math', 'audio', 'video', 'table'}
            for el in body.iter():
                tag = el.tag.rsplit('}', 1)[-1].lower()
                if tag in unsupported:
                    raise ValueError(f'Unsupported chapter element: {tag}')
            number = len(chapters) + 1
            headings = [el for el in body.iter() if el.tag.rsplit('}', 1)[-1] in ('h1', 'h2')]
            title = ' '.join(''.join(headings[0].itertext()).split()) if headings else f'Глава {number}'
            paragraphs = []
            for el in body.iter():
                if el.tag.rsplit('}', 1)[-1] not in ('p', 'li', 'h3', 'h4', 'h5', 'h6'):
                    continue
                text = ' '.join(''.join(el.itertext()).split())
                if text:
                    paragraphs.append({'id': f'ch-{number}-p-{len(paragraphs)+1}', 'text': text})
            if not paragraphs:
                raise ValueError('Chapter has no supported paragraphs')
            chapters.append({'id': f'ch-{number}', 'title': title, 'paragraphs': paragraphs})
        if not chapters:
            raise ValueError('EPUB has no linear chapters')
        return {'id': book_id, 'version': version, 'chapters': chapters}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('epub', type=Path)
    parser.add_argument('--id', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--rights-basis', required=True, help='Editorial record; this CLI does not approve publication rights')
    args = parser.parse_args()
    content = normalize(args.epub, args.id, args.version)
    raw = json.dumps(content, ensure_ascii=False, indent=2).encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(raw)
    print(json.dumps({'id': args.id, 'version': args.version, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rights_status': 'pending', 'rights_basis': args.rights_basis}, ensure_ascii=False))


if __name__ == '__main__':
    main()
