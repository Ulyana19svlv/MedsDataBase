import fs from "node:fs";
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
const command = args.find((arg) => !arg.startsWith("--")) || "scan";
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");

const referencesDir = path.join(repoRoot, "02 Справочники");
const metricsDir = path.join(repoRoot, "07 Показатели");
const inboxDir = path.join(repoRoot, "04 Входящие");
const metricsPath = path.join(metricsDir, "metrics.json");
const candidatesPath = path.join(metricsDir, "metric_candidates.json");
const reviewPath = path.join(metricsDir, "Проверка показателей.md");

function usage() {
  console.log(`Metrics agent

Usage:
  npm run agent:metrics
  npm run agent:metrics -- scan
  npm run agent:metrics -- apply
  npm run agent:metrics -- scan --dry-run
  npm run agent:metrics -- apply --dry-run

Workflow:
  scan   Create 07 Показатели/metric_candidates.json with status: needs_review.
  apply  Append only candidates marked status: approved to 07 Показатели/metrics.json.
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

async function writeText(filePath, value) {
  if (dryRun) return;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, value, "utf8");
}

async function loadDictionary() {
  const json = await readJson(path.join(referencesDir, "metric_dictionary.json"), { metrics: [] });
  return json.metrics || [];
}

async function loadPeople() {
  const json = await readJson(path.join(referencesDir, "people.json"), { people: [] });
  return json.people || [];
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compactTextKey(value) {
  return normalizeText(value).replace(/[^a-zа-яё0-9]+/giu, "");
}

function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/\s+/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function parseValue(rawValue) {
  const source = stripMarkdown(rawValue || "");
  const numeric = source.match(/^([<>≤≥])?\s*(-?\d+(?:[,.]\d+)?)$/u);
  if (numeric) {
    const comparator = numeric[1] || "";
    const value = numeric[2].replace(",", ".");
    return {
      value_text: source,
      value: value,
      numeric_value: parseNumber(value),
      comparator,
      qualitative_value: "",
    };
  }

  const normalized = normalizeText(source);
  let qualitative = "";
  if (/не\s+обнаруж|отрицател|negative|not detected/.test(normalized)) qualitative = "negative";
  else if (/обнаруж|положител|positive|detected/.test(normalized)) qualitative = "positive";
  else if (/след|trace/.test(normalized)) qualitative = "trace";

  return {
    value_text: source,
    value: "",
    numeric_value: null,
    comparator: "",
    qualitative_value: qualitative,
  };
}

function parseReference(text) {
  const source = stripMarkdown(text || "");
  const range = source.match(/(?:референс|норм[аы]?|reference|ref\.?)\D{0,20}([<>≤≥]?\s*\d+(?:[,.]\d+)?)\s*[-–—]\s*([<>≤≥]?\s*\d+(?:[,.]\d+)?)/iu);
  if (range) {
    return {
      reference_low: parseNumber(range[1].replace(/[<>≤≥]/g, "")),
      reference_high: parseNumber(range[2].replace(/[<>≤≥]/g, "")),
      reference_text: range[0],
    };
  }

  const oneSided = source.match(/(?:референс|норм[аы]?|reference|ref\.?)\D{0,20}([<>≤≥])\s*(\d+(?:[,.]\d+)?)/iu);
  if (oneSided) {
    return {
      reference_low: null,
      reference_high: null,
      reference_text: oneSided[0],
    };
  }

  return { reference_low: null, reference_high: null, reference_text: "" };
}

function detectAbnormal(text) {
  const normalized = normalizeText(text);
  if (/выше|повыш|high|выходит за|↑/.test(normalized)) return true;
  if (/ниже|сниж|low|↓/.test(normalized)) return true;
  return null;
}

function metricAliases(metric) {
  return [metric.label, ...(metric.aliases || [])].filter(Boolean);
}

function findKnownMetric(line, dictionary) {
  const normalizedLine = normalizeText(line);
  const matches = [];

  for (const metric of dictionary) {
    for (const alias of metricAliases(metric)) {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias || !lineHasAlias(normalizedLine, normalizedAlias)) continue;
      matches.push({ metric, alias, score: normalizedAlias.length });
    }
  }

  return matches.sort((a, b) => b.score - a.score)[0] || null;
}

function lineHasAlias(normalizedLine, normalizedAlias) {
  if (normalizedAlias.length <= 4) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-zа-яё0-9])${escaped}($|[^a-zа-яё0-9])`, "iu").test(normalizedLine);
  }
  return normalizedLine.includes(normalizedAlias);
}

