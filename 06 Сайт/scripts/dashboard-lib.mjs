import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

export const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(siteDir, "..");
export const membersDir = path.join(repoRoot, "01 Члены семьи");
export const inboxDir = path.join(repoRoot, "04 Входящие");
export const metricsFilePath = path.join(repoRoot, "07 Показатели", "metrics.json");
export const generatedDir = path.join(siteDir, "src", "generated");
export const publicDocumentsDir = path.join(siteDir, "public", "files", "documents");
export const distDocumentsDir = path.join(siteDir, "dist", "files", "documents");
export const basePath = "/MedsDataBase";

const assetExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

const translit = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function repoRelative(filePath) {
  return toPosixPath(path.relative(repoRoot, filePath));
}

export function hashText(value, length = 10) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, length);
}

export function slugify(value, fallback = "item") {
  const source = String(value ?? "").toLowerCase();
  let out = "";
  for (const char of source) {
    if (translit[char] !== undefined) {
      out += translit[char];
    } else if (/[a-z0-9]/.test(char)) {
      out += char;
    } else {
      out += "-";
    }
  }
  out = out.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return out || fallback;
}

export function isValidSlug(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? ""));
}

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\\/]+/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function arrayValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

export function isoDateFromText(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return validIsoDate(iso[1], iso[2], iso[3]);
  const ru = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (ru) return validIsoDate(ru[3], ru[2], ru[1]);
  return undefined;
}

function validIsoDate(year, month, day) {
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return undefined;
  }
  return iso;
}

