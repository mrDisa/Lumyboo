-- Add the full Chekhov novella without modifying existing editions or reading data.
BEGIN;
INSERT INTO book_versions(book_id,version,title,author,genre,rights_status,rights_basis,content_hash,object_key) VALUES
 ('ward-no-6', '1', 'Палата № 6', 'Антон Чехов', 'Классика', 'approved', 'Русский оригинал — общественное достояние. Текст: Викитека, 19 закреплённых версий глав, по ПСС и писем в 30 т., Сочинения, т. 8 (Наука, 1977), с. 72–126; CC BY-SA 4.0. Пробелы нормализованы, современные примечания и их указатели исключены. Изображение — титульный лист второго издания «Посредника», Москва, 1894, Wikimedia Commons (Public Domain); это другое издание.', '103b25700c6bdabb5d350242c7bed08e37c6bee933ead2d3b3053f02e745d644', '/books/ward-no-6.json')
ON CONFLICT(book_id,version) DO NOTHING;
COMMIT;