function valueAfterAlias(line, alias) {
  const index = normalizeText(line).indexOf(normalizeText(alias));
  if (index < 0) return "";
  const tail = line.slice(index + alias.length);
  const qualitative = tail.match(/(?:[:\-–—]|\s)+(не\s+обнаружено|обнаружено|отрицательно|положительно|negative|positive|not detected|detected)/iu);
  if (qualitative) return qualitative[1];
  const numeric = tail.match(/(?:[:\-–—]|\s)+(?:[<>≤≥]\s*)?\d+(?:[,.]\d+)?/u);
  return numeric ? numeric[0].replace(/^[:\s\-–—]+/u, "") : "";
}

function splitMetricLines(text) {
  return String(text || "")
    .split(/\r?\n|[;•]/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length >= 4);
}

function parseKnownMetricLine(line, dictionary) {
  const known = findKnownMetric(line, dictionary);
  if (!known) return null;

  const rawValue = valueAfterAlias(line, known.alias);
  if (!rawValue) return null;

  return {
    metric_id: known.metric.id,
    metric_label: known.metric.label,
    metric_category: known.metric.category || "",
    metric_value_type: known.metric.value_type || "numeric",
    unit: guessUnit(line, rawValue, known.metric.default_unit || ""),
    ...parseValue(rawValue),
    ...parseReference(line),
    is_abnormal: detectAbnormal(line),
    extraction_confidence: "medium",
    source_text: line,
  };
}

function guessUnit(line, rawValue, fallback) {
  const escaped = rawValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line.match(new RegExp(`${escaped}\\s*([A-Za-zА-Яа-яЁё/%^0-9]+(?:/[A-Za-zА-Яа-яЁё0-9]+)?)`, "u"));
  const unit = match?.[1] || "";
  if (!unit || /^\d/.test(unit)) return fallback;
  return unit;
}

function customMetricCandidate(line) {
  const match = stripMarkdown(line).match(/^([^:]{3,80})[:\-–—]\s*([<>≤≥]?\s*\d+(?:[,.]\d+)?|не\s+обнаружено|обнаружено|отрицательно|положительно)\s*([A-Za-zА-Яа-яЁё/%^0-9]+(?:\/[A-Za-zА-Яа-яЁё0-9]+)?)?/iu);
  if (!match) return null;
  const label = match[1].replace(/\s+/g, " ").trim();
  if (/^(пациент|дата|врач|клиника|документ|человек)$/iu.test(label)) return null;
  if (/взятие\s+биоматериала|дата\s+исследования|возраст|пациент/u.test(normalizeText(label))) return null;
  return {
    custom_metric_label: label,
    metric_id: `custom_${slugify(label, "metric").slice(0, 40)}`,
    metric_label: label,
    metric_category: "custom",
    metric_value_type: "unknown",
    unit: match[3] || "",
    ...parseValue(match[2]),
    ...parseReference(line),
    is_abnormal: detectAbnormal(line),
    extraction_confidence: "low",
    source_text: line,
  };
}

function eventCandidateBase(event, people) {
  const data = event.parsed.data || {};
  const person = String(data.person || "");
  const personRecord =
    people.find((item) => item.name === person) ||
    people.find((item) => (item.aliases || []).includes(person)) ||
    null;

  return {
    person,
    person_id: personRecord?.id || slugify(person, "unknown"),
    date: isoDateFromText(data.date) || "",
    source_type: "event",
    source_event_id: String(data.id || ""),
    source_event_path: repoRelative(event.filePath),
    source_files: Array.isArray(data.source_files) ? data.source_files.map(String) : [],
    source_draft_path: "",
  };
}

