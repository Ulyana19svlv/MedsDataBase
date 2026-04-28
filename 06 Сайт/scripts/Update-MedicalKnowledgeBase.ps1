$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Convert-ToSlug([string]$Text) {
    $map = @{
        'а'='a'; 'б'='b'; 'в'='v'; 'г'='g'; 'д'='d'; 'е'='e'; 'ё'='e'; 'ж'='zh'; 'з'='z'; 'и'='i'; 'й'='y'; 'к'='k'; 'л'='l'; 'м'='m'; 'н'='n'; 'о'='o'; 'п'='p'; 'р'='r'; 'с'='s'; 'т'='t'; 'у'='u'; 'ф'='f'; 'х'='h'; 'ц'='ts'; 'ч'='ch'; 'ш'='sh'; 'щ'='sch'; 'ъ'=''; 'ы'='y'; 'ь'=''; 'э'='e'; 'ю'='yu'; 'я'='ya'
    }

    $builder = [System.Text.StringBuilder]::new()
    foreach ($ch in $Text.ToLowerInvariant().ToCharArray()) {
        $s = [string]$ch
        if ($map.ContainsKey($s)) {
            [void]$builder.Append($map[$s])
        } elseif ($s -match '[a-z0-9]') {
            [void]$builder.Append($s)
        } else {
            [void]$builder.Append('-')
        }
    }

    return (($builder.ToString() -replace '-+', '-') -replace '^-|-$', '')
}

function Parse-Frontmatter([string]$Content) {
    $result = [ordered]@{}
    if ($Content -match '(?s)^---\r?\n(.*?)\r?\n---\r?\n') {
        foreach ($line in ($Matches[1] -split '\r?\n')) {
            if ($line -match '^([^:#]+):\s*(.*)$') {
                $result[$Matches[1].Trim()] = $Matches[2].Trim()
            }
        }
    }
    return $result
}

function Get-BodyWithoutFrontmatter([string]$Content) {
    if ($Content -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') {
        return $Matches[1]
    }
    return $Content
}

function Get-FirstHeading([string]$Content, [string]$Fallback) {
    foreach ($line in ($Content -split '\r?\n')) {
        if ($line -match '^#\s+(.+)$') {
            return $Matches[1].Trim()
        }
    }
    return $Fallback
}

