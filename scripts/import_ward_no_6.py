"""Import the literary text from 19 pinned Wikisource chapter revisions.

Save each revision as I.html ... XIX.html in SOURCE_DIR, then run:
python3 scripts/import_ward_no_6.py SOURCE_DIR OUTPUT.json
Modern editorial notes and reference markers are excluded.
"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

SOURCES = [
    ('I', 5646963, 12), ('II', 5646638, 5), ('III', 5647275, 8),
    ('IV', 5646644, 11), ('V', 5647280, 12), ('VI', 1460473, 35),
    ('VII', 1460474, 8), ('VIII', 5646629, 2), ('IX', 1460476, 60),
    ('X', 1460477, 42), ('XI', 5646664, 9), ('XII', 5646631, 31),
    ('XIII', 5646659, 9), ('XIV', 5647273, 24), ('XV', 5646675, 11),
    ('XVI', 5646669, 38), ('XVII', 5646645, 18), ('XVIII', 5646655, 30),
    ('XIX', 5646797, 7),
]


class LiteraryText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.level = None
        self.parts = None
        self.reference = 0
        self.paragraphs = []
        self.sections = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div':
            self.depth += 1
            if attrs.get('class') == 'indent':
                self.level = self.depth
                self.sections += 1
        if self.level and tag == 'p':
            if self.parts is not None:
                raise ValueError('Unexpected nested paragraph')
            self.parts = []
        if self.parts is not None:
            if tag == 'sup':
                if 'reference' not in attrs.get('class', '').split():
                    raise ValueError('Unexpected superscript in literary text')
                self.reference += 1
            if tag == 'br':
                self.parts.append(' ')

    def handle_data(self, data):
        if self.parts is not None and not self.reference:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'sup' and self.reference:
            self.reference -= 1
        if tag == 'p' and self.parts is not None:
            text = re.sub(r'\s+', ' ', ''.join(self.parts)).strip()
            if text:
                self.paragraphs.append(text)
            self.parts = None
        if tag == 'div':
            if self.level == self.depth:
                self.level = None
            self.depth -= 1


def extract(directory):
    chapters = []
    for number, (roman, revision, count) in enumerate(SOURCES, 1):
        source = (Path(directory) / f'{roman}.html').read_text()
        if not re.search(rf'"wgRevisionId":{revision}\b', source):
            raise ValueError(f'Expected revision {revision} for chapter {roman}')
        if 'creativecommons.org/licenses/by-sa/4.0/' not in source:
            raise ValueError('Missing source license notice')
        parser = LiteraryText()
        parser.feed(source)
        if (parser.sections != 1 or parser.level is not None
                or parser.parts is not None or parser.reference
                or len(parser.paragraphs) != count):
            raise ValueError(f'Source structure changed for chapter {roman}')
        chapters.append({
            'id': f'ch-{number}', 'title': f'Глава {roman}',
            'paragraphs': [{'id': f'ch-{number}-p-{i}', 'text': text}
                           for i, text in enumerate(parser.paragraphs, 1)],
        })
    return {'id': 'ward-no-6', 'version': '1', 'chapters': chapters}


if __name__ == '__main__':
    content = extract(sys.argv[1])
    Path(sys.argv[2]).write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n')
