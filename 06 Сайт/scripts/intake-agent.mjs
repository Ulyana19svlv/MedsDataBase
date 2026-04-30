import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { hashText, isoDateFromText, repoRelative, repoRoot, slugify, stripMarkdown } from "./dashboard-lib.mjs";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--")) || "scan";
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");
const includeAll = flags.has("--all");

const inboxDir = path.join(repoRoot, "04 Входящие");
const statePath = path.join(inboxDir, "intake-state.json");

const paths = {
  inboxNew: path.join(inboxDir, "00 Новые файлы"),
  drafts: path.join(inboxDir, "10 Черновики AI"),
  review: path.join(inboxDir, "20 На проверке"),
  approved: path.join(inboxDir, "30 Одобрено"),
  processed: path.join(inboxDir, "90 Обработано"),
  errors: path.join(inboxDir, "99 Ошибки"),
};

const textExtensions = new Set([".txt", ".md", ".csv", ".json"]);
const knownAssetExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

function usage() {
  console.log(`Medical intake agent

Usage:
  npm run agent:intake
  npm run agent:intake -- --dry-run
  npm run agent:promote
  npm run agent:promote -- --dry-run

Commands:
  scan      Create AI-review drafts for files in "04 Входящие/00 Новые файлы".
  promote   Convert approved drafts into medical_event notes and copy source files.

Safety:
  scan never writes to "01 Члены семьи".
  promote only processes drafts with status: approved.
`);
}