function Format-YamlScalar([string]$Value) {
    if ($null -eq $Value -or $Value -eq '' -or $Value -eq 'null') {
        return 'null'
    }
    if ($Value -match '[:#\[\]\{\},&*]|^\s|\s$') {
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

function Build-Frontmatter($Meta) {
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('---')
    foreach ($key in $Meta.Keys) {
        $value = $Meta[$key]
        if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
            $items = @($value)
            if ($items.Count -eq 0) {
                $lines.Add("$key`: []")
            } else {
                $lines.Add("$key`:")
                foreach ($item in $items) {
                    $lines.Add('  - ' + (Format-YamlScalar ([string]$item)))
                }
            }
        } else {
            $lines.Add("$key`: " + (Format-YamlScalar ([string]$value)))
        }
    }
    $lines.Add('---')
    return ($lines -join "`r`n") + "`r`n`r`n"
}

function Write-TextFile([string]$Path, [string]$Content) {
    $encoding = [System.Text.UTF8Encoding]::new($true)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Infer-Clinic([string]$RelativePath) {
    $parts = $RelativePath -split '[\\/]'
    if ($parts.Length -ge 6) {
        $candidate = $parts[$parts.Length - 2]
        if ($candidate -notmatch '^\d{2} .+ 20\d{2}$') {
            return $candidate
        }
    }
    return $null
}

function Infer-SourceFiles([string]$FilePath) {
    $dir = Split-Path $FilePath -Parent
    $base = [IO.Path]::GetFileNameWithoutExtension($FilePath)
    $same = Join-Path $dir ($base + '.pdf')
    if (Test-Path -LiteralPath $same) {
        return @([IO.Path]::GetFileName($same))
    }
    return @()
}

function Get-Tags([string]$EventType, [string]$Specialty) {
    $tags = [System.Collections.Generic.List[string]]::new()
    switch -Regex ($EventType) {
        'Приём|Консультация' { $tags.Add('visit') }
        'Анализ' { $tags.Add('lab') }
        'Обследование|Оценка' { $tags.Add('diagnostics') }
        default { $tags.Add('medical-event') }
    }
    if ($Specialty) {
        $tags.Add((Convert-ToSlug $Specialty))
    }
    return @($tags | Select-Object -Unique)
}

function Infer-FollowUpDate([string]$Date, [string]$Body) {
    try {
        $eventDate = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)
    } catch {
        return 'null'
    }

    if ($Body -match 'через 6 месяцев|1 раз в 6 месяцев|раз в 6 месяцев') {
        return $eventDate.AddMonths(6).ToString('yyyy-MM-dd')
    }
    if ($Body -match 'в июле|на июль|Контроль в июле') {
        return $eventDate.ToString('yyyy') + '-07-01'
    }
    if ($Body -match 'середине мая') {
        return $eventDate.ToString('yyyy') + '-05-15'
    }
    if ($Body -match 'через 3 дня') {
        return $eventDate.AddDays(3).ToString('yyyy-MM-dd')
    }

    return 'null'
}

function Write-Templates {
    $templateDir = Join-Path $Root '03 Шаблоны'
    New-Item -ItemType Directory -Force -Path $templateDir | Out-Null

    $templates = @{
        'Шаблон — приём врача.md' = @'
---
id: null
type: medical_event
person: null
date: YYYY-MM-DD
event_type: Приём
specialty: null
doctor: null
clinic: null
status: draft
importance: normal
follow_up_date: null
source_files: []
tags:
  - visit
---

# {{date}} {{person}} — {{specialty}}

## Человек
- [[Профиль — {{person}}]]

## Документ
- 

## Что это

## Краткий итог
- 

## Что важно отследить
- 

## Что делать дальше
- 
'@;
        'Шаблон — анализ.md' = @'
---
id: null
type: medical_event
person: null
date: YYYY-MM-DD
event_type: Анализ
specialty: Лаборатория
doctor: null
clinic: null
status: draft
importance: normal
follow_up_date: null
source_files: []
tags:
  - lab
---

# {{date}} {{person}} — анализ

## Человек
- [[Профиль — {{person}}]]

## Документ
- 

## Что это

## Краткий итог
- 

## Отклонения / важные показатели
- 

## Что важно отследить
- 

## Что делать дальше
- 
'@;
        'Шаблон — исследование.md' = @'
---
id: null
type: medical_event
person: null
date: YYYY-MM-DD
event_type: Обследование
specialty: null
doctor: null
clinic: null
status: draft
importance: normal
follow_up_date: null
source_files: []
tags:
  - diagnostics
---

# {{date}} {{person}} — исследование

## Человек
- [[Профиль — {{person}}]]

## Документ
- 

## Что это

## Краткий итог
- 

## Что важно отследить
- 

## Что делать дальше
- 
'@;
        'Шаблон — профиль человека.md' = @'
---
id: profile-person
type: person_profile
person: null
status: active
tags:
  - profile
---

# Профиль — {{person}}

## Основная информация
- Дата рождения:
- Группа крови:
- Резус-фактор:

## Важное
- Аллергии:
- Хронические заболевания:
- Текущие препараты:
- Текущие курсы лечения:
- Основные врачи:

## Последние важные события
-

## Ближайшие задачи
-
'@;
        'Шаблон — входящий документ.md' = @'
---
id: null
type: inbox_item
person: null
date_received: YYYY-MM-DD
source_type: pdf
status: needs_review
suggested_event_type: null
suggested_specialty: null
source_files: []
tags:
  - inbox
---

# Входящий документ — {{date_received}}

## Что пришло

## Предварительное распознавание

## Решение после проверки
- [ ] Определить человека
- [ ] Определить дату события
- [ ] Определить тип события
- [ ] Создать медицинскую заметку
- [ ] Перенести исходный файл в нужную папку
'@
    }

    foreach ($name in $templates.Keys) {
        Write-TextFile (Join-Path $templateDir $name) ($templates[$name].TrimStart("`r", "`n") + "`r`n")
    }
}

function Write-Indexes($Events) {
    $indexDir = Join-Path $Root '05 Индексы'
    New-Item -ItemType Directory -Force -Path $indexDir | Out-Null

    $today = Get-Date -Format 'yyyy-MM-dd'
    $eventsSorted = @($Events | Sort-Object Person, Date, Specialty, Title)

    $allLines = [System.Collections.Generic.List[string]]::new()
    $allLines.Add('---')
    $allLines.Add('id: index-all-events')
    $allLines.Add('type: index')
    $allLines.Add('title: Все события')
    $allLines.Add("updated: $today")
    $allLines.Add('---')
    $allLines.Add('')
    $allLines.Add('# Все медицинские события')
    $allLines.Add('')
    $allLines.Add('| Дата | Человек | Тип | Направление | Клиника | Событие |')
    $allLines.Add('|---|---|---|---|---|---|')
    foreach ($event in $eventsSorted) {
        $clinic = if ($event.Clinic -and $event.Clinic -ne 'null') { $event.Clinic } else { '' }
        $allLines.Add("| $($event.Date) | $($event.Person) | $($event.EventType) | $($event.Specialty) | $clinic | [[$($event.Link)]] |")
    }
    Write-TextFile (Join-Path $indexDir 'Все события.md') (($allLines -join "`r`n") + "`r`n")

    foreach ($person in @($Events.Person | Sort-Object -Unique)) {
        $personEvents = @($Events | Where-Object Person -eq $person | Sort-Object Date, Specialty, Title)
        $slug = Convert-ToSlug $person
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add('---')
        $lines.Add("id: index-$slug-events")
        $lines.Add('type: index')
        $lines.Add("person: $person")
        $lines.Add("title: События — $person")
        $lines.Add("updated: $today")
        $lines.Add('---')
        $lines.Add('')
        $lines.Add("# $person — события")
        $lines.Add('')
        $lines.Add("Профиль: [[Профиль — $person]]")
        $lines.Add('')
        $lines.Add('| Дата | Тип | Направление | Клиника | Событие |')
        $lines.Add('|---|---|---|---|---|')
        foreach ($event in $personEvents) {
            $clinic = if ($event.Clinic -and $event.Clinic -ne 'null') { $event.Clinic } else { '' }
            $lines.Add("| $($event.Date) | $($event.EventType) | $($event.Specialty) | $clinic | [[$($event.Link)]] |")
        }
        Write-TextFile (Join-Path $indexDir "$person — события.md") (($lines -join "`r`n") + "`r`n")
    }

    $taskLines = [System.Collections.Generic.List[string]]::new()
    $taskLines.Add('---')
    $taskLines.Add('id: index-follow-ups')
    $taskLines.Add('type: index')
    $taskLines.Add('title: Ближайшие задачи')
    $taskLines.Add("updated: $today")
    $taskLines.Add('---')
    $taskLines.Add('')
    $taskLines.Add('# Ближайшие задачи и контроль')
    $taskLines.Add('')
    $taskLines.Add('| Контроль | Человек | Направление | Источник |')
    $taskLines.Add('|---|---|---|---|')
    foreach ($event in @($Events | Where-Object { $_.FollowUp -and $_.FollowUp -ne 'null' } | Sort-Object FollowUp, Person)) {
        $taskLines.Add("| $($event.FollowUp) | $($event.Person) | $($event.Specialty) | [[$($event.Link)]] |")
    }
    Write-TextFile (Join-Path $indexDir 'Ближайшие задачи.md') (($taskLines -join "`r`n") + "`r`n")
}

function Write-Home {
    $homeDir = Join-Path $Root '00 Главная'
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

    $homeContent = @'
---
id: home
type: dashboard
---

# Медицинская база знаний семьи

## Быстрый вход
- [[Все события]]
- [[Ближайшие задачи]]
- [[Артём — события]]
- [[Маша — события]]
- [[Ника — события]]

## Рабочий процесс
1. Новые PDF, фото и тексты сначала складываются в `04 Входящие`.
2. После проверки создаётся заметка по шаблону из `03 Шаблоны`.
3. Исходный файл переносится рядом с заметкой события.
4. Индексы в `05 Индексы` обновляются этим скриптом.
'@

    Write-TextFile (Join-Path $homeDir 'Главная.md') ($homeContent.TrimStart("`r", "`n") + "`r`n")
}

$events = [System.Collections.Generic.List[object]]::new()
$memberRoot = Join-Path $Root '01 Члены семьи'
$eventFiles = Get-ChildItem -LiteralPath $memberRoot -Recurse -File -Filter '*.md' | Where-Object { $_.Name -notlike 'Профиль*' }

foreach ($file in $eventFiles) {
    $relative = $file.FullName.Substring($Root.Path.Length + 1)
    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName
    $old = Parse-Frontmatter $content
    if (-not $old.Contains('person') -or -not $old.Contains('date')) {
        continue
    }

    $body = (Get-BodyWithoutFrontmatter $content).TrimStart("`r", "`n")
    $title = Get-FirstHeading $body ([IO.Path]::GetFileNameWithoutExtension($file.Name))
    $person = $old['person']
    $date = $old['date']
    $eventType = if ($old.Contains('event_type')) { $old['event_type'] } else { 'Событие' }
    $specialty = if ($old.Contains('specialty')) { $old['specialty'] } elseif ($old.Contains('doctor_group')) { $old['doctor_group'] } else { 'null' }
    $clinic = if ($old.Contains('clinic') -and $old['clinic'] -ne '') { $old['clinic'] } else { Infer-Clinic $relative }
    $sourceFiles = Infer-SourceFiles $file.FullName
    $followUp = Infer-FollowUpDate $date $body

    $meta = [ordered]@{
        id = Convert-ToSlug ([IO.Path]::GetFileNameWithoutExtension($file.Name))
        type = 'medical_event'
        person = $person
        date = $date
        event_type = $eventType
        specialty = $specialty
        doctor = if ($old.Contains('doctor') -and $old['doctor'] -ne '') { $old['doctor'] } else { 'null' }
        clinic = if ($clinic) { $clinic } else { 'null' }
        status = if ($old.Contains('status') -and $old['status'] -ne '') { $old['status'] } else { 'done' }
        importance = if ($old.Contains('importance') -and $old['importance'] -ne '') { $old['importance'] } else { 'normal' }
        follow_up_date = $followUp
        source_files = @($sourceFiles)
        tags = Get-Tags $eventType $specialty
    }

    Write-TextFile $file.FullName ((Build-Frontmatter $meta) + $body.TrimEnd() + "`r`n")

    $events.Add([pscustomobject]@{
        Person = $person
        Date = $date
        EventType = $eventType
        Specialty = $specialty
        Clinic = $clinic
        FollowUp = $followUp
        Title = $title
        Link = [IO.Path]::GetFileNameWithoutExtension($file.Name)
        Relative = $relative
    })
}

foreach ($file in Get-ChildItem -LiteralPath $memberRoot -Recurse -File -Filter 'Профиль*.md') {
    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName
    $body = (Get-BodyWithoutFrontmatter $content).TrimStart("`r", "`n")
    $person = if ($file.BaseName -match 'Профиль — (.+)$') { $Matches[1] } else { $file.BaseName }
    $meta = [ordered]@{
        id = 'profile-' + (Convert-ToSlug $person)
        type = 'person_profile'
        person = $person
        status = 'active'
        tags = @('profile')
    }
    Write-TextFile $file.FullName ((Build-Frontmatter $meta) + $body.TrimEnd() + "`r`n")
}

Write-Templates
New-Item -ItemType Directory -Force -Path (Join-Path $Root '04 Входящие') | Out-Null
Write-Indexes $events
Write-Home

Write-Output "Updated events: $($events.Count)"
Write-Output "Templates: 5"
Write-Output "Indexes: $((Get-ChildItem -LiteralPath (Join-Path $Root '05 Индексы') -File -Filter '*.md').Count)"