function draftCandidateBase(draft, people) {
  const person = String(draft.parsed.data.candidate_person || "");
  const personId = String(draft.parsed.data.candidate_person_id || "");
  const personRecord = people.find((item) => item.id === personId) || null;

  return {
    person: personRecord?.name || person,
    person_id: personRecord?.id || personId || slugify(person, "unknown"),
    date: isoDateFromText(draft.parsed.data.candidate_event_date) || "",
    source_type: "ai_review_draft",
    source_event_id: "",
    source_event_path: "",
    source_files: Array.isArray(draft.parsed.data.source_files) ? draft.parsed.data.source_files.map(String) : [],
    source_draft_path: repoRelative(draft.filePath),
  };
}

function completeCandidate(partial, base) {
  const sourceKey = [
    base.source_type,
    base.source_event_id,
    base.source_event_path,
    base.source_draft_path,
    base.source_files.join("|"),
    base.person_id,
    base.date,
    partial.metric_id,
    partial.metric_label,
    partial.value_text,
    partial.unit,
  ].join("::");
  const dedupeKey = hashText(sourceKey, 24);

  return {
    id: `metric-${dedupeKey}`,
    status: "needs_review",
    dedupe_key: dedupeKey,
    ...base,
    metric_id: partial.metric_id,
    metric_label: partial.metric_label,
    metric_category: partial.metric_category,
    metric_value_type: partial.metric_value_type,
    custom_metric_label: partial.custom_metric_label || "",
    value: partial.value,
    numeric_value: partial.numeric_value,
    comparator: partial.comparator,
    qualitative_value: partial.qualitative_value,
    value_text: partial.value_text,
    unit: partial.unit,
    reference_low: partial.reference_low,
    reference_high: partial.reference_high,
    reference_text: partial.reference_text,
    is_abnormal: partial.is_abnormal,
    source_text: partial.source_text,
    extraction_confidence: partial.extraction_confidence,
    reviewed_at: "",
    created_at: new Date().toISOString(),
  };
}

function extractFromEvent(event, dictionary, people) {
  if (event.parsed.data?.type !== "medical_event") return [];
  if (!["done", "approved"].includes(String(event.parsed.data.status || "done"))) return [];
  if (!isoDateFromText(event.parsed.data.date)) return [];

  const sections = parseSections(event.parsed.content);
  const interestingSections = [
    "Краткий итог",
    "Отклонения / важные показатели",
    "Что это",
  ];
  const eventText = normalizeText(
    [
      event.parsed.data.event_type,
      event.parsed.data.specialty,
      event.parsed.data.tags?.join(" "),
      event.parsed.content.match(/^#\s+(.+)$/m)?.[1] || "",
    ].join(" "),
  );
  const isLabLike = /анализ|лаборатор|lab|скрининг|впч|цитолог|мазок|посев|пцр|pcr/.test(eventText);
  const lines = interestingSections.flatMap((name) => sectionList(sections, name));
  const base = eventCandidateBase(event, people);
  const output = [];

  for (const line of lines.flatMap(splitMetricLines)) {
    const known = parseKnownMetricLine(line, dictionary);
    if (known) output.push(completeCandidate(known, base));
    const custom = customMetricCandidate(line);
    if (custom && !known && isLabLike) output.push(completeCandidate(custom, base));
  }

  return output;
}

function parseDraftMetricTable(content) {
  const lines = String(content || "").split(/\r?\n/);
  const output = [];
  let inside = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      inside = stripMarkdown(heading[1]) === "Возможные показатели";
      continue;
    }
    if (!inside || !line.trim().startsWith("|")) continue;
    if (/^\|\s*-+/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => stripMarkdown(cell).trim());
    if (cells.length < 3 || cells[0] === "Показатель") continue;
    output.push({
      label: cells[0],
      value: cells[1],
      unit: cells[2],
      reference: cells[3] || "",
      comment: cells[4] || "",
      raw: line,
    });
  }

  return output;
}

