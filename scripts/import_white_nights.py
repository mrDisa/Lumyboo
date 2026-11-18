"""Extract the literary text from Wikisource revision 5783311 (local HTML).

Usage: python3 scripts/import_white_nights.py SOURCE.html OUTPUT.json
The source edition includes modern commentary; it is deliberately excluded.
"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

TITLES = ['Эпиграф', 'Ночь первая', 'Ночь вторая', 'История Настеньки',
          'Ночь третья', 'Ночь четвертая', 'Утро']
COUNTS = [1, 53, 60, 84, 56, 94, 22]


class LiteraryText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.stopped = False
        self.capture = None
        self.parts = []
        self.sections = [{'title': 'Эпиграф', 'texts': []}]

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div' and attrs.get('class') == 'text':
            self.active = True
        if not self.active or self.stopped:
            return
        if tag == 'h2':
            if attrs.get('id') != 'Комментарии':
                raise ValueError('Unexpected end of literary text')
            self.stopped = True
            return
        if tag in ('p', 'h3'):
            if self.capture:
                raise ValueError('Unexpected nested paragraph')
            self.capture = tag
            self.parts = []
        if tag == 'br' and self.capture:
            self.parts.append('\n')

    def handle_data(self, data):
        if self.active and not self.stopped and self.capture:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag != self.capture:
            return
        value = re.sub(r'\s+', ' ', ''.join(self.parts)).strip()
        if tag == 'h3':
            self.sections.append({'title': value, 'texts': []})
        elif value:
            self.sections[-1]['texts'].append(value)
        self.capture = None
        self.parts = []


def extract(source):
    if 'oldid=5783311' not in source or 'creativecommons.org/licenses/by-sa/4.0/' not in source:
        raise ValueError('Expected Wikisource revision 5783311 with CC BY-SA notice')
    parser = LiteraryText()
    parser.feed(source)
    if not parser.stopped or [s['title'] for s in parser.sections] != TITLES or [len(s['texts']) for s in parser.sections] != COUNTS:
        raise ValueError('Source structure changed; review before importing')
    parser.sections[0]['texts'][0] += ' Ив. Тургенев'
    return {'id': 'white-nights', 'version': '1', 'chapters': [
        {'id': f'ch-{i}', 'title': section['title'], 'paragraphs': [
            {'id': f'ch-{i}-p-{j}', 'text': text}
            for j, text in enumerate(section['texts'], 1)]}
        for i, section in enumerate(parser.sections, 1)]}


if __name__ == '__main__':
    content = extract(Path(sys.argv[1]).read_text())
    Path(sys.argv[2]).write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n')
