# Медицинский дашборд

Статический Astro-сайт для просмотра медицинской базы из этого репозитория. Дашборд ничего не изменяет в хранилище: он только читает заметки, YAML-поля и вложенные документы, собирает индекс и публикует визуальную навигацию.

## Локальная работа

```powershell
npm ci
npm run check
npm run validate:data
npm run validate:assets
npm run build
npm run preview
```

Открывать локально: `http://localhost:4321/MedsDataBase/`.

## Обновление данных

1. Отредактировать Obsidian-хранилище локально.
2. Проверить изменения командой `npm run validate:data` из папки `06 Сайт`.
3. Собрать сайт командой `npm run build`.
4. Закоммитить и запушить изменения в `main`.

После push GitHub Actions пересобирает сайт и публикует `06 Сайт/dist` в GitHub Pages. Workflow также запускается раз в сутки, чтобы статусы задач по датам не зависали без нового коммита.

## Полезные команды

```powershell
npm run dev
npm run check
npm run build
npm run preview
npm run validate:data
npm run validate:assets
```