async function readJson(relativePath) {
  return JSON.parse(await fsp.readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function loadReferences() {
  const [peopleJson, specialtiesJson, documentTypesJson, metricsJson] = await Promise.all([
    readJson("02 Справочники/people.json"),
    readJson("02 Справочники/specialties.json"),
    readJson("02 Справочники/document_types.json"),
    readJson("02 Справочники/metric_dictionary.json"),
  ]);

  return {
    people: peopleJson.people || [],
    specialties: specialtiesJson.specialties || [],
    documentTypes: documentTypesJson.document_types || [],
    metrics: metricsJson.metrics || [],
  };
}

async function ensureFolders() {
  await Promise.all(Object.values(paths).map((dir) => fsp.mkdir(dir, { recursive: true })));
}

async function loadState() {
  try {
    return JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch {
    return { schema_version: 1, files: [] };
  }
}

async function saveState(state) {
  if (dryRun) return;
  state.updated_at = new Date().toISOString();
  await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

async function fileFingerprint(filePath) {
  const stat = await fsp.stat(filePath);
  const hash = crypto.createHash("sha256");
  hash.update(repoRelative(filePath));
  hash.update(String(stat.size));
  hash.update(String(stat.mtimeMs));
  return hash.digest("hex").slice(0, 16);
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function yamlScalar(value) {
  if (value === null || value === undefined || value === "") return null;
  return value;
}

function frontmatterDate() {
  return new Date().toISOString().slice(0, 10);
}

function scoreAlias(text, aliases) {
  let score = 0;
  for (const alias of aliases || []) {
    const needle = normalizeText(alias);
    if (needle && text.includes(needle)) score += Math.max(needle.length, 4);
  }
  return score;
}

function bestByAliases(text, records, fallbackId) {
  const normalized = normalizeText(text);
  let best = null;
  let bestScore = 0;

  for (const record of records) {
    const aliases = [record.name, record.label, ...(record.aliases || [])].filter(Boolean);
    const score = scoreAlias(normalized, aliases);
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }

  if (best) return { record: best, score: bestScore };
  const fallback = records.find((record) => record.id === fallbackId) || null;
  return { record: fallback, score: 0 };
}

function detectClinic(text) {
  const patterns = [
    /(?:клиника|медицинский центр|мц|лаборатория)\s*[:\-]?\s*([^\n\r.;]+)/iu,
    /(?:организация|учреждение)\s*[:\-]?\s*([^\n\r.;]+)/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return stripMarkdown(match[1]).slice(0, 80);
  }
  return "";
}

function detectDoctor(text) {
  const patterns = [
    /(?:врач|доктор|специалист)\s*[:\-]?\s*([А-ЯЁ][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁ][А-ЯЁа-яё\-]+){1,2})/u,
    /([А-ЯЁ][А-ЯЁа-яё\-]+\s+[А-ЯЁ][А-ЯЁа-яё\-]+\s+[А-ЯЁ][А-ЯЁа-яё\-]+)\s*(?:врач|доктор|специалист)/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return stripMarkdown(match[1]).slice(0, 80);
  }
  return "";
}

function detectDate(text, fileName) {
  return isoDateFromText(fileName) || isoDateFromText(text) || null;
}

function summarizeText(text, fallback) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length >= 12 && !/^[-_=]+$/.test(line));

  if (!lines.length) return [`Текст документа не извлечен автоматически. Проверьте исходный файл: ${fallback}.`];
  return lines.slice(0, 5);
}

function detectMetricCandidates(text, metricDictionary) {
  const output = [];
  const normalized = normalizeText(text);

  for (const metric of metricDictionary) {
    const aliases = [metric.label, ...(metric.aliases || [])].filter(Boolean);
    const matchedAlias = aliases.find((alias) => normalizeText(alias) && normalized.includes(normalizeText(alias)));
    if (!matchedAlias) continue;

    const escaped = matchedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}[^\\d\\n\\r]{0,40}([<>]?\\s*\\d+(?:[,.]\\d+)?)\\s*([A-Za-zА-Яа-яЁё/%]+)?`, "iu");
    const match = text.match(pattern);
    output.push({
      metric_id: metric.id,
      label: metric.label,
      value: match?.[1]?.replace(/\s+/g, "")?.replace(",", ".") || "",
      unit: match?.[2] || metric.default_unit || "",
    });
  }

  return output.slice(0, 12);
}

function detectTaskCandidates(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line).trim())
    .filter(Boolean);

  return lines
    .filter((line) => /контроль|повторн|через\s+\d|наблюден|сдать|пересдать|консультац|осмотр|рекоменд/u.test(line.toLowerCase()))
    .slice(0, 8);
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (textExtensions.has(ext)) {
    return {
      text: await fsp.readFile(filePath, "utf8"),
      extraction: "text",
      extractionWarning: "",
    };
  }

  return {
    text: path.basename(filePath),
    extraction: knownAssetExtensions.has(ext) ? "metadata_only" : "unsupported",
    extractionWarning:
      ext === ".pdf"
        ? "PDF пока разобран только по имени файла. Для содержимого нужен следующий слой: OCR/LLM или PDF text extraction."
        : "Файл пока разобран только по имени файла. Для фото нужен OCR/LLM-слой.",
  };
}

function buildAnalysis(filePath, extractedText, references) {
  const fileName = path.basename(filePath);
  const textForDetection = `${fileName}\n${extractedText.text}`;
  const person = bestByAliases(textForDetection, references.people, null);
  const specialty = bestByAliases(textForDetection, references.specialties, "other");
  const documentType = bestByAliases(textForDetection, references.documentTypes, "unknown");
  const eventDate = detectDate(textForDetection, fileName);
  const doctor = detectDoctor(extractedText.text);
  const clinic = detectClinic(extractedText.text);
  const metrics = detectMetricCandidates(extractedText.text, references.metrics);
  const tasks = detectTaskCandidates(extractedText.text);

  let confidencePoints = 0;
  if (person.score > 0) confidencePoints += 2;
  if (eventDate) confidencePoints += 2;
  if (specialty.score > 0) confidencePoints += 1;
  if (documentType.score > 0) confidencePoints += 1;
  if (extractedText.extraction === "text") confidencePoints += 1;

  const confidence = confidencePoints >= 6 ? "high" : confidencePoints >= 3 ? "medium" : "low";

  return {
    source_file: repoRelative(filePath),
    file_name: fileName,
    extraction: extractedText.extraction,
    extraction_warning: extractedText.extractionWarning,
    person: person.record || null,
    specialty: specialty.record || null,
    document_type: documentType.record || null,
    event_date: eventDate,
    doctor,
    clinic,
    summary: summarizeText(extractedText.text, fileName),
    metrics,
    tasks,
    confidence,
    needs_human_review: true,
  };
}

function draftSlug(analysis, fingerprint) {
  const datePart = analysis.event_date || frontmatterDate();
  const personPart = analysis.person?.id || "unknown";
  const typePart = analysis.document_type?.id || "document";
  return `${datePart}-${personPart}-${typePart}-${fingerprint.slice(0, 8)}`;
}

function draftMarkdown(analysis, fingerprint) {
  const id = `draft-${fingerprint}`;
  const createdAt = frontmatterDate();
  const titlePerson = analysis.person?.name || "человек не определен";
  const titleDate = analysis.event_date || "дата не определена";
  const sourceFiles = [analysis.source_file];
  const metricsTable = analysis.metrics.length
    ? analysis.metrics
        .map((metric) => `| ${metric.label} | ${metric.value || ""} | ${metric.unit || ""} | | |`)
        .join("\n")
    : "| | | | | |";
  const taskLines = analysis.tasks.length ? analysis.tasks.map((task) => `- ${task}`).join("\n") : "- ";
  const summaryLines = analysis.summary.map((line) => `- ${line}`).join("\n");
  const questions = [];

  if (!analysis.person) questions.push("Не удалось уверенно определить члена семьи.");
  if (!analysis.event_date) questions.push("Не удалось уверенно определить дату события.");
  if (analysis.extraction_warning) questions.push(analysis.extraction_warning);
  if (!questions.length) questions.push("Проверить, что распознавание не исказило исходный документ.");

  const data = {
    id,
    type: "ai_review_draft",
    status: "needs_review",
    created_at: createdAt,
    source_files: sourceFiles,
    candidate_person_id: yamlScalar(analysis.person?.id),
    candidate_person: yamlScalar(analysis.person?.name),
    candidate_event_date: yamlScalar(analysis.event_date),
    candidate_document_type_id: yamlScalar(analysis.document_type?.id),
    candidate_specialty_id: yamlScalar(analysis.specialty?.id),
    candidate_doctor: yamlScalar(analysis.doctor),
    candidate_clinic: yamlScalar(analysis.clinic),
    confidence: analysis.confidence,
    needs_human_review: true,
  };

  const body = `# Черновик AI-разбора — ${titlePerson}, ${titleDate}

## Исходные файлы
${sourceFiles.map((source) => `- ${source}`).join("\n")}

## Что агент распознал
- Человек: ${analysis.person?.name || ""}
- Дата события: ${analysis.event_date || ""}
- Тип документа: ${analysis.document_type?.label || ""}
- Направление: ${analysis.specialty?.label || ""}
- Врач: ${analysis.doctor || ""}
- Клиника: ${analysis.clinic || ""}
- Уверенность: ${analysis.confidence}

## Краткая сводка
${summaryLines}

## Возможные показатели
| Показатель | Значение | Ед. | Референс | Комментарий |
|---|---:|---|---|---|
${metricsTable}

## Возможные задачи контроля
${taskLines}

## Вопросы / сомнения агента
${questions.map((question) => `- ${question}`).join("\n")}

## Проверка человеком
- [ ] Человек определен верно
- [ ] Дата определена верно
- [ ] Направление определено верно
- [ ] Сводка не искажает документ
- [ ] Можно создавать медицинское событие

## Решение
- Статус: needs_review
- Комментарий:
`;

  return matter.stringify(body, data);
}

async function scanInbox() {
  await ensureFolders();
  const references = await loadReferences();
  const state = await loadState();
  const known = new Set(state.files.map((record) => record.fingerprint));
  const files = await walkFiles(paths.inboxNew);
  const created = [];
  const skipped = [];

  for (const filePath of files) {
    const fingerprint = await fileFingerprint(filePath);
    if (!includeAll && known.has(fingerprint)) {
      skipped.push(repoRelative(filePath));
      continue;
    }

    const extracted = await extractText(filePath);
    const analysis = buildAnalysis(filePath, extracted, references);
    const slug = draftSlug(analysis, fingerprint);
    const draftPath = path.join(paths.drafts, `${slug}.md`);
    const draftRelative = repoRelative(draftPath);
    const draftContent = draftMarkdown(analysis, fingerprint);

    if (!dryRun) {
      await fsp.writeFile(draftPath, draftContent, "utf8");
      state.files.push({
        fingerprint,
        source_file: repoRelative(filePath),
        draft_file: draftRelative,
        status: "draft_created",
        created_at: new Date().toISOString(),
      });
    }

    created.push({ source: repoRelative(filePath), draft: draftRelative, confidence: analysis.confidence });
  }

  await saveState(state);

  console.log(`Intake scan complete: ${created.length} draft(s), ${skipped.length} skipped.`);
  for (const item of created) {
    console.log(`+ ${item.source} -> ${item.draft} (${item.confidence})`);
  }
  if (dryRun) console.log("Dry run: no files were written.");
}

async function findApprovedDrafts() {
  const draftFiles = [
    ...(await walkFiles(paths.drafts)),
    ...(await walkFiles(paths.review)),
    ...(await walkFiles(paths.approved)),
  ].filter((filePath) => path.extname(filePath).toLowerCase() === ".md");

  const approved = [];
  for (const filePath of draftFiles) {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = matter(raw);
    if (parsed.data?.type === "ai_review_draft" && parsed.data?.status === "approved") {
      approved.push({ filePath, raw, parsed });
    }
  }
  return approved;
}

function labelById(records, id, fallback = "") {
  return records.find((record) => record.id === id)?.label || fallback;
}

function personById(people, id) {
  return people.find((person) => person.id === id) || null;
}

async function findOrCreateSpecialtyFolder(person, specialtyLabel) {
  const personDir = path.join(repoRoot, person.folder);
  await fsp.mkdir(personDir, { recursive: true });
  const entries = await fsp.readdir(personDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const specialtyNorm = normalizeText(specialtyLabel);

  const existing = directories.find((dir) => {
    const clean = normalizeText(dir.replace(/^\d+\s+/, ""));
    return clean === specialtyNorm || clean.includes(specialtyNorm) || specialtyNorm.includes(clean);
  });
  if (existing) return path.join(personDir, existing);

  const numbers = directories
    .map((dir) => Number(dir.match(/^(\d+)/)?.[1]))
    .filter((number) => Number.isFinite(number));
  const next = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, "0");
  const folderName = `${next} ${specialtyLabel || "Другое"}`;
  return path.join(personDir, folderName);
}

async function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let index = 2; index < 100; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot create unique path for ${targetPath}`);
}

function eventTypeFromDocumentType(documentTypeId) {
  if (documentTypeId === "lab_result") return "Анализ";
  if (["imaging_result", "functional_test"].includes(documentTypeId)) return "Обследование";
  if (documentTypeId === "doctor_report") return "Приём";
  if (documentTypeId === "prescription") return "Назначение";
  return "Событие";
}

function extractSection(content, title) {
  const lines = String(content || "").split(/\r?\n/);
  const bucket = [];
  let inside = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (inside) break;
      inside = stripMarkdown(heading[1]) === title;
      continue;
    }
    if (inside) bucket.push(line);
  }

  return bucket.join("\n").trim();
}

