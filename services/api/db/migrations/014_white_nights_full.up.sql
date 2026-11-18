-- Add a separate full edition; preserve the prototype excerpt and all reading data.
BEGIN;
INSERT INTO book_versions(book_id,version,title,author,genre,rights_status,rights_basis,content_hash,object_key) VALUES
 ('white-nights', '1', 'Белые ночи', 'Фёдор Достоевский', 'Классика', 'approved', 'Русский оригинал — общественное достояние. Текст: Викитека, версия 5783311, по собранию сочинений в 15 т., т. 2 (Наука, 1988), CC BY-SA 4.0. Пробелы нормализованы; комментарии не включены. Изображение — титульный лист отдельного издания 1865 года, Wikimedia Commons (Public Domain); это другое издание.', 'b1c52426306ad0e50f9e6a56a6cbcc76d1c5faad6cfc13f8a66bb273468e355e', '/books/white-nights.json')
ON CONFLICT(book_id,version) DO NOTHING;
COMMIT;
