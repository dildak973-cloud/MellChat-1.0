# Mell chat на Vercel

## Деплой
1. Залейте папку в GitHub (или `npx vercel` из этой папки).
2. Vercel → New Project → выберите репозиторий. **Framework Preset: Other**, Build Command и Output Directory — пустые.
3. Проект → **Storage**:
   - **Upstash Redis** (Marketplace) → Create → Connect Project (переменные подставятся сами);
   - **Blob** → Create → Connect Project (даст `BLOB_READ_WRITE_TOKEN`).
4. Redeploy.
5. (Необязательно) ключ Google Maps JS API — в начале `index.html`: `window.MELL={gmapsKey:'...'}`.

## Что внутри
- `index.html`, `shim.js` — приложение;
- `api/app.js` — весь бэкенд (регистрация, вход, синхронизация, файлы, звонки), роуты — в `vercel.json`;
- `lib/store.js` — Upstash Redis + Vercel Blob.

## Вход
Cookie `mell_sid` выдаётся на 1 год (HttpOnly, Secure) и продлевается при каждом открытии — после полного закрытия приложения вы остаётесь в аккаунте.

## Ограничения Vercel
- Файлы до 4 МБ (лимит тела запроса функции).
- Обновления приходят через long-poll (каждые ~7 с запрос к Redis) — на бесплатном тарифе Upstash лимит команд быстро кончится при большом онлайне.
