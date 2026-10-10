# Mell chat — всё в одной папке (без вложенных папок)

Файлы: `index.html`, `shim.js`, `config.js`, `send.png`, `clip.png` — сайт;
`app.js`, `store.js`, `vercel.json`, `package.json` — бэкенд для Vercel.

## Установка
1. Загрузите ВСЕ файлы в корень репозитория на GitHub (ветка `main`).
2. **Бэкенд:** vercel.com → New Project → этот репозиторий, Framework Preset: **Other**.
   Storage: добавьте **Upstash Redis** и **Blob** → Connect Project → Redeploy.
   Откройте адрес проекта (например `https://mellchat.vercel.app`) — чат уже работает.
3. **Сайт на GitHub Pages (необязательно):** Settings → Pages → Deploy from a branch → `main` / `(root)`.
   Затем в `config.js` впишите `api: 'https://ваш-проект.vercel.app'` и сделайте commit.
4. В Vercel → Environment Variables можно добавить `ALLOWED_ORIGIN=https://<логин>.github.io` и Redeploy.

Вход хранится токеном `mell_token` в localStorage (1 год, продлевается при открытии).
Файлы до 4 МБ. Адрес API можно временно задать так: `...github.io/репо/?api=https://ваш-проект.vercel.app`.