function extractFromDraft(draft, dictionary, people) {
  if (draft.parsed.data?.type !== "ai_review_draft") return [];
  if (draft.parsed.data?.status !== "approved") return [];

  const base = draftCandidateBase(draft, people);
  const output = [];

  for (const row of parseDraftMetricTable(draft.parsed.content)) {
    const known = findKnownMetric(row.label, dictionary);
    const metric = known?.metric;
    const partial = {
      metric_id: metric?.id || `custom_${slugify(row.label, "metric").slice(0, 40)}`,
      metric_label: metric?.label || row.label,
      metric_category: metric?.category || "custom",
      metric_value_type: metric?.value_type || "unknown",
      custom_metric_label: metric ? "" : row.label,
      unit: row.unit || metric?.default_unit || "",
      ...parseValue(row.value),
      ...parseReference(`${row.reference} ${row.comment}`),
      is_abnormal: detectAbnormal(`${row.reference} ${row.comment}`),
      extraction_confidence: metric ? "high" : "medium",
      source_text: [row.label, row.value, row.unit, row.reference, row.comment].filter(Boolean).join(" | "),
    };
    if (partial.value_text) output.push(completeCandidate(partial, base));
  }

  return output;
}

async function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, output);
    } else if (entry.name !== ".gitkeep") {
      output.push(fullPath);
    }
  }
  return output;
}

async function loadEvents() {
  const files = await findMarkdownFiles();
  const output = [];
  for (const filePath of files) {
    const raw = await fsp.readFile(filePath, "utf8");
    output.push({ filePath, parsed: matter(raw) });
  }
  return output;
}

async function loadDrafts() {
  const folders = ["10 Черновики AI", "20 На проверке", "30 Одобрено", "90 Обработано"];
  const files = [];
  for (const folder of folders) {
    await walkFiles(path.join(inboxDir, folder), files);
  }

  const output = [];
  for (const filePath of files.filter((item) => path.extname(item).toLowerCase() === ".md")) {
    const raw = await fsp.readFile(filePath, "utf8");
    output.push({ filePath, parsed: matter(raw) });
  }
  return output;
}

function keepRepeatedCustomCandidates(candidates) {
  const customCounts = new Map();
  for (const candidate of candidates.filter((item) => item.metric_category === "custom")) {
    const key = compactTextKey(candidate.custom_metric_label || candidate.metric_label);
    customCounts.set(key, (customCounts.get(key) || 0) + 1);
  }

  return candidates.filter((candidate) => {
    if (candidate.metric_category !== "custom") return true;
    const key = compactTextKey(candidate.custom_metric_label || candidate.metric_label);
    return (customCounts.get(key) || 0) >= 2;
  });
}

function uniqueByDedupeKey(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    if (!candidate.person_id || !candidate.date || !candidate.value_text) continue;
    if (seen.has(candidate.dedupe_key)) continue;
    seen.add(candidate.dedupe_key);
    output.push(candidate);
  }
  return output;
}

