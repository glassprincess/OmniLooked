# OmniLooked

Приватный просмотрщик файлов прямо в браузере. Перетащил файл — увидел его сразу.

**Живое демо:** https://glassprincess.github.io/OmniLooked/

## Что открывает

Картинки (PNG, JPG, GIF, SVG, WebP), аудио и видео (MP3, WAV, MP4, WebM), документы (DOCX, DOC, ODT, PDF, MD, HTML), таблицы (XLSX, XLS, ODS, CSV), презентации (PPTX, PPT, ODP), архивы ZIP — включая файлы с паролем. Плюс просмотр кода, hex-дамп и извлечение строк из любых бинарников.

Всё читается локально, ничего никуда не отправляется. Работает офлайн после первой загрузки, есть тёмная и светлая темы, русский и английский язык.

## Запуск локально

```sh
npm ci
npm run dev      # разработка
npm run build    # прод-сборка в dist/
```

Деплой на GitHub Pages — автоматически при пуше в `main` (`.github/workflows/deploy.yml`).

## Автор

**Steklyannaya Princessa** — [@glassprincess](https://github.com/glassprincess)
