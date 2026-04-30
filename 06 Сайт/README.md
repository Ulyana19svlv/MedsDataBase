# Медицинский дашборд

Статический Astro-сайт для просмотра медицинской базы из этого репозитория. Дашборд ничего не изменяет в хранилище: он только читает заметки, YAML-поля и вложенные документы, собирает индекс и публикует визуальную навигацию.

## Локальная работа

```powershell
npm ci
npm run check
npm run validate:ops
npm run validate:data
npm run validate:assets
npm run build
npm run preview
```

Открывать локально: `http://localhost:4321/MedsDataBase/`.

## Обновление данных

1. Отредактировать Obsidian-хранилище локально.
2. Проверить операционный слой командой `npm run validate:ops` из папки `06 Сайт`.
3. Проверить данные дашборда командой `npm run validate:data`.
4. Собрать сайт командой `npm run build`.
5. Закоммитить и запушить изменения в `main`.

После push GitHub Actions пересобирает сайт и публикует `06 Сайт/dist` в GitHub Pages. Workflow также запускается раз в сутки, чтобы статусы задач по датам не зависали без нового коммита.

## Входящий агент

1. Положить новый PDF, фото или текст в `04 Входящие/00 Новые файлы`.
2. Запустить `npm run agent:intake` из папки `06 Сайт`.
3. Проверить черновик в `04 Входящие/10 Черновики AI`.
4. Если черновик корректный, поставить во frontmatter `status: approved`.
5. Запустить `npm run agent:promote`, чтобы создать событие в `01 Члены семьи`.

Для проверки без записи файлов доступны `npm run agent:intake -- --dry-run` и `npm run agent:promote -- --dry-run`.

## Полезные команды

```powershell
npm run dev
npm run check
npm run validate:ops
npm run agent:intake
npm run agent:promote
npm run build
npm run preview
npm run validate:data
npm run validate:assets
```
