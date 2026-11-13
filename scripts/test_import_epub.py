import tempfile
import unittest
import zipfile
from pathlib import Path
from import_epub import normalize

CONTAINER = '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
PACKAGE = '<package><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'
class ImportTests(unittest.TestCase):
    def run_book(self, html, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'book.epub'
            with zipfile.ZipFile(path,'w') as z:
                for name,body in {'mimetype':'application/epub+zip','META-INF/container.xml':CONTAINER,'OPS/book.opf':PACKAGE,'OPS/chapter.xhtml':html,**(extra or {})}.items():
                    z.writestr(name,body)
            return normalize(path,'test-book','1')
    def test_plain_text_and_cyrillic(self):
        result=self.run_book('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Глава</h1><p>Тихий <em>вечер</em>.</p><p>Вторая строка.</p></body></html>')
        self.assertEqual(result['chapters'][0]['paragraphs'][0],{'id':'ch-1-p-1','text':'Тихий вечер.'})
    def test_zip_escape(self):
        with self.assertRaises(ValueError): self.run_book('<html><body><p>Text</p></body></html>',{'../escape':'bad'})
    def test_scripts_rejected(self):
        with self.assertRaises(ValueError): self.run_book('<html><body><script>alert(1)</script><p>Text</p></body></html>')
    def test_entities_rejected(self):
        with self.assertRaises(ValueError): self.run_book('<!DOCTYPE html [<!ENTITY x "secret">]><html><body><p>&x;</p></body></html>')
    def test_external_spine_rejected(self):
        with self.assertRaises(ValueError): self.run_book('<html><body><p>Text</p></body></html>',{'OPS/book.opf':PACKAGE.replace('chapter.xhtml','https://example.com/book')})
    def test_images_explicitly_unsupported(self):
        with self.assertRaises(ValueError): self.run_book('<html><body><p>Text</p><img src="pic.png"/></body></html>')
if __name__=='__main__':unittest.main()
