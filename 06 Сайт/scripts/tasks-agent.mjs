import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  findMarkdownFiles,
  hashText,
  isoDateFromText,
  parseSections,
  repoRelative,
  repoRoot,
  sectionList,
  slugify,
  stripMarkdown,
} from "./dashboard-lib.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");

const referencesDir = path.join(repoRoot, "02 Справочники");
const tasksPath = path.join(repoRoot, "08 Задачи", "tasks.json");
const agentName = "tasks-agent";

function usage() {
  console.log(`Tasks agent

Usage:
  npm run agent:tasks
  npm run agent:tasks -- --dry-run

The agent scans approved medical event notes and writes control tasks to 08 Задачи/tasks.json.
`);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  if (dryRun) return;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanAction(value) {
  return stripMarkdown(value)
    .replace(/\s+/g, " ")
    .replace(/[.;]\s*$/u, "")
    .trim();
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonths(isoDate, months) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function monthNumber(label) {
  const months = new Map([
    ["январ", 1],
    ["феврал", 2],
    ["март", 3],
    ["апрел", 4],
    ["ма", 5],
    ["июн", 6],
    ["июл", 7],
    ["август", 8],
    ["сентябр", 9],
    ["октябр", 10],
    ["ноябр", 11],
    ["декабр", 12],
  ]);
  const text = normalizeText(label);
  for (const [prefix, value] of months.entries()) {
    if (text.startsWith(prefix)) return value;
  }
  return null;
}

function dueDateFromText(text, eventDate, followUpDate, { useFollowUpFallback = false } = {}) {
  const source = normalizeText(text);
  const explicitIso = isoDateFromText(source);
  if (explicitIso) return explicitIso;

  const ruDate = source.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/u);
  if (ruDate) {
    return isoDateFromText(`${ruDate[1].padStart(2, "0")}.${ruDate[2].padStart(2, "0")}.${ruDate[3]}`);
  }

  const relative = source.match(/(?:^|\s)через\s+(\d+)\s*(дн|недел|месяц|мес|год|лет)/u);
  if (relative && eventDate) {
    const count = Number(relative[1]);
    const unit = relative[2];
    if (unit.startsWith("дн")) return addDays(eventDate, count);
    if (unit.startsWith("недел")) return addDays(eventDate, count * 7);
    if (unit.startsWith("месяц") || unit.startsWith("мес")) return addMonths(eventDate, count);
    if (unit.startsWith("год") || unit.startsWith("лет")) return addMonths(eventDate, count * 12);
  }

  const oneMonth = source.match(/(?:^|\s)в\s+1\s+месяц/u);
  if (oneMonth && eventDate) return addMonths(eventDate, 1);

  const namedMonth = source.match(/(?:^|\s)в\s+(январ[еья]|феврал[еья]|март[е]?|апрел[еья]|ма[еья]|июн[еья]|июл[еья]|август[е]?|сентябр[еья]|октябр[еья]|ноябр[еья]|декабр[еья])(?:\s+(\d{4}))?(?:\s|$)/u);
  if (namedMonth && eventDate) {
    const month = monthNumber(namedMonth[1]);
    if (month) {
      const eventYear = Number(eventDate.slice(0, 4));
      const eventMonth = Number(eventDate.slice(5, 7));
      const year = namedMonth[2] ? Number(namedMonth[2]) : eventYear + (month < eventMonth ? 1 : 0);
      return `${year}-${String(month).padStart(2, "0")}-01`;
    }
  }

  return useFollowUpFallback ? followUpDate || "" : "";
}

function isActionable(text, hasDueDate, context = "") {
  const source = normalizeText(text);
  const combined = normalizeText(`${context} ${text}`);
  if (!source || source === "-") return false;
  if (/не\s+требуется|нет\s+необходимости|без\s+ограничений|хранить|учитывать|связать|связь\s+с|сопостав|ориентироваться|динамику|внести|напоминание|ожидается/.test(source)) {
    return false;
  }
  if (/(\bпо\s+\d+|\b\d+\s*(?:раз|таблет|капсул|капл|мг|мкг|мл|ме)\b|после\s+еды|курс\s+\d+)/u.test(source)) {
    return false;
  }
  if (/^при\s+(?:появлении|новых|недостаточн)/u.test(source)) {
    return false;
  }

  const control = /(контрол|повтор|пересдат|сдать|записат|осмотр|консультац|узи|экг|эхо|анализ|обследован|явка|оценк|проверить|пройти|ттг|т4|липопротеин|гомоцистеин|гастроскоп|колоноскоп|индекс)/u.test(combined);
  return control && (hasDueDate || /планов|по\s+рекомендац/u.test(combined));
}

function taskTypeFor(text) {
  const source = normalizeText(text);
  if (/анализ|пересдат|сдать|кров|моч|ттг|т4|липид|липопротеин|холестерин|гомоцистеин|индекс/u.test(source)) return "lab_control";
  if (/узи|экг|эхо|обследован|рентген|скрининг|ктг|стресс-тест|гастроскоп|колоноскоп/u.test(source)) return "diagnostic_control";
  if (/записат|при[её]м|осмотр|консультац|явка|врач/u.test(source)) return "doctor_visit";
  return "control_task";
}

function priorityFor(text, dueDate) {
  const source = normalizeText(text);
  if (/сроч|незамедл|экстрен|критич/u.test(source)) return "high";
  if (!dueDate) return "low";
  return "medium";
}

function personIdFor(person, people) {
  const record = people.find((item) => item.name === person || (item.aliases || []).includes(person));
  return record?.id || slugify(person || "unknown");
}

function sourceDocumentId(event) {
  const files = Array.isArray(event.source_files) ? event.source_files : [];
  return files[0] ? hashText(`${event.id}:${files[0]}`, 16) : "";
}

function eventBase(filePath, parsed, people) {
  const data = parsed.data || {};
  const person = String(data.person || "");
  const date = isoDateFromText(data.date) || "";
  const id = String(data.id || `event-${hashText(repoRelative(filePath), 12)}`);
  return {
    id,
    person,
    person_id: personIdFor(person, people),
    date,
    specialty: String(data.specialty || data.doctor_group || "Контроль"),
    specialty_id: slugify(data.specialty || data.doctor_group || "control"),
    title: cleanAction(parsed.content.match(/^#\s+(.+)$/m)?.[1] || path.basename(filePath, ".md")),
    follow_up_date: isoDateFromText(data.follow_up_date) || "",
    source_event_path: repoRelative(filePath),
    source_files: Array.isArray(data.source_files) ? data.source_files.map(String) : [],
  };
}

function candidateFromLine(line, event, sectionName, options = {}) {
  const action = cleanAction(line);
  const dueDate = dueDateFromText(`${sectionName} ${action}`, event.date, event.follow_up_date, options);
  if (!isActionable(action, Boolean(dueDate), sectionName)) return null;

  const key = [event.id, dueDate, action].join("::");
  const dedupeKey = hashText(key, 24);
  return {
    id: `task-${dedupeKey}`,
    type: taskTypeFor(action),
    status: "open",
    person: event.person,
    person_id: event.person_id,
    due_date: dueDate,
    priority: priorityFor(action, dueDate),
    specialty: event.specialty,
    specialty_id: event.specialty_id,
    title: action,
    action_text: action,
    reason: `Из раздела "${sectionName}" события "${event.title}".`,
    source_type: "event",
    source_event_id: event.id,
    source_event_path: event.source_event_path,
    source_document_id: sourceDocumentId(event),
    source_files: event.source_files,
    watchlist_topic_id: "",
    source_text: action,
    extraction_confidence: dueDate ? "high" : "medium",
    dedupe_key: dedupeKey,
    source_agent: agentName,
    generated_at: new Date().toISOString(),
  };
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    if (!candidate.person_id || !candidate.action_text) continue;
    if (seen.has(candidate.dedupe_key)) continue;
    seen.add(candidate.dedupe_key);
    output.push(candidate);
  }
  return output.sort((a, b) =>
    String(a.person_id).localeCompare(String(b.person_id)) ||
    String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31")) ||
    String(a.title).localeCompare(String(b.title), "ru"),
  );
}

async function loadEvents(people) {
  const files = await findMarkdownFiles();
  const output = [];
  for (const filePath of files) {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = matter(raw);
    if (parsed.data?.type !== "medical_event") continue;
    if (!["done", "approved"].includes(String(parsed.data.status || "done"))) continue;
    const event = eventBase(filePath, parsed, people);
    if (!event.date || !event.person_id) continue;
    output.push({ filePath, parsed, event });
  }
  return output;
}

function extractTasksFromEvent(item) {
  const sections = parseSections(item.parsed.content);
  const sectionNames = [
    "Что делать дальше",
    "Назначения",
    "Что важно отследить",
    "Контроль в июле",
    "Планово",
  ];
  const candidates = [];

  for (const sectionName of sectionNames) {
    for (const line of sectionList(sections, sectionName)) {
      const candidate = candidateFromLine(line, item.event, sectionName);
      if (candidate) candidates.push(candidate);
    }
  }

  if (item.event.follow_up_date) {
    const fallback = candidateFromLine(`Контроль: ${item.event.specialty}`, item.event, "follow_up_date", {
      useFollowUpFallback: true,
    });
    if (fallback) candidates.push(fallback);
  }

  return candidates;
}

async function scanTasks() {
  const [peopleJson, tasksJson] = await Promise.all([
    readJson(path.join(referencesDir, "people.json"), { people: [] }),
    readJson(tasksPath, { schema_version: 1, records: [] }),
  ]);
  const people = peopleJson.people || [];
  const events = await loadEvents(people);
  const generated = uniqueCandidates(events.flatMap(extractTasksFromEvent));
  const manualRecords = (tasksJson.records || []).filter((record) => record.source_agent !== agentName);
  const manualKeys = new Set(manualRecords.map((record) => record.dedupe_key).filter(Boolean));
  const records = [
    ...manualRecords,
    ...generated.filter((record) => !manualKeys.has(record.dedupe_key)),
  ];

  const payload = {
    schema_version: tasksJson.schema_version || 1,
    updated_at: new Date().toISOString(),
    records,
  };

  await writeJson(tasksPath, payload);
  console.log(`Tasks scan complete: ${generated.length} generated task(s), ${manualRecords.length} manual task(s) preserved.`);
  console.log(`Output: ${repoRelative(tasksPath)}.`);
  if (dryRun) console.log("Dry run: no files were written.");
}

if (flags.has("--help") || flags.has("-h")) {
  usage();
} else {
  await scanTasks();
}
