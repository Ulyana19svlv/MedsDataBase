import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const requiredDirs = [
  "02 Справочники",
  "03 Шаблоны",
  "04 Входящие/00 Новые файлы",
  "04 Входящие/10 Черновики AI",
  "04 Входящие/20 На проверке",
  "04 Входящие/30 Одобрено",
  "04 Входящие/90 Обработано",
  "04 Входящие/99 Ошибки",
  "07 Показатели",
  "08 Задачи",
  "09 Наблюдение",
];

const requiredJsonFiles = [
  "02 Справочники/people.json",
  "02 Справочники/specialties.json",
  "02 Справочники/document_types.json",
  "02 Справочники/metric_dictionary.json",
  "02 Справочники/agent_contract.json",
  "04 Входящие/intake-state.json",
  "07 Показатели/metrics.json",
  "08 Задачи/tasks.json",
  "09 Наблюдение/watchlist.json",
];

const requiredTemplates = [
  "03 Шаблоны/Шаблон — входящий документ.md",
  "03 Шаблоны/Шаблон — черновик AI-разбора.md",
  "03 Шаблоны/Шаблон — показатель.md",
  "03 Шаблоны/Шаблон — задача контроля.md",
  "03 Шаблоны/Шаблон — зона наблюдения.md",
];

const errors = [];
const warnings = [];

async function exists(relativePath) {
  try {
    await fsp.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(await fsp.readFile(fullPath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: cannot parse JSON (${error.message})`);
    return null;
  }
}

function requireArray(file, object, key) {
  if (!Array.isArray(object?.[key])) {
    errors.push(`${file}: expected "${key}" to be an array`);
    return [];
  }
  return object[key];
}

function checkUniqueIds(label, records) {
  const seen = new Set();
  for (const record of records) {
    if (!record.id) {
      errors.push(`${label}: record without id`);
      continue;
    }
    if (seen.has(record.id)) errors.push(`${label}: duplicate id "${record.id}"`);
    seen.add(record.id);
  }
  return seen;
}

for (const dir of requiredDirs) {
  if (!(await exists(dir))) errors.push(`Missing directory: ${dir}`);
}

for (const file of [...requiredJsonFiles, ...requiredTemplates]) {
  if (!(await exists(file))) errors.push(`Missing file: ${file}`);
}

const peopleJson = await readJson("02 Справочники/people.json");
const specialtiesJson = await readJson("02 Справочники/specialties.json");
const documentTypesJson = await readJson("02 Справочники/document_types.json");
const metricsDictionaryJson = await readJson("02 Справочники/metric_dictionary.json");
const agentContractJson = await readJson("02 Справочники/agent_contract.json");
const intakeStateJson = await readJson("04 Входящие/intake-state.json");
const metricsJson = await readJson("07 Показатели/metrics.json");
const tasksJson = await readJson("08 Задачи/tasks.json");
const watchlistJson = await readJson("09 Наблюдение/watchlist.json");

const people = requireArray("people.json", peopleJson, "people");
const specialties = requireArray("specialties.json", specialtiesJson, "specialties");
const documentTypes = requireArray("document_types.json", documentTypesJson, "document_types");
const metricDictionary = requireArray("metric_dictionary.json", metricsDictionaryJson, "metrics");
const intakeStateFiles = requireArray("intake-state.json", intakeStateJson, "files");
const metricRecords = requireArray("metrics.json", metricsJson, "records");
const taskRecords = requireArray("tasks.json", tasksJson, "records");
const watchlistRecords = requireArray("watchlist.json", watchlistJson, "records");

const personIds = checkUniqueIds("people", people);
const specialtyIds = checkUniqueIds("specialties", specialties);
const documentTypeIds = checkUniqueIds("document_types", documentTypes);
const metricIds = checkUniqueIds("metric_dictionary", metricDictionary);
checkUniqueIds("metrics.records", metricRecords);
checkUniqueIds("tasks.records", taskRecords);
checkUniqueIds("watchlist.records", watchlistRecords);

const intakeFingerprints = new Set();
for (const record of intakeStateFiles) {
  if (!record.fingerprint) errors.push("intake-state.files: record without fingerprint");
  if (record.fingerprint && intakeFingerprints.has(record.fingerprint)) {
    errors.push(`intake-state.files: duplicate fingerprint "${record.fingerprint}"`);
  }
  if (record.fingerprint) intakeFingerprints.add(record.fingerprint);
  if (record.source_file && !(await exists(record.source_file)) && !record.source_file_processed) {
    warnings.push(`intake-state.files: source file does not exist anymore: ${record.source_file}`);
  }
  if (record.draft_file && !(await exists(record.draft_file)) && !record.draft_file_processed) {
    warnings.push(`intake-state.files: draft file does not exist anymore: ${record.draft_file}`);
  }
  if (record.draft_file_processed && !(await exists(record.draft_file_processed))) {
    warnings.push(`intake-state.files: processed draft file does not exist: ${record.draft_file_processed}`);
  }
  if (record.source_file_processed && !(await exists(record.source_file_processed))) {
    warnings.push(`intake-state.files: processed source file does not exist: ${record.source_file_processed}`);
  }
  if (record.event_file && !(await exists(record.event_file))) {
    warnings.push(`intake-state.files: event file does not exist: ${record.event_file}`);
  }
}

for (const person of people) {
  if (!person.name) errors.push(`people: "${person.id}" is missing name`);
  if (!person.profile_note) errors.push(`people: "${person.id}" is missing profile_note`);
  if (person.profile_note && !(await exists(person.profile_note))) {
    warnings.push(`people: profile_note does not exist yet: ${person.profile_note}`);
  }
}

for (const record of metricRecords) {
  if (record.person_id && !personIds.has(record.person_id)) errors.push(`metrics.records: unknown person_id "${record.person_id}"`);
  if (record.metric_id && !metricIds.has(record.metric_id)) errors.push(`metrics.records: unknown metric_id "${record.metric_id}"`);
}

for (const record of taskRecords) {
  if (record.person_id && !personIds.has(record.person_id)) errors.push(`tasks.records: unknown person_id "${record.person_id}"`);
}

for (const record of watchlistRecords) {
  if (record.person_id && !personIds.has(record.person_id)) errors.push(`watchlist.records: unknown person_id "${record.person_id}"`);
  for (const metricId of record.related_metric_ids || []) {
    if (!metricIds.has(metricId)) errors.push(`watchlist.records: unknown related_metric_id "${metricId}"`);
  }
}

for (const folderPath of Object.values(agentContractJson?.folders || {})) {
  if (!(await exists(folderPath))) warnings.push(`agent_contract: folder target does not exist yet: ${folderPath}`);
}

if (!specialtyIds.has("other")) warnings.push('specialties: expected fallback specialty id "other"');
if (!documentTypeIds.has("unknown")) warnings.push('document_types: expected fallback document type id "unknown"');

for (const warning of warnings) console.warn(`Warning: ${warning}`);

if (errors.length) {
  for (const error of errors) console.error(`Error: ${error}`);
  process.exit(1);
}

console.log(
  `Operational layer valid: ${people.length} people, ${specialties.length} specialties, ${documentTypes.length} document types, ${metricDictionary.length} metric definitions.`,
);
