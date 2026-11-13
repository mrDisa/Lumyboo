-- Unpublished metadata for the existing local pilot catalog; grants no rights.
BEGIN;
INSERT INTO book_versions(book_id,version,title,author,genre,rights_status,rights_basis,content_hash,object_key) VALUES
 ('room-for-stories', '1', 'Комната для историй', 'Тестовая библиотека Lumyboo', 'Рассказы', 'development_fixture', 'Оригинальный тестовый текст, сгенерированный при разработке Lumyboo. Только локальный пилот; не заменяет проверку каталога перед запуском.', '283345d10e222fa5b3d0b17e861ff2935c684a53ebb9834121742b7d3d4b617c', '/books/room-for-stories.json'),
 ('white-nights-excerpt', '1', 'Белые ночи', 'Фёдор Достоевский', 'Классика', 'pending', 'Фрагмент из предоставленного прототипа. Публикация требует отдельной проверки прав.', '45f540ae83224fa3add1c0ab128a5d63b5eec5847c5faf3872b250b93d559ad6', '/books/white-nights-excerpt.json'),
 ('gambler-excerpt', '1', 'Игрок', 'Фёдор Достоевский', 'Классика', 'pending', 'Фрагмент из предоставленного прототипа. Публикация требует отдельной проверки прав.', 'afa67cd93ae5ad48e3f0df67e243e9d64fe0344bb8d534ac115f528eb59b0dae', '/books/gambler-excerpt.json')
ON CONFLICT(book_id,version) DO NOTHING;
COMMIT;
