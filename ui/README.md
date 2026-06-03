# Procure AI — UI

Веб-интерфейс загрузки прайс-листов поставщиков для проекта **Procure AI**
(автосоздание сделок в Bitrix24). Построен на Nuxt 4 и
[Bitrix24 UI Kit](https://bitrix24.github.io/b24ui/) (`@bitrix24/b24ui-nuxt`).

Главная страница (`app/pages/index.vue`) позволяет выбрать файлы
(PDF / XLSX / DOCX), загрузить их в backend (`POST /upload`) и отслеживать
пофайловый статус обработки (`GET /job/:id/status`).

## Разработка

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm lint
pnpm build        # статика собирается в .output/public
```

В продакшене статика из `.output/public` копируется в образ `app`
(см. корневой `Dockerfile.app`) и раздаётся Express-бэкендом.

Общая архитектура проекта — в корневом `README.md` и `docs/PROJECT_BRIEF.md`.
