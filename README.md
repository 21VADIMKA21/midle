# Fusion Music

Веб-сервис музыкальных заявок для Twitch-канала Fusion.

## Текущий статус

Интерфейс пока остаётся прототипом. Серверные маршруты Twitch OAuth и публичной очереди уже реализованы, подготовлены PostgreSQL-схема, миграции, зашифрованное хранение токенов и серверные сессии. Но production-БД и Twitch-приложение ещё не подключены через реальные секреты, поэтому вход и очередь пока не работают в развёрнутом сервисе. Музыкальный источник и локальный проигрыватель ещё не подключены.

Архитектурные решения и ограничения музыкальных источников описаны в [документе архитектуры](docs/architecture/overview.md).

## Требования

- Node.js 22 LTS (minimum supported by Next.js 16: 20.9+)
- PostgreSQL 14+
- npm

## Локальный запуск

```bash
npm ci
cp .env.example .env
```

Настройте PostgreSQL, затем создайте приложение в [Twitch Developer Console](https://dev.twitch.tv/console/apps). В Twitch OAuth Redirect URL укажите точно тот адрес, который будет записан в `TWITCH_REDIRECT_URI`.

В `.env` заполните:
- `DATABASE_URL` — строка подключения к PostgreSQL;
- `TWITCH_BROADCASTER_ID` — числовой Twitch user ID основного канала Fusion;
- `TWITCH_CLIENT_ID` и `TWITCH_CLIENT_SECRET` — данные Twitch-приложения;
- `TWITCH_REDIRECT_URI` — например, `http://localhost:3000/api/auth/callback`;
- `APP_URL` — необязательный базовый адрес сайта (по умолчанию определяется из запроса);
- `TOKEN_ENCRYPTION_KEY` — ключ шифрования, сгенерированный командой `openssl rand -base64 32`.

Не публикуйте эти значения и не меняйте ключ шифрования после сохранения Twitch-токенов: без старого ключа их нельзя будет расшифровать.

Затем примените миграции и запустите приложение:

```bash
npm run db:migrate
npm run dev
```

Откройте http://localhost:3000.

Проверка сервиса и соединения с БД доступна по адресу `/api/health`. При отсутствии настроенной БД endpoint вернёт HTTP 503 и статус `degraded`.

## Что уже подготовлено

- Next.js / React / TypeScript интерфейс.
- PostgreSQL schema для каналов, пользователей, ролей, треков, заявок, очереди, голосов, локальных плееров, аудита, Twitch-токенов и сессий.
- Twitch OAuth Authorization Code Flow, шифрование токенов AES-256-GCM и непрозрачные серверные сессии.
- Endpoints входа/выхода и проверки сессии: `/api/auth/twitch`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`.
- Публичный endpoint чтения очереди `/api/queue` (без фиктивных демо-треков).
- Серверная основа локального проигрывателя: pairing, безопасные device-токены, команды с подтверждением, heartbeat и события начала/окончания трека.
- Панель владельца `/dashboard` для подключения и отключения одного локального проигрывателя.
- Владелец канала определяется только по `TWITCH_BROADCASTER_ID`; обычный зритель не может назначить себя владельцем.
- Постоянные Twitch OAuth-токены сохраняются только для владельца; предусмотрено безопасное обновление refresh token.
- Безопасный повторный запуск SQL-миграций через `npm run db:migrate`.
- Серверный пул подключений к PostgreSQL.
- Health endpoint для мониторинга приложения и БД.
- Шаблон переменных окружения и исключение секретов из Git.

## Что ещё предстоит

1. Подключить Twitch OAuth и серверную сессию.
2. Реализовать защищённое API заявок и очереди.
3. Добавить EventSub/чат-бота и права модераторов.
4. Подтвердить музыкального провайдера и его разрешения для автоматических зрительских заявок.
5. Завершить Windows-приложение Fusion Player; серверный API и панель подключения уже подготовлены.
6. Настроить и проверить отдельные аудиодорожки OBS для эфира, VOD и локальной записи.
7. Развернуть облачную часть и настроить резервное копирование/мониторинг.

## Важные ограничения

- Не вставляйте секреты Twitch или пароли БД в клиентский код или Git.
- Наличие ссылки на YouTube/Spotify или подписки на музыкальный сервис не даёт автоматически права ретранслировать музыку в Twitch.
- Неофициальные/private API музыкальных платформ не используются.
- Облачный сайт может быть доступен круглосуточно, но локальное воспроизведение через OBS требует включённого компьютера стримера.


## Production hosting

A Render Blueprint is included in `render.yaml`. It provisions:
- an always-on Node.js web service in Frankfurt;
- a managed PostgreSQL 16 database in the same region;
- automatic database migrations before deployment;
- a health check at `/api/health`.

The Blueprint deliberately uses paid always-on compute rather than free instances that sleep or expire. Current small-instance pricing suggests roughly **$16–20/month before bandwidth/tax and future scaling**; verify the exact total in Render before confirming deployment. The smallest database plan has limited memory, suitable for the initial community queue but not a high-traffic production workload.

Deployment steps when ready:
1. In Render, create a new Blueprint and connect this GitHub repository.
2. Let Render provision the service and database from `render.yaml`.
3. In the service environment, set `TWITCH_BROADCASTER_ID`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and the exact `TWITCH_REDIRECT_URI` shown by the deployed service.
4. Add the same callback URL to the Twitch Developer Console application.
5. Verify `/api/health` reports `status: ok`.

Render generates `TOKEN_ENCRYPTION_KEY` automatically. Do not replace it after Twitch tokens have been stored. The app can derive its base URL from the incoming request, so `APP_URL` is optional in production.
