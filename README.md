# Lumyboo

PWA для чтения с дизайном Blanc/Noir из `design/Lumyboo-Monochrome`. На компьютере приложение сохраняет компактную рамку телефона. Это локальный пилот, не готовый публичный сервис.

## Запуск веб-приложения

Нужны Node.js 24+ и npm. Проверено на Node.js 26.7 / npm 11.19.

```sh
npm ci
npm run dev
```

Vite покажет локальный URL. В dev-режиме service worker отключён. Для проверки PWA:

```sh
npm run build
npm run preview
```

Открыть `http://127.0.0.1:4173`. В каталоге открыть тестовую книгу, скачать её, затем читать. Service worker работает на localhost или HTTPS. Для телефона нужен HTTPS-стенд; localhost компьютера не является localhost телефона.

## API и локальная инфраструктура

Нужны Go 1.26+ и запущенный Docker Desktop.

```sh
docker compose -f ops/compose.yaml up -d
# Применить миграцию; состояние БД не удаляется:
for migration in services/api/db/migrations/*.up.sql; do
  docker compose -f ops/compose.yaml exec -T postgres psql -U lumyboo -d lumyboo -v ON_ERROR_STOP=1 < "$migration"
done
export DATABASE_URL='postgres://lumyboo:local-development-only@127.0.0.1:5432/lumyboo?sslmode=disable'
npm run api
```

API: `http://127.0.0.1:8080/healthz`, `/readyz`, `/api/v1/catalog?q=Достоевский&limit=20&offset=0`. Без DATABASE_URL API каталога доступен, readiness возвращает 503. MinIO: `http://127.0.0.1:9001`, реквизиты только для разработки — в `ops/compose.yaml`. Веб пока использует локальный каталог; интеграция серверного каталога впереди. Worker/River ещё не реализован.

Compose не создаёт бакет автоматически; использование S3 появится с серверным импортом. Контейнер API можно собрать из `services/api/Dockerfile`. Секреты production не помещать в `.env.example` или compose.

## Вход по почте (локальная проверка)

В `ops/compose.yaml` есть Mailpit: SMTP `127.0.0.1:1025`, тестовый ящик `http://127.0.0.1:8025`. Письма не отправляются реальным получателям. Для входа примените обе миграции и запустите API с настройками из `.env.example`:

```sh
cp .env.example .env
set -a
. ./.env
set +a
export AUTH_SECRET="$(openssl rand -base64 32)"
npm run api
```

В отдельном терминале: `npm run dev`, затем `/login`. `PUBLIC_ORIGIN` должен точно совпадать с адресом Vite. Пустой `AUTH_SECRET` оставляет вход отключённым. Коды живут 10 минут, имеют 5 попыток; повторная отправка — не чаще раза в минуту, дополнительно действуют общие лимиты по email/IP. Для production нужен постоянный секрет в защищённой конфигурации, HTTPS и SMTP с обязательным STARTTLS; провайдер ещё не выбран. Plaintext SMTP разрешён только на loopback в development. За reverse proxy нужно явно настроить `TRUSTED_PROXY_CIDRS`; заголовок X-Forwarded-For от остальных источников игнорируется. После входа профиль показывает полку аккаунта. Кнопка «Скопировать гостевую полку» открывает список книг и аккаунт назначения; подтверждение добавляет книги на сервер, сохраняя прежнюю полку аккаунта и локальные данные. Повтор безопасен. Прогресс, закладки и последующие изменения гостевой полки пока не синхронизируются.

## Проверки

```sh
npm test
npm run build
npm run generate:api
node scripts/check-content.mjs
python3 -m unittest discover -s scripts -p 'test_*.py' -v
cd services/api
go test ./...
go vet ./...
go build ./cmd/api ./cmd/worker
```

## Импорт тестового EPUB

```sh
python3 scripts/import_epub.py content/fixtures/room-for-stories.epub \
  --id room-for-stories --version 1 \
  --output /tmp/room-for-stories.json \
  --rights-basis 'Original development fixture'
```

Импортёр пока поддерживает простой текстовый EPUB. Выводит размер и SHA-256; не публикует книгу. Список ограничений — в `docs/ARCHITECTURE.md`.

Документы: [архитектура](docs/ARCHITECTURE.md), [проверки чтения и PWA](docs/TESTING.md). План и внутренние журналы разработки хранятся локально и исключены из Git. Исходный прототип сохранён.
