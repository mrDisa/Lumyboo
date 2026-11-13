# Графика и шрифты

Графика и шрифты перенесены из предоставленного пользователем утверждённого прототипа. Файлы дизайна сохранены без изменения. SVG-знак и обложки выделены в отдельные файлы, снабжены XML namespace для использования через `<img>`. Обложка тестовой книги адаптирована с корректными названием и маркировкой.

Manrope, Literata и Unbounded используются локально, без обращения браузера к Google Fonts. Лицензии SIL Open Font License сохранены в `apps/web/public/licenses` из официального репозитория Google Fonts:

- https://github.com/google/fonts/blob/main/ofl/manrope/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/literata/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/unbounded/OFL.txt

Исходные embedded font payload сохранены как font-1.ttf … font-11.ttf. Они соответствуют семействам и начертаниям, указанным в CSS прототипа. Перед публичным запуском следует зафиксировать происхождение конкретных версий файлов и проверить комплектность уведомлений об авторских правах.