function addBase(routePath) {
  if (!routePath) return basePath;
  if (/^https?:\/\//.test(routePath)) return routePath;
  const clean = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${basePath}${clean}`;
}

function cleanTaskText(value) {
  const text = stripMarkdown(value);
  if (!text || text === "-" || text === "—" || /^[-—\s]+$/.test(text)) return "";
  if (/^(артём|маша|ника)$/i.test(text)) return "";
  return text;
}

function inferSpecialtyFromPath(filePath) {
  if (!filePath.startsWith(membersDir)) return "";
  const relative = path.relative(membersDir, filePath).split(path.sep);
  const specialtyDir = relative[1] || "";
  return specialtyDir.replace(/^\d+\s+/, "").trim();
}

export function firstHeading(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return stripMarkdown(match?.[1] || fallback);
}

export function parseSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map();
  let current = "";
  let bucket = [];

  function flush() {
    if (!current) return;
    sections.set(current, bucket.join("\n").trim());
  }

  for (const line of lines) {
    const anyHeading = line.match(/^(#{1,6})\s+(.+)$/);
    if (anyHeading && anyHeading[1].length === 1 && current) {
      flush();
      current = "";
      bucket = [];
      continue;
    }
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      current = stripMarkdown(heading[1]);
      bucket = [];
    } else if (current) {
      bucket.push(line);
    }
  }
  flush();

  return sections;
}

export function sectionList(sections, name) {
  const text = sections.get(name) || "";
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      const item = stripMarkdown(bullet[1]);
      if (item) items.push(item);
    }
  }
  if (items.length) return items;

  const plain = stripMarkdown(text);
  return plain ? [plain] : [];
}

function cleanList(items) {
  return arrayValue(items).map(cleanTaskText).filter(Boolean);
}

export function sectionText(sections, name) {
  return stripMarkdown(sections.get(name) || "");
}

export function parseKeyValueList(sections, name) {
  const result = {};
  for (const item of sectionList(sections, name)) {
    const match = item.match(/^([^:]+):\s*(.*)$/);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

async function walk(dir, predicate, output = []) {
  if (!fs.existsSync(dir)) return output;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "dist", ".astro", ".next", "out"].includes(entry.name)) continue;
      await walk(fullPath, predicate, output);
    } else if (!predicate || predicate(fullPath)) {
      output.push(fullPath);
    }
  }
  return output;
}

export async function findMarkdownFiles() {
  return walk(membersDir, (filePath) => path.extname(filePath).toLowerCase() === ".md");
}

export async function findAssetFiles({ includeInbox = false } = {}) {
  const files = await walk(membersDir, (filePath) => assetExtensions.has(path.extname(filePath).toLowerCase()));
  if (includeInbox) {
    await walk(inboxDir, (filePath) => assetExtensions.has(path.extname(filePath).toLowerCase()), files);
  }
  return files;
}

export async function readMarkdown(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    data: parsed.data || {},
    body: parsed.content || "",
    raw,
  };
}

function memberNameFromPath(filePath) {
  const relative = path.relative(membersDir, filePath);
  return relative.split(path.sep)[0];
}

function memberRootForName(name) {
  return path.join(membersDir, name);
}

function documentOutputName(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  const base = path.basename(relativePath, ext);
  return `${hashText(relativePath)}-${slugify(base, "document")}${ext}`;
}

function documentFromPath(filePath, isInboxItem = false) {
  const relativePath = repoRelative(filePath);
  const outputFileName = documentOutputName(relativePath);
  const person = filePath.startsWith(membersDir) ? memberNameFromPath(filePath) : undefined;
  const inferredDate = isoDateFromText(path.basename(filePath)) || isoDateFromText(relativePath);
  const specialty = inferSpecialtyFromPath(filePath);
  const slug = slugify(`${path.basename(filePath, path.extname(filePath))}-${hashText(relativePath, 8)}`, `document-${hashText(relativePath, 8)}`);
  return {
    id: hashText(relativePath, 16),
    slug,
    fileName: path.basename(filePath),
    originalPath: relativePath,
    routePath: `/documents/${slug}`,
    href: addBase(`/documents/${slug}`),
    outputFileName,
    publicUrl: `${basePath}/files/documents/${outputFileName}`,
    extension: path.extname(filePath).slice(1).toLowerCase(),
    person,
    eventId: undefined,
    eventSlug: undefined,
    specialty,
    specialtyId: slugify(specialty || "unknown"),
    date: inferredDate,
    isLinkedToEvent: false,
    linkStatus: "document_only",
    linkStatusLabel: "Нет описания события",
    isInboxItem,
    size: fs.statSync(filePath).size,
  };
}

function documentForEvent(document, event) {
  return {
    ...document,
    person: event.person,
    eventId: event.id,
    eventSlug: event.slug,
    eventHref: event.href,
    specialty: event.specialty,
    specialtyId: event.specialtyId,
    date: event.date,
    isLinkedToEvent: true,
    linkStatus: "linked",
    linkStatusLabel: "Привязан к записи",
  };
}

function createIssue(severity, entityType, message, extra = {}) {
  return {
    id: hashText(`${severity}:${entityType}:${message}:${extra.entityPath || ""}`, 12),
    severity,
    entityType,
    message,
    ...extra,
  };
}

function nearestYearDir(eventDir) {
  let current = eventDir;
  for (let i = 0; i < 4; i += 1) {
    if (/20\d{2}/.test(path.basename(current))) return current;
    current = path.dirname(current);
  }
  return path.dirname(eventDir);
}

function resolveSourceFile(rawSource, event, documents, issues) {
  const raw = String(rawSource || "").trim();
  if (!raw) return undefined;

  const eventDir = path.dirname(path.join(repoRoot, event.markdownPath));
  const personRoot = memberRootForName(event.person);
  const normalizedRaw = normalizeName(path.basename(raw));
  const hasExplicitPath = /[\\/]/.test(raw);

  if (hasExplicitPath) {
    const explicit = path.resolve(eventDir, raw);
    const relative = repoRelative(explicit);
    const doc = documents.find((candidate) => candidate.originalPath === relative);
    if (doc) return doc;
    issues.push(
      createIssue("warn", "document", `Явный путь из source_files не найден: ${raw}`, {
        entityPath: event.markdownPath,
        suggestedFix: "Проверьте путь относительно заметки события. Для явных путей автоподбор по имени файла не используется.",
      }),
    );
    return undefined;
  }

  const exactDirMatches = (dir) =>
    documents.filter((candidate) => {
      const candidatePath = path.join(repoRoot, candidate.originalPath);
      return path.dirname(candidatePath) === dir && normalizeName(candidate.fileName) === normalizedRaw;
    });

  const branchMatches = (dir) =>
    documents.filter((candidate) => {
      const candidatePath = path.join(repoRoot, candidate.originalPath);
      return candidatePath.startsWith(dir + path.sep) && normalizeName(candidate.fileName) === normalizedRaw;
    });

  const searchSteps = [
    exactDirMatches(eventDir),
    branchMatches(nearestYearDir(eventDir)),
    branchMatches(personRoot),
  ];

  for (const matches of searchSteps) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      issues.push(
        createIssue("warn", "document", `Несколько документов подходят для source_files: ${raw}`, {
          entityPath: event.markdownPath,
          suggestedFix: "Укажите относительный путь к документу в source_files.",
        }),
      );
      return undefined;
    }
  }

  const globalMatches = documents.filter((candidate) => normalizeName(candidate.fileName) === normalizedRaw);
  if (globalMatches.length === 1) {
    const candidatePath = path.join(repoRoot, globalMatches[0].originalPath);
    if (!candidatePath.startsWith(personRoot + path.sep)) {
      issues.push(
        createIssue("warn", "document", `source_files нашёл файл вне ветки человека и не был привязан: ${raw}`, {
          entityPath: event.markdownPath,
          suggestedFix: "Укажите явный относительный путь или переместите документ в папку события.",
        }),
      );
      return undefined;
    }
    return globalMatches[0];
  }

  if (globalMatches.length > 1) {
    issues.push(
      createIssue("warn", "document", `Глобальный поиск source_files неоднозначен: ${raw}`, {
        entityPath: event.markdownPath,
        suggestedFix: "Укажите относительный путь к документу в source_files.",
      }),
    );
    return undefined;
  }

  issues.push(
    createIssue("warn", "document", `Файл из source_files не найден: ${raw}`, {
      entityPath: event.markdownPath,
    }),
  );
  return undefined;
}

function normalizeProfile(filePath, data, body) {
  const sections = parseSections(body);
  const info = parseKeyValueList(sections, "Основная информация");
  const important = parseKeyValueList(sections, "Важное");
  const person = data.person || memberNameFromPath(filePath);
  const id = data.id || `profile-${slugify(person)}`;
  const birthDate = isoDateFromText(info["Дата рождения"]);

  return {
    id,
    slug: slugify(person, `person-${hashText(person, 6)}`),
    name: person,
    routePath: `/people/${slugify(person, `person-${hashText(person, 6)}`)}`,
    href: addBase(`/people/${slugify(person, `person-${hashText(person, 6)}`)}`),
    profilePath: repoRelative(filePath),
    birthDate,
    birthDateText: info["Дата рождения"] || "",
    bloodType: info["Группа крови"] || "",
    rhFactor: info["Резус-фактор"] || "",
    allergies: important["Аллергии"] ? [important["Аллергии"]] : [],
    chronicConditions: important["Хронические заболевания"] ? [important["Хронические заболевания"]] : [],
    currentMedications: important["Текущие препараты"] ? [important["Текущие препараты"]] : [],
    currentTreatments: important["Текущие курсы лечения"] ? [important["Текущие курсы лечения"]] : [],
    importantStatus: important["Беременность / важный статус"] || "",
    recentImportantEvents: sectionList(sections, "Последние важные события"),
    profileTasks: sectionList(sections, "Ближайшие задачи"),
    eventCount: 0,
    documentCount: 0,
    nextTasks: [],
    dataWarnings: [],
  };
}

function normalizeEvent(filePath, data, body, idCounts, issues) {
  const markdownPath = repoRelative(filePath);
  const person = data.person || memberNameFromPath(filePath);
  const eventDate = isoDateFromText(data.date);
  const rawId = String(data.id || "");

  if (!person) {
    issues.push(createIssue("skip", "event", "Событие без person пропущено.", { entityPath: markdownPath }));
    return undefined;
  }
  if (!eventDate) {
    issues.push(createIssue("skip", "event", "Событие без валидной date пропущено.", { entityPath: markdownPath }));
    return undefined;
  }

  let id = rawId;
  if (!id || id === "null") {
    id = `event-${hashText(markdownPath, 12)}`;
    issues.push(
      createIssue("warn", "event", "Событие без id получило fallback slug.", {
        entityPath: markdownPath,
      }),
    );
  }

  idCounts.set(id, (idCounts.get(id) || 0) + 1);

  const sections = parseSections(body);
  const title = firstHeading(body, path.basename(filePath, ".md"));
  const eventType = String(data.event_type || "Событие");
  const specialty = String(data.specialty || data.doctor_group || "Не указано");
  const followUpDate = isoDateFromText(data.follow_up_date);
  const slug = isValidSlug(id) ? id : slugify(`${eventDate}-${person}-${title}-${hashText(markdownPath, 6)}`);
  const canonicalType = canonicalEventType(eventType);
  const specialtyId = slugify(specialty, "unknown");

  return {
    id,
    slug,
    routePath: `/events/${slug}`,
    href: addBase(`/events/${slug}`),
    title,
    person,
    personSlug: slugify(person),
    date: eventDate,
    year: eventDate.slice(0, 4),
    eventType,
    eventTypeId: canonicalType.eventTypeId,
    eventTypeLabel: canonicalType.eventTypeLabel,
    sourceEventType: eventType,
    specialty,
    specialtyId,
    specialtyLabel: specialty,
    doctor: data.doctor && data.doctor !== "null" ? String(data.doctor) : "",
    clinic: data.clinic && data.clinic !== "null" ? String(data.clinic) : "",
    status: String(data.status || "done"),
    importance: ["low", "normal", "high", "critical"].includes(data.importance) ? data.importance : "normal",
    followUpDate,
    sourceFileNames: arrayValue(data.source_files),
    sourceFiles: [],
    tags: arrayValue(data.tags),
    summary: cleanList(sectionList(sections, "Краткий итог")),
    track: cleanList(sectionList(sections, "Что важно отследить")),
    nextActions: cleanList(sectionList(sections, "Что делать дальше")),
    prescriptions: cleanList(sectionList(sections, "Назначения")),
    markdownPath,
    folderPath: repoRelative(path.dirname(filePath)),
    searchableText: stripMarkdown(
      [
        title,
        person,
        eventType,
        specialty,
        data.doctor,
        data.clinic,
        sectionText(sections, "Краткий итог"),
        sectionText(sections, "Что важно отследить"),
        sectionText(sections, "Что делать дальше"),
        sectionText(sections, "Назначения"),
        sectionText(sections, "Контроль в июле"),
        sectionText(sections, "Планово"),
      ].join(" "),
    ),
    dataWarnings: [],
  };
}

function buildTaskFromEvent(event) {
  if (!event.followUpDate) return undefined;
  const actionText = event.followUpAction || `Контроль: ${event.specialty}`;
  return {
    id: `task-${event.slug}-${event.followUpDate}`,
    person: event.person,
    personSlug: event.personSlug,
    href: event.href,
    dueDate: event.followUpDate,
    specialty: event.specialty,
    specialtyId: event.specialtyId,
    sourceType: "event",
    sourceEventId: event.id,
    sourceEventSlug: event.slug,
    sourcePath: event.routePath,
    sourceHref: event.href,
    sourceTitle: event.title,
    title: actionText,
    stateBucket: "computed_on_client",
    statusLabel: "Рассчитывается по текущей дате",
    actionText,
  };
}

function deriveFollowUpAction(event) {
  const candidates = [...event.nextActions, ...event.track]
    .map((item) => ({ item, score: followUpScore(item) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  if (candidates[0]) {
    return candidates[0].item;
  }
  return `Контроль: ${event.specialty}`;
}

function followUpScore(value) {
  const text = String(value || "").toLowerCase();
  let score = 0;
  if (/контрольн|контроль\s|повторн|чек-ап|чекап|следующ|через\s+\d|в\s+июле|середине\s+мая/.test(text)) score += 10;
  if (/анализ|узи|обследован|осмотр|консультац|тестирован/.test(text)) score += 5;
  if (/при[её]м/.test(text)) score += 1;
  if (/витамин|омега|подмывание|мирамистин|мазь|пить|соблюдать/.test(text)) score -= 5;
  return score;
}

function buildProfileTasks(profile) {
  return cleanList(profile.profileTasks).map((task, index) => ({
    id: `task-${profile.slug}-profile-${index}`,
    person: profile.name,
    personSlug: profile.slug,
    href: profile.href,
    dueDate: undefined,
    specialty: "Профиль",
    specialtyId: "profile",
    sourceType: "profile",
    sourcePath: profile.routePath,
    sourceHref: profile.href,
    sourceTitle: `Профиль — ${profile.name}`,
    title: task,
    stateBucket: "unknown",
    statusLabel: "Без даты",
    actionText: task,
  }));
}

function buildSearchItems({ people, events, documents, tasks }) {
  return [
    ...people.map((person) => ({
      type: "person",
      id: person.id,
      person: person.name,
      personSlug: person.slug,
      title: person.name,
      routePath: person.routePath,
      href: person.href,
      subtitle: "Профиль",
      text: stripMarkdown(
        [
          person.name,
          person.birthDateText,
          person.allergies?.join(" "),
          person.chronicConditions?.join(" "),
          person.currentMedications?.join(" "),
          person.currentTreatments?.join(" "),
          person.importantStatus,
        ].join(" "),
      ),
    })),
    ...events.map((event) => ({
      type: "event",
      id: event.id,
      person: event.person,
      personSlug: event.personSlug,
      date: event.date,
      specialty: event.specialty,
      specialtyId: event.specialtyId,
      eventType: event.eventType,
      eventTypeId: event.eventTypeId,
      title: event.title,
      routePath: event.routePath,
      href: event.href,
      subtitle: `${event.date} · ${event.person} · ${event.specialty}`,
      text: event.searchableText,
    })),
    ...documents.map((document) => ({
      type: "document",
      id: document.id,
      person: document.person,
      personSlug: document.person ? slugify(document.person) : undefined,
      date: document.date,
      specialty: document.specialty,
      specialtyId: document.specialtyId,
      extension: document.extension,
      linkStatus: document.linkStatus,
      linkStatusLabel: document.linkStatusLabel,
      title: document.fileName,
      routePath: document.routePath,
      href: document.href,
      subtitle: [document.person, document.date, document.specialty].filter(Boolean).join(" · "),
      text: stripMarkdown(`${document.fileName} ${document.person || ""} ${document.specialty || ""}`),
    })),
    ...tasks.map((task) => ({
      type: "task",
      id: task.id,
      person: task.person,
      personSlug: task.personSlug,
      date: task.dueDate,
      dueDate: task.dueDate,
      specialty: task.specialty,
      specialtyId: task.specialtyId,
      title: task.actionText,
      routePath: task.sourcePath,
      href: task.sourceHref,
      subtitle: [task.person, task.dueDate || "Без даты"].filter(Boolean).join(" · "),
      text: stripMarkdown(`${task.actionText} ${task.person} ${task.specialty}`),
    })),
  ];
}

async function readMetricsFile() {
  try {
    const raw = await fsp.readFile(metricsFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

function displayMetricValue(record) {
  const value = record.value_text || record.value || record.qualitative_value || "";
  return [record.comparator, value, record.unit].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function normalizeMetricRecord(record, eventsById) {
  const event = record.source_event_id ? eventsById.get(record.source_event_id) : undefined;
  return {
    ...record,
    displayValue: displayMetricValue(record),
    numeric_value: typeof record.numeric_value === "number" ? record.numeric_value : null,
    is_abnormal: record.is_abnormal === true,
    eventHref: event?.href,
    eventTitle: event?.title,
    eventSlug: event?.slug,
  };
}

function buildMetricGroups(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.person_id || record.person}:${record.metric_id || record.metric_label}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        person: record.person,
        personId: record.person_id,
        metricId: record.metric_id,
        metricLabel: record.metric_label,
        metricCategory: record.metric_category,
        metricValueType: record.metric_value_type,
        records: [],
      });
    }
    groups.get(key).records.push(record);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = group.records.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const latest = sorted[sorted.length - 1];
      const previous = sorted.length > 1 ? sorted[sorted.length - 2] : undefined;
      const hasLatestNumber = latest?.numeric_value !== null && latest?.numeric_value !== undefined;
      const hasPreviousNumber = previous?.numeric_value !== null && previous?.numeric_value !== undefined;
      const delta = hasLatestNumber && hasPreviousNumber ? latest.numeric_value - previous.numeric_value : null;
      return {
        ...group,
        records: sorted,
        latest,
        previous,
        delta,
        count: sorted.length,
        hasTrend: sorted.filter((record) => record.numeric_value !== null && record.numeric_value !== undefined).length >= 2,
      };
    })
    .sort((a, b) => String(a.person).localeCompare(String(b.person), "ru") || String(a.metricLabel).localeCompare(String(b.metricLabel), "ru"));
}

function canonicalEventType(label) {
  const text = String(label || "").toLowerCase();
  if (/анализ|лаборатор/.test(text)) return { eventTypeId: "lab", eventTypeLabel: "Анализ" };
  if (/обслед|узи|экг|эхо|диагност|эргоспир/.test(text)) return { eventTypeId: "diagnostics", eventTypeLabel: "Обследование" };
  if (/консультац/.test(text)) return { eventTypeId: "consultation", eventTypeLabel: "Консультация" };
  if (/при[её]м|осмотр/.test(text)) return { eventTypeId: "visit", eventTypeLabel: "Приём" };
  if (/оценка|риск/.test(text)) return { eventTypeId: "risk-assessment", eventTypeLabel: "Оценка риска" };
  if (/заключ/.test(text)) return { eventTypeId: "conclusion", eventTypeLabel: "Заключение" };
  return { eventTypeId: slugify(label || "event"), eventTypeLabel: label || "Событие" };
}

export async function loadDashboardData({ includeInbox = false } = {}) {
  const issues = [];
  const documents = (await findAssetFiles({ includeInbox })).map((filePath) =>
    documentFromPath(filePath, filePath.startsWith(inboxDir)),
  );
  const markdownFiles = await findMarkdownFiles();
  const profiles = [];
  const events = [];
  const idCounts = new Map();

  for (const filePath of markdownFiles) {
    const { data, body } = await readMarkdown(filePath);
    if (data.type === "person_profile") {
      profiles.push(normalizeProfile(filePath, data, body));
    } else if (data.type === "medical_event") {
      const event = normalizeEvent(filePath, data, body, idCounts, issues);
      if (event) events.push(event);
    } else {
      issues.push(
        createIssue("warn", "event", `Markdown-файл в папке членов семьи не попал в дашборд: неизвестный type '${data.type || "пусто"}'.`, {
          entityPath: repoRelative(filePath),
          suggestedFix: "Укажите type: medical_event или type: person_profile, если файл должен отображаться на сайте.",
        }),
      );
    }
  }

  for (const [id, count] of idCounts.entries()) {
    if (count > 1) {
      issues.push(
        createIssue("fatal", "event", `Дублирующийся id события: ${id}`, {
          suggestedFix: "Сделайте id уникальными во frontmatter.",
        }),
      );
    }
  }

  for (const event of events) {
    for (const source of event.sourceFileNames) {
      const document = resolveSourceFile(source, event, documents, issues);
      if (!document) continue;
      const eventDocument = documentForEvent(document, event);
      event.sourceFiles.push(eventDocument);
      if (!document.isLinkedToEvent) {
        Object.assign(document, eventDocument);
      } else {
        document.relatedEventCandidates = [
          ...(document.relatedEventCandidates || []),
          { id: event.id, slug: event.slug, title: event.title, href: event.href },
        ];
      }
    }
  }

  for (const event of events) {
    event.followUpAction = deriveFollowUpAction(event);
  }

  const tasks = [
    ...events.map(buildTaskFromEvent).filter(Boolean),
    ...profiles.flatMap(buildProfileTasks),
  ];

  for (const profile of profiles) {
    const personEvents = events
      .filter((event) => event.person === profile.name)
      .sort((a, b) => b.date.localeCompare(a.date));
    const personDocuments = documents
      .filter((document) => document.person === profile.name)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const specialties = new Map();
    for (const event of personEvents) {
      specialties.set(event.specialty, (specialties.get(event.specialty) || 0) + 1);
    }
    profile.eventCount = personEvents.length;
    profile.documentCount = personDocuments.length;
    profile.nextTasks = tasks
      .filter((task) => task.person === profile.name)
      .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"))
      .slice(0, 5);
    profile.latestEvent = personEvents[0]
      ? {
          title: personEvents[0].title,
          date: personEvents[0].date,
          specialty: personEvents[0].specialty,
          href: personEvents[0].href,
        }
      : undefined;
    profile.latestDocument = personDocuments[0]
      ? {
          fileName: personDocuments[0].fileName,
          date: personDocuments[0].date,
          href: personDocuments[0].href,
          linkStatusLabel: personDocuments[0].linkStatusLabel,
        }
      : undefined;
    profile.specialtySummary = [...specialties.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
      .slice(0, 6)
      .map(([label, count]) => ({ label, id: slugify(label), count }));
    profile.emptyStateFlags = {
      hasEvents: personEvents.length > 0,
      hasDocuments: personDocuments.length > 0,
      hasTasks: profile.nextTasks.length > 0,
    };
  }

  const sortedEvents = events.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, "ru"));
  const sortedDocuments = documents.sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") || a.fileName.localeCompare(b.fileName, "ru"),
  );
  const eventsById = new Map(sortedEvents.map((event) => [event.id, event]));
  const metrics = (await readMetricsFile())
    .map((record) => normalizeMetricRecord(record, eventsById))
    .sort((a, b) =>
      String(a.person).localeCompare(String(b.person), "ru") ||
      String(a.metric_label).localeCompare(String(b.metric_label), "ru") ||
      String(b.date).localeCompare(String(a.date)),
    );
  const metricGroups = buildMetricGroups(metrics);

  const data = {
    generatedAt: new Date().toISOString(),
    basePath,
    people: profiles.sort((a, b) => a.name.localeCompare(b.name, "ru")),
    events: sortedEvents,
    documents: sortedDocuments,
    metrics,
    metricGroups,
    tasks,
    issues,
    searchItems: [],
    stats: {
      people: profiles.length,
      events: events.length,
      documents: documents.length,
      metrics: metrics.length,
      metricTypes: metricGroups.length,
      linkedDocuments: documents.filter((document) => document.isLinkedToEvent).length,
      unlinkedDocuments: documents.filter((document) => !document.isLinkedToEvent).length,
      tasks: tasks.length,
      warnings: issues.filter((issue) => issue.severity === "warn").length,
      fatal: issues.filter((issue) => issue.severity === "fatal").length,
    },
  };
  data.searchItems = buildSearchItems(data);
  return data;
}

export async function writeDashboardData(options = {}) {
  const data = await loadDashboardData(options);
  await fsp.mkdir(generatedDir, { recursive: true });
  const manifest = data.documents.map((document) => ({
    id: document.id,
    slug: document.slug,
    fileName: document.fileName,
    originalPath: document.originalPath,
    outputFileName: document.outputFileName,
    publicUrl: document.publicUrl,
    extension: document.extension,
    size: document.size,
  }));
  await fsp.writeFile(path.join(generatedDir, "dashboard-data.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(generatedDir, "document-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return data;
}

export async function copyDocuments(targetDir) {
  const manifestPath = path.join(generatedDir, "document-manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.mkdir(targetDir, { recursive: true });
  for (const document of manifest) {
    const source = path.join(repoRoot, document.originalPath);
    const target = path.join(targetDir, document.outputFileName);
    await fsp.copyFile(source, target);
  }
  await fsp.writeFile(path.join(targetDir, ".gitkeep"), "", "utf8");
  return manifest.length;
}

export async function getAssetStats() {
  const files = await findAssetFiles({ includeInbox: true });
  const assets = files.map((filePath) => ({
    path: repoRelative(filePath),
    size: fs.statSync(filePath).size,
  }));
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0);
  return { assets, totalSize };
}
