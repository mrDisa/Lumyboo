-- Version metadata required by account reading foreign keys.
BEGIN;
INSERT INTO book_versions(book_id,version,title,author,genre,rights_status,rights_basis,content_hash,object_key) VALUES
 ('what-men-live-by', '1', 'Чем люди живы', 'Лев Толстой', 'Рассказы', 'approved', 'Русский оригинал — общественное достояние. Текст: Викитека, версия 4722178 (CC BY-SA 4.0); пробелы и деление на главы подготовлены для читалки. Изображение: титульный лист ПСС, т. 25, 1937, Wikimedia Commons (Public Domain).', '07cc9dc1ffbb6b7b30a6e3cc959cd546ecc454d881194cae84e80c282b7b92e3', '/books/what-men-live-by.json')
ON CONFLICT(book_id,version) DO NOTHING;
COMMIT;