function extractBullets(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function buildEventMarkdown({ draft, person, specialtyLabel, documentTypeId, copiedFiles }) {
  const data = draft.parsed.data;
  const eventDate = data.candidate_event_date;
  const eventType = eventTypeFromDocumentType(documentTypeId);
  const title = `${person.name} — ${specialtyLabel || "медицинское событие"}`;
  const id = slugify(`${eventDate}-${person.id}-${specialtyLabel || documentTypeId}-${hashText(draft.filePath, 6)}`);
  const summary = extractBullets(extractSection(draft.parsed.content, "Краткая сводка"));
  const tasks = extractBullets(extractSection(draft.parsed.content, "Возможные задачи контроля"));

  const frontmatter = {
    id,
    type: "medical_event",
    person: person.name,
    date: eventDate,
    event_type: eventType,
    specialty: specialtyLabel || "Другое",
    doctor: yamlScalar(data.candidate_doctor),
    clinic: yamlScalar(data.candidate_clinic),
    status: "done",
    importance: "normal",
    follow_up_date: null,
    source_files: copiedFiles.map((filePath) => path.basename(filePath)),
    tags: ["imported", slugify(eventType), slugify(specialtyLabel || "other")],
  };

  const body = `# ${title} — ${eventDate}

## Человек
- [[Профиль — ${person.name}]]

## Документ
${copiedFiles.map((filePath) => `- [[${path.basename(filePath)}]]`).join("\n") || "- "}

## Что это
Событие создано из проверенного входящего черновика: ${repoRelative(draft.filePath)}.

## Краткий итог
${summary.length ? summary.map((item) => `- ${item}`).join("\n") : "- "}

## Что важно отследить
- 

## Что делать дальше
${tasks.length ? tasks.map((item) => `- ${item}`).join("\n") : "- "}
`;

  return matter.stringify(body, frontmatter);
}

async function promoteDrafts() {
  await ensureFolders();
  const references = await loadReferences();
  const state = await loadState();
  const approved = await findApprovedDrafts();
  const promoted = [];
  const errors = [];

  for (const draft of approved) {
    const data = draft.parsed.data;
    const person = personById(references.people, data.candidate_person_id);
    const eventDate = isoDateFromText(data.candidate_event_date);
    const documentTypeId = data.candidate_document_type_id || "unknown";
    const specialtyLabel = labelById(references.specialties, data.candidate_specialty_id, "Другое");

    if (!person || !eventDate) {
      errors.push(`${repoRelative(draft.filePath)}: missing approved person/date`);
      continue;
    }

    const specialtyDir = await findOrCreateSpecialtyFolder(person, specialtyLabel);
    const yearDir = path.join(specialtyDir, `${path.basename(specialtyDir)} ${eventDate.slice(0, 4)}`);
    const clinicDir = path.join(yearDir, data.candidate_clinic || "Без клиники");
    const eventFileName = `${eventDate} ${person.name} — ${specialtyLabel}.md`;
    const eventPath = await uniquePath(path.join(clinicDir, eventFileName));
    const sourceRefs = data.source_files || [];
    const copiedFiles = [];

    if (!sourceRefs.length) {
      errors.push(`${repoRelative(draft.filePath)}: no source_files in approved draft`);
      continue;
    }

    const missingSources = sourceRefs.filter((source) => !fs.existsSync(path.join(repoRoot, source)));
    if (missingSources.length) {
      for (const source of missingSources) {
        errors.push(`${repoRelative(draft.filePath)}: source file not found: ${source}`);
      }
      continue;
    }

    if (!dryRun) await fsp.mkdir(clinicDir, { recursive: true });

    for (const source of sourceRefs) {
      const sourcePath = path.join(repoRoot, source);
      const targetPath = await uniquePath(path.join(clinicDir, path.basename(sourcePath)));
      if (!dryRun) await fsp.copyFile(sourcePath, targetPath);
      copiedFiles.push(targetPath);

      if (!dryRun && sourcePath.startsWith(inboxDir + path.sep) && !sourcePath.startsWith(paths.processed + path.sep)) {
        const processedSourcePath = await uniquePath(path.join(paths.processed, path.basename(sourcePath)));
        await fsp.rename(sourcePath, processedSourcePath);
        const stateRecord = state.files.find((record) => record.source_file === source);
        if (stateRecord) {
          stateRecord.status = "processed";
          stateRecord.source_file_processed = repoRelative(processedSourcePath);
          stateRecord.event_file = repoRelative(eventPath);
          stateRecord.processed_at = new Date().toISOString();
        }
      }
    }

    const eventContent = buildEventMarkdown({
      draft,
      person,
      specialtyLabel,
      documentTypeId,
      copiedFiles,
    });

    const processedDraftPath = path.join(paths.processed, path.basename(draft.filePath));
    if (!dryRun) {
      await fsp.writeFile(eventPath, eventContent, "utf8");
      const finalProcessedDraftPath = await uniquePath(processedDraftPath);
      await fsp.rename(draft.filePath, finalProcessedDraftPath);
      const draftRelative = repoRelative(draft.filePath);
      for (const stateRecord of state.files.filter((record) => record.draft_file === draftRelative)) {
        stateRecord.status = "processed";
        stateRecord.draft_file_processed = repoRelative(finalProcessedDraftPath);
        stateRecord.event_file = repoRelative(eventPath);
        stateRecord.processed_at = new Date().toISOString();
      }
    }

    promoted.push({ draft: repoRelative(draft.filePath), event: repoRelative(eventPath) });
  }

  await saveState(state);

  console.log(`Promote complete: ${promoted.length} event(s), ${errors.length} issue(s).`);
  for (const item of promoted) console.log(`+ ${item.draft} -> ${item.event}`);
  for (const error of errors) console.error(`Error: ${error}`);
  if (dryRun) console.log("Dry run: no files were written.");
  if (errors.length) process.exitCode = 1;
}

if (flags.has("--help") || flags.has("-h")) {
  usage();
} else if (command === "scan") {
  await scanInbox();
} else if (command === "promote") {
  await promoteDrafts();
} else {
  usage();
  process.exitCode = 1;
}
