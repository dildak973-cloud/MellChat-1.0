# Mell chat — Cloudflare (всё в одной папке)

Файлы: `index.html`, `shim.js`, `config.js`, `send.png`, `clip.png`, `_headers` — сайт;
`_worker.js` (весь бэкенд одним файлом), `_routes.json`, `wrangler.toml` — настройки Cloudflare.

## Вариант A — Cloudflare Pages (если у вас Pages)
1. Загрузите все файлы в корень репозитория на GitHub.
2. Cloudflare → Workers & Pages → Create → **Pages** → Connect to Git → репозиторий.
   Framework preset: None. Build command: пусто. Build output directory: `/` (корень). Save and Deploy.
3. Откройте проект → **Settings → Bindings** → добавьте:
   - **D1 database** — Variable name `DB` (создайте базу `mellchat`: Storage & Databases → D1 → Create);
   - **R2 bucket** — Variable name `FILES` (бакет `mellchat-files`).
4. **Settings → Runtime → Compatibility flags**: добавьте `nodejs_compat` и Compatibility date `2025-09-01` (и для Production, и для Preview).
5. Deployments → Retry deployment (или любой новый push).

## Вариант B — Workers (Import a repository)
Deploy command `npx wrangler deploy` — базу D1 и бакет R2 Wrangler создаст сам.

## Проверка, что бэкенд запущен
Откройте `https://ваш-адрес/api/me`. Должно быть `{"err":"auth"}`.
Если там страница сайта, 404 или 405 — бэкенд не запущен (нет `_worker.js` в корне, не выбран корень в Output directory или нет привязок).
Ошибка `Не указан адрес сервера` в приложении означает ровно это.

## Вход
Токен `mell_token` (localStorage) + cookie `mell_sid`, оба на 1 год. Пароли — PBKDF2-SHA256.
Ошибка 1102 при входе на бесплатном плане Workers — не хватило процессорного времени: уменьшите `iterations` в `_worker.js` или перейдите на Workers Paid.
Файлы до 25 МБ. Обновления — long-poll (опрос D1 каждые 1,5 с).