function renderReviewMarkdown(payload) {
  const lines = [
    "# Проверка показателей",
    "",
    "Что проверять: человек, дата, название показателя, значение и единицы измерения.",
    "",
    "Галочку ставьте только если верхняя строка совпадает со строкой `Текст` под ней. Если сомневаетесь, оставьте без галочки.",
    "",
    "После проверки напишите мне: `галочки поставлены`. Я сам перенесу одобренные строки в `metrics.json` и проверю дубли.",
    "",
    `Кандидатов: ${payload.candidates.length}`,
    "",
  ];

  const byPerson = new Map();
  for (const candidate of payload.candidates) {
    const key = candidate.person || "Не указан";
    byPerson.set(key, [...(byPerson.get(key) || []), candidate]);
  }

  for (const [person, candidates] of byPerson.entries()) {
    lines.push(`## ${person}`, "");
    const sorted = [...candidates].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.metric_label).localeCompare(String(b.metric_label), "ru"),
    );

    for (const candidate of sorted) {
      const checked = candidate.status === "approved" || candidate.status === "imported" ? "x" : " ";
      const ref = candidate.reference_text ? `; референс: ${candidate.reference_text}` : "";
      const abnormal = candidate.is_abnormal === true ? "; отмечено как отклонение" : "";
      lines.push(`- [${checked}] ${candidate.date} — ${candidate.metric_label}: **${candidate.value_text}${candidate.unit ? ` ${candidate.unit}` : ""}**${ref}${abnormal} <!-- ${candidate.id} -->`);
      lines.push(`  - Источник: ${candidate.source_event_path || candidate.source_draft_path || candidate.source_files.join(", ")}`);
      lines.push(`  - Текст: ${candidate.source_text}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function checkedReviewIds() {
  try {
    const raw = await fsp.readFile(reviewPath, "utf8");
    const ids = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const visibleId = line.match(/^\s*-\s*\[[xX]\]\s*`([^`]+)`/);
      if (visibleId) ids.add(visibleId[1]);
      const hiddenId = line.match(/^\s*-\s*\[[xX]\].*<!--\s*(metric-[a-f0-9]+)\s*-->/);
      if (hiddenId) ids.add(hiddenId[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function scanMetrics() {
  const [dictionary, people, events, drafts, metricsJson] = await Promise.all([
    loadDictionary(),
    loadPeople(),
    loadEvents(),
    loadDrafts(),
    readJson(metricsPath, { records: [] }),
  ]);

  const existingKeys = new Set((metricsJson.records || []).map((record) => record.dedupe_key).filter(Boolean));
  const rawCandidates = [
    ...events.flatMap((event) => extractFromEvent(event, dictionary, people)),
    ...drafts.flatMap((draft) => extractFromDraft(draft, dictionary, people)),
  ];
  const candidates = uniqueByDedupeKey(keepRepeatedCustomCandidates(rawCandidates)).filter(
    (candidate) => !existingKeys.has(candidate.dedupe_key),
  );
  const payload = {
    schema_version: 1,
    status: "needs_review",
    generated_at: new Date().toISOString(),
    instructions: "Проверьте candidates и поставьте status: approved только тем строкам, которые можно переносить в metrics.json.",
    candidates,
  };

  await writeJson(candidatesPath, payload);
  await writeText(reviewPath, renderReviewMarkdown(payload));
  console.log(`Metrics scan complete: ${candidates.length} candidate(s) written to ${repoRelative(candidatesPath)}.`);
  console.log(`Review note written to ${repoRelative(reviewPath)}.`);
  if (dryRun) console.log("Dry run: no files were written.");
}

async function applyMetrics() {
  const [candidatesJson, metricsJson, checkedIds] = await Promise.all([
    readJson(candidatesPath, { candidates: [] }),
    readJson(metricsPath, { schema_version: 1, records: [] }),
    checkedReviewIds(),
  ]);

  const existing = metricsJson.records || [];
  const existingKeys = new Set(existing.map((record) => record.dedupe_key).filter(Boolean));
  const approved = (candidatesJson.candidates || []).filter(
    (candidate) => candidate.status === "approved" || checkedIds.has(candidate.id),
  );
  const additions = [];

  for (const candidate of approved) {
    if (existingKeys.has(candidate.dedupe_key)) continue;
    existingKeys.add(candidate.dedupe_key);
    additions.push({
      ...candidate,
      status: "approved",
      approved_at: candidate.reviewed_at || new Date().toISOString(),
    });
  }

  const nextMetrics = {
    schema_version: metricsJson.schema_version || 1,
    updated_at: new Date().toISOString(),
    records: [...existing, ...additions].sort((a, b) =>
      String(a.person_id).localeCompare(String(b.person_id)) ||
      String(a.metric_id).localeCompare(String(b.metric_id)) ||
      String(a.date).localeCompare(String(b.date)),
    ),
  };

  const nextCandidates = {
    ...candidatesJson,
    candidates: (candidatesJson.candidates || []).map((candidate) =>
      additions.some((record) => record.dedupe_key === candidate.dedupe_key)
        ? { ...candidate, status: "imported", imported_at: new Date().toISOString() }
        : checkedIds.has(candidate.id)
          ? { ...candidate, status: "approved", reviewed_at: candidate.reviewed_at || new Date().toISOString() }
        : candidate,
    ),
  };

  await writeJson(metricsPath, nextMetrics);
  await writeJson(candidatesPath, nextCandidates);
  await writeText(reviewPath, renderReviewMarkdown(nextCandidates));
  console.log(`Metrics apply complete: ${additions.length} approved record(s) appended to ${repoRelative(metricsPath)}.`);
  if (dryRun) console.log("Dry run: no files were written.");
}

if (flags.has("--help") || flags.has("-h")) {
  usage();
} else if (command === "scan") {
  await scanMetrics();
} else if (command === "apply") {
  await applyMetrics();
} else {
  usage();
  process.exitCode = 1;
}
