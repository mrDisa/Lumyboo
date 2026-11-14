# Закрытый HTTPS-стенд

Это комплект для будущего размещения, а не действующий адрес. Нужны Linux VPS
с Docker Compose v2.24.4+, отдельный поддомен с A/AAAA на этот сервер, входящие
TCP 80/443 и тестовый SMTP с STARTTLS. Не указывайте AAAA без работающего IPv6.
Требуются исходящие DNS, HTTPS для сертификатов и соединения к SMTP.
Используйте вымышленные аккаунты и отдельные реквизиты; письма здесь настоящие.

Gateway раздаёт production-сборку и проксирует `/api/*` без смены origin.
Весь сайт, API и проверки здоровья закрыты HTTP Basic Auth поверх HTTPS.
Caddy получает и продлевает сертификат; `/data` с сертификатами сохраняется.
Пароль доступа к стенду отличается от входа в аккаунт Lumyboo. Клиентская PWA
может сохранить оболочку и книги после входа: Basic Auth не удаляет уже
скачанные данные и не заменяет выход из аккаунта приложения.
Основа конфигурации: [Automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth),
[SPA и API](https://caddyserver.com/docs/caddyfile/patterns#single-page-apps-spas).

## Подготовка

Размещайте отдельный чистый checkout нужного коммита, а не рабочий каталог с
незавершёнными изменениями. Команды ниже выполняются из корня этого checkout.
Порты API/PostgreSQL наружу не публикуются; Mailpit и MinIO здесь отсутствуют.
Сеть `172.30.84.0/29` должна быть свободна. При изменении подсети одновременно
исправьте IP gateway и `TRUSTED_PROXY_CIDRS`: API доверяет только адресу gateway.

```sh
cp ops/staging/.env.example ops/staging/.env
chmod 600 ops/staging/.env
openssl rand -hex 32
openssl rand -base64 32
docker run --rm -it caddy:2.11.2-alpine caddy hash-password
```

Впишите домен без схемы/пути, имя доступа, bcrypt-хеш (в одинарных кавычках),
случайный hex-пароль БД, base64-секрет и SMTP в `.env`. Не коммитьте этот файл.
SMTP_ALLOW_INSECURE выключен; обычный локальный Mailpit не подходит.
Пустые обязательные значения останавливают Compose до запуска. Не публикуйте
вывод `docker compose config`: он содержит секреты. Проверка без вывода:

```sh
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml config --quiet
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml build
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml up -d --wait postgres
```

Только для **новой пустой БД** примените все миграции один раз. При любой ошибке
остановитесь; не запускайте API с частичной схемой. Скрипты не идемпотентны.

```sh
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml exec -T postgres sh -ec '
  for migration in /migrations/*.up.sql; do
    psql -U lumyboo -d lumyboo -v ON_ERROR_STOP=1 -f "$migration"
  done
'
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml up -d
```

## Проверка перед передачей на телефоны

Подставьте свой домен и пользователя. curl запросит пароль, без записи его в
историю команд. Не используйте `-k`: устройство должно доверять сертификату.

```sh
curl -I https://staging.example.com/
curl --user reader https://staging.example.com/readyz
curl --user reader https://staging.example.com/api/v1/auth/session
```

Ожидается: без доступа 401 с `WWW-Authenticate`; readiness 200; API с доступом
к стенду, но без аккаунтной cookie — JSON 401, а не HTML приложения. Проверьте
также `/profile` (SPA), `/sw.js` и отсутствие HTML при запросе несуществующей
книги `/books/missing.json`. Затем в браузере пройдите OTP-вход тестовым email;
cookie `__Host-lumyboo_session` должна иметь Secure, HttpOnly, Path=/, SameSite=Lax.
Чужой Origin должен давать 403 для изменяющих запросов с доступом к стенду.

На Android и iPhone откройте один домен, войдите в один тестовый аккаунт и
выполните сценарий 1 из локального плана и пути из [TESTING.md](../../docs/TESTING.md):
гость → явный перенос → второе устройство → чтение/закладки → возврат;
потеря сети/повтор, истёкший вход и вход другим аккаунтом. Отдельно проверьте
установленную PWA: передаются ли реквизиты стенда при запросах service worker.
Не считать установку, offline или приёмку C подтверждёнными только по curl.
В каталоге пока технические тестовые тексты, не приёмочная библиотека.

## Локальная проверка комплекта

Для проверки без VPS используйте отдельный чистый checkout и проект Compose
`--project-name lumyboo-staging-check` во **всех** командах. В его `.env` укажите
`STAGING_HOST=localhost:18443`, одноразовые секреты и тестовый SMTP. Для проверки
запуска/readiness можно оставить недоступный `smtp.example.com:587`: отправку
писем и вход это не проверяет. Создайте временный `ops/staging/check.yaml`:

```yaml
services:
  gateway:
    ports: !override ["127.0.0.1:18443:18443"]
```

Добавляйте `-f ops/staging/check.yaml` после основного compose-файла. Так все
публикуемые порты привязаны только к loopback, без публичного доступа. Выполните
сборку, запуск новой БД, миграции и запуск остальных сервисов, как выше.
Caddy автоматически использует локальный CA для localhost. Скопируйте только
публичный сертификат CA (не устанавливайте его глобально):

```sh
docker compose --project-name lumyboo-staging-check --env-file ops/staging/.env -f ops/staging/compose.yaml -f ops/staging/check.yaml cp gateway:/data/caddy/pki/authorities/local/root.crt /tmp/lumyboo-staging-ca.crt
curl --cacert /tmp/lumyboo-staging-ca.crt --user reader https://localhost:18443/readyz
```

Повторите проверки путей из предыдущего раздела с этим адресом и `--cacert`.
Проверка локального CA не подтверждает выпуск публичного сертификата, SMTP,
вход или работу установленной PWA на телефоне. После проверки остановите именно
проект `lumyboo-staging-check`; одноразовые тома можно удалить с `down -v`, убедившись,
что в каждой команде явно указан этот проект. Удалите временные секреты и override.

## Обновление и остановка

Перед обновлением сохраните зашифрованную копию `.env`, дамп БД и исходный
commit ID. Дамп содержит личные данные; храните вне checkout с закрытым доступом.

```sh
umask 077
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml exec -T postgres pg_dump -U lumyboo -d lumyboo -Fc > /secure/backup/lumyboo-staging.dump
```

Для обновления остановите gateway/api, примените **только новые** миграции после
проверки на копии БД, пересоберите и запустите сервисы. Старый образ не является
откатом несовместимой схемы: нужен проверенный план возврата БД. Не меняйте пароль
существующей БД одной правкой `.env`: POSTGRES_PASSWORD инициализирует только новый
том. Сохраняйте AUTH_SECRET между перезапусками. Не включайте логирование тел
запросов, SMTP-кодов и cookie.

```sh
docker compose --env-file ops/staging/.env -f ops/staging/compose.yaml down
```

`down` сохраняет тома. Не добавляйте `-v`, если данные нужны. Удаление тестового
стенда и его данных выполняется отдельно после проверки, что выбран нужный проект.
