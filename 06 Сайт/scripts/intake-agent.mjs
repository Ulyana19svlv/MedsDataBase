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
const noAi = flags.has("--no-ai");
const moveErrors = flags.has("--move-errors");

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, "06 Сайт", ".env"));

const inboxDir = path.join(repoRoot, "04 Входящие");
const statePath = path.join(inboxDir, "intake-state.json");
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

const paths = {
  inboxNew: path.join(inboxDir, "00 Новые файлы"),
  drafts: path.join(inboxDir, "10 Черновики AI"),
  review: path.join(inboxDir, "20 На проверке"),
  approved: path.join(inboxDir, "30 Одобрено"),
  processed: path.join(inboxDir, "90 Обработано"),
  errors: path.join(inboxDir, "99 Ошибки"),
};

const textExtensions = new Set([".txt", ".md", ".csv", ".json"]);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const pdfExtensions = new Set([".pdf"]);
const allowedExtensions = new Set([...textExtensions, ...imageExtensions, ...pdfExtensions]);

function usage() {
  console.log(`Medical intake agent

Usage:
  npm run agent:intake
  npm run agent:intake -- --dry-run
  npm run agent:intake -- --no-ai
  npm run agent:intake -- --move-errors
  npm run agent:promote
  npm run agent:promote -- --dry-run

Commands:
  scan      Read files in "04 Входящие/00 Новые файлы", rename them, and create AI-review drafts.
  promote   Convert approved drafts into medical_event notes and copy renamed source files.

Environment:
  OPENAI_API_KEY is required for PDF/image content extraction.
  OPENAI_MODEL is optional; default: ${openaiModel}.

Safety:
  scan renames files only inside "04 Входящие/00 Новые файлы" and creates drafts.
  Failed files stay in place unless --move-errors is passed.
  promote only processes drafts with status: approved.
`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
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
  const bytes = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
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

function byId(records, id) {
  return records.find((record) => record.id === id) || null;
}

function sanitizeFilenamePart(value, fallback = "Документ") {
  const clean = stripMarkdown(value || fallback)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return clean || fallback;
}

function uniqueDisplayTitle(parts) {
  return parts.map((part) => sanitizeFilenamePart(part, "")).filter(Boolean).join(" — ");
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

function detectClinic(text) {
  const patterns = [
    /(?:клиника|медицинский центр|мц|лаборатория|центр)\s*[:\-]?\s*([^\n\r.;]+)/iu,
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
    /(?:врач|доктор|специалист)\s*[:\-]?\s*([А-ЯЁ][А-ЯЁа-яё-]+(?:\s+[А-ЯЁ][А-ЯЁа-яё-]+){1,2})/u,
    /([А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ][А-ЯЁа-яё-]+)\s*(?:врач|доктор|специалист)/u,
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
  return lines.slice(0, 6);
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
      reference: "",
      comment: "",
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

async function readTextFallback(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!textExtensions.has(ext)) {
    return {
      text: path.basename(filePath),
      extraction: "metadata_only",
      extractionWarning:
        ext === ".pdf"
          ? "PDF не был прочитан по содержимому, потому что не задан OPENAI_API_KEY."
          : "Изображение не было прочитано по содержимому, потому что не задан OPENAI_API_KEY.",
    };
  }

  return {
    text: await fsp.readFile(filePath, "utf8"),
    extraction: "text",
    extractionWarning: "",
  };
}

function localAnalysis(filePath, extractedText, references) {
  const fileName = path.basename(filePath);
  const textForDetection = `${fileName}\n${extractedText.text}`;
  const person = bestByAliases(textForDetection, references.people, null);
  const specialty = bestByAliases(textForDetection, references.specialties, "other");
  const documentType = bestByAliases(textForDetection, references.documentTypes, "unknown");
  const eventDate = detectDate(textForDetection, fileName);
  const doctor = detectDoctor(extractedText.text);
  const clinic = detectClinic(extractedText.text);

  let confidencePoints = 0;
  if (person.score > 0) confidencePoints += 2;
  if (eventDate) confidencePoints += 2;
  if (specialty.score > 0) confidencePoints += 1;
  if (documentType.score > 0) confidencePoints += 1;
  if (extractedText.extraction === "text") confidencePoints += 1;

  return normalizeAnalysis(
    {
      person_id: person.record?.id || "",
      person_name: person.record?.name || "",
      event_date: eventDate || "",
      document_type_id: documentType.record?.id || "unknown",
      document_title: "",
      specialty_id: specialty.record?.id || "other",
      specialty_label: specialty.record?.label || "",
      doctor,
      clinic,
      summary: summarizeText(extractedText.text, fileName),
      metrics: detectMetricCandidates(extractedText.text, references.metrics),
      tasks: detectTaskCandidates(extractedText.text),
      confidence: confidencePoints >= 6 ? "high" : confidencePoints >= 3 ? "medium" : "low",
      needs_human_review: true,
      uncertainties: [extractedText.extractionWarning].filter(Boolean),
      recommended_file_title: "",
    },
    references,
    filePath,
    extractedText.extraction,
    extractedText.extractionWarning,
  );
}

function extractionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "person_id",
      "person_name",
      "event_date",
      "document_type_id",
      "document_title",
      "specialty_id",
      "specialty_label",
      "doctor",
      "clinic",
      "summary",
      "metrics",
      "tasks",
      "confidence",
      "needs_human_review",
      "uncertainties",
      "recommended_file_title",
    ],
    properties: {
      person_id: { type: "string" },
      person_name: { type: "string" },
      event_date: { type: "string", description: "YYYY-MM-DD or empty string if unknown" },
      document_type_id: { type: "string" },
      document_title: { type: "string", description: "Short human title in Russian, e.g. Кардиолог, Анализ крови, УЗИ щитовидной железы" },
      specialty_id: { type: "string" },
      specialty_label: { type: "string" },
      doctor: { type: "string" },
      clinic: { type: "string" },
      summary: { type: "array", items: { type: "string" } },
      metrics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["metric_id", "label", "value", "unit", "reference", "comment"],
          properties: {
            metric_id: { type: "string" },
            label: { type: "string" },
            value: { type: "string" },
            unit: { type: "string" },
            reference: { type: "string" },
            comment: { type: "string" },
          },
        },
      },
      tasks: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      needs_human_review: { type: "boolean" },
      uncertainties: { type: "array", items: { type: "string" } },
      recommended_file_title: { type: "string" },
    },
  };
}

function responseOutputText(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

function dataUrlForImage(filePath, base64) {
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

async function aiExtract(filePath, references) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to read PDF/image contents. Add it to .env or environment variables.");
  }

  const stat = await fsp.stat(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error(`${repoRelative(filePath)} is larger than 50 MB and cannot be sent as one OpenAI file input.`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const base64 = (await fsp.readFile(filePath)).toString("base64");
  const fileName = path.basename(filePath);
  const referencePayload = {
    people: references.people.map(({ id, name, aliases }) => ({ id, name, aliases })),
    specialties: references.specialties.map(({ id, label, aliases }) => ({ id, label, aliases })),
    document_types: references.documentTypes.map(({ id, label, aliases }) => ({ id, label, aliases })),
    metric_dictionary: references.metrics.map(({ id, label, aliases, default_unit }) => ({ id, label, aliases, default_unit })),
  };

  const content = [];
  if (pdfExtensions.has(ext)) {
    content.push({ type: "input_file", filename: fileName, file_data: `data:application/pdf;base64,${base64}` });
  } else if (imageExtensions.has(ext)) {
    content.push({ type: "input_image", image_url: dataUrlForImage(filePath, base64), detail: "high" });
  } else if (textExtensions.has(ext)) {
    content.push({ type: "input_text", text: await fsp.readFile(filePath, "utf8") });
  } else {
    throw new Error(`Unsupported file type for AI extraction: ${ext}`);
  }

  content.push({
    type: "input_text",
    text: [
      `Имя файла: ${fileName}`,
      "Извлеки из медицинского документа только факты, которые реально видны в документе.",
      "Не ставь диагнозы от себя и не интерпретируй сверх документа.",
      "Если поле не найдено уверенно, верни пустую строку и добавь причину в uncertainties.",
      "Для person_id, specialty_id, document_type_id используй только id из справочников. Если не уверен, person_id пустой, specialty_id=other, document_type_id=unknown.",
      "recommended_file_title должен быть коротким названием для имени файла без даты и имени человека: например Кардиолог, Анализ крови, ЭКГ, УЗИ щитовидной железы, Выписка.",
      `Справочники: ${JSON.stringify(referencePayload)}`,
    ].join("\n"),
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: openaiModel,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "medical_document_extraction",
          strict: true,
          schema: extractionSchema(),
        },
      },
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI extraction failed for ${repoRelative(filePath)}: ${json.error?.message || response.statusText}`);
  }

  const outputText = responseOutputText(json);
  if (!outputText) throw new Error(`OpenAI extraction returned no text for ${repoRelative(filePath)}`);

  return normalizeAnalysis(JSON.parse(outputText), references, filePath, "openai", "");
}

function normalizeAnalysis(raw, references, filePath, extraction, extractionWarning) {
  const fileName = path.basename(filePath);
  const fallbackText = `${fileName}\n${[...(raw.summary || []), raw.document_title, raw.doctor, raw.clinic].join("\n")}`;
  const personByModel = byId(references.people, raw.person_id);
  const specialtyByModel = byId(references.specialties, raw.specialty_id);
  const documentTypeByModel = byId(references.documentTypes, raw.document_type_id);
  const personFallback = bestByAliases(fallbackText, references.people, null);
  const specialtyFallback = bestByAliases(fallbackText, references.specialties, "other");
  const documentTypeFallback = bestByAliases(fallbackText, references.documentTypes, "unknown");
  const person = personByModel || personFallback.record || null;
  const specialty = specialtyByModel || specialtyFallback.record || byId(references.specialties, "other");
  const documentType = documentTypeByModel || documentTypeFallback.record || byId(references.documentTypes, "unknown");
  const eventDate = isoDateFromText(raw.event_date) || detectDate(fallbackText, fileName);
  const summary = Array.isArray(raw.summary) && raw.summary.length ? raw.summary.map(stripMarkdown).filter(Boolean).slice(0, 8) : summarizeText(fallbackText, fileName);
  const uncertainties = Array.isArray(raw.uncertainties) ? raw.uncertainties.filter(Boolean) : [];
  if (extractionWarning) uncertainties.push(extractionWarning);
  if (!person) uncertainties.push("Не удалось уверенно определить члена семьи.");
  if (!eventDate) uncertainties.push("Не удалось уверенно определить дату документа.");

  return {
    source_file: repoRelative(filePath),
    original_file_name: fileName,
    file_name: fileName,
    extraction,
    extraction_warning: extractionWarning,
    model: extraction === "openai" ? openaiModel : "",
    person,
    specialty,
    document_type: documentType,
    event_date: eventDate || "",
    doctor: stripMarkdown(raw.doctor || ""),
    clinic: stripMarkdown(raw.clinic || ""),
    document_title: stripMarkdown(raw.document_title || raw.recommended_file_title || ""),
    recommended_file_title: stripMarkdown(raw.recommended_file_title || raw.document_title || ""),
    summary,
    metrics: normalizeMetricCandidates(raw.metrics || [], references.metrics),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.map(stripMarkdown).filter(Boolean).slice(0, 12) : [],
    confidence: ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "low",
    needs_human_review: raw.needs_human_review !== false || !person || !eventDate,
    uncertainties: [...new Set(uncertainties)],
  };
}

function normalizeMetricCandidates(metrics, dictionary) {
  return metrics
    .map((metric) => {
      const known = byId(dictionary, metric.metric_id) || bestByAliases(`${metric.label} ${metric.metric_id}`, dictionary, null).record;
      return {
        metric_id: known?.id || "",
        label: known?.label || stripMarkdown(metric.label || ""),
        value: String(metric.value || ""),
        unit: String(metric.unit || known?.default_unit || ""),
        reference: String(metric.reference || ""),
        comment: String(metric.comment || ""),
      };
    })
    .filter((metric) => metric.label || metric.metric_id || metric.value)
    .slice(0, 20);
}

async function extractDocument(filePath, references) {
  const ext = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    const extracted = { text: path.basename(filePath), extraction: "unsupported", extractionWarning: `Неподдерживаемый тип файла: ${ext}` };
    return localAnalysis(filePath, extracted, references);
  }

  if (!noAi && process.env.OPENAI_API_KEY) {
    return aiExtract(filePath, references);
  }

  if (!noAi && !process.env.OPENAI_API_KEY && (pdfExtensions.has(ext) || imageExtensions.has(ext))) {
    throw new Error(`OPENAI_API_KEY is required to read ${ext} contents: ${repoRelative(filePath)}`);
  }

  const extracted = await readTextFallback(filePath);
  return localAnalysis(filePath, extracted, references);
}

function canonicalFileName(analysis, ext) {
  const date = analysis.event_date || frontmatterDate();
  const person = analysis.person?.name || "Неизвестно";
  const title =
    analysis.recommended_file_title ||
    analysis.document_title ||
    (analysis.document_type?.id === "lab_result" ? "Анализ" : "") ||
    analysis.specialty?.label ||
    analysis.document_type?.label ||
    "Документ";
  const base = uniqueDisplayTitle([`${date} ${person}`, title]).slice(0, 150);
  return `${base}${ext.toLowerCase()}`;
}

async function renameIncomingFile(filePath, analysis) {
  const ext = path.extname(filePath).toLowerCase();
  const desiredName = canonicalFileName(analysis, ext);
  if (path.basename(filePath) === desiredName) {
    return { path: filePath, renamed: false, originalPath: repoRelative(filePath), newPath: repoRelative(filePath) };
  }

  const targetPath = await uniquePath(path.join(path.dirname(filePath), desiredName));
  if (!dryRun) await fsp.rename(filePath, targetPath);
  return {
    path: dryRun ? targetPath : targetPath,
    renamed: true,
    originalPath: repoRelative(filePath),
    newPath: repoRelative(targetPath),
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
    ? analysis.metrics.map((metric) => `| ${metric.label} | ${metric.value || ""} | ${metric.unit || ""} | ${metric.reference || ""} | ${metric.comment || ""} |`).join("\n")
    : "| | | | | |";
  const taskLines = analysis.tasks.length ? analysis.tasks.map((task) => `- ${task}`).join("\n") : "- ";
  const summaryLines = analysis.summary.map((line) => `- ${line}`).join("\n");
  const questions = analysis.uncertainties.length
    ? analysis.uncertainties
    : ["Проверить, что распознавание не исказило исходный документ."];

  const data = {
    id,
    type: "ai_review_draft",
    status: "needs_review",
    created_at: createdAt,
    source_files: sourceFiles,
    original_file_name: yamlScalar(analysis.original_file_name),
    canonical_file_name: yamlScalar(path.basename(analysis.source_file)),
    extraction_method: analysis.extraction,
    extraction_model: yamlScalar(analysis.model),
    candidate_person_id: yamlScalar(analysis.person?.id),
    candidate_person: yamlScalar(analysis.person?.name),
    candidate_event_date: yamlScalar(analysis.event_date),
    candidate_document_type_id: yamlScalar(analysis.document_type?.id),
    candidate_document_title: yamlScalar(analysis.document_title || analysis.recommended_file_title),
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
- Название документа: ${analysis.document_title || analysis.recommended_file_title || ""}
- Направление: ${analysis.specialty?.label || ""}
- Врач: ${analysis.doctor || ""}
- Клиника: ${analysis.clinic || ""}
- Уверенность: ${analysis.confidence}
- Метод чтения: ${analysis.extraction}${analysis.model ? ` (${analysis.model})` : ""}

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
- [ ] Название файла корректное
- [ ] Направление определено верно
- [ ] Сводка не искажает документ
- [ ] Можно создавать медицинское событие

## Решение
- Статус: needs_review
- Комментарий:
`;

  return matter.stringify(body, data);
}

async function moveToError(filePath, error) {
  const target = await uniquePath(path.join(paths.errors, path.basename(filePath)));
  if (!dryRun && fs.existsSync(filePath)) await fsp.rename(filePath, target);
  return { source: repoRelative(filePath), target: repoRelative(target), error: error.message };
}

async function scanInbox() {
  await ensureFolders();
  const references = await loadReferences();
  const state = await loadState();
  const known = new Set(state.files.map((record) => record.fingerprint));
  const files = await walkFiles(paths.inboxNew);
  const created = [];
  const skipped = [];
  const failed = [];

  for (const filePath of files) {
    const fingerprint = await fileFingerprint(filePath);
    if (!includeAll && known.has(fingerprint)) {
      skipped.push(repoRelative(filePath));
      continue;
    }

    try {
      const originalPath = repoRelative(filePath);
      let analysis = await extractDocument(filePath, references);
      const rename = await renameIncomingFile(filePath, analysis);
      analysis = { ...analysis, source_file: rename.newPath, file_name: path.basename(rename.newPath), original_file_name: path.basename(originalPath) };
      const slug = draftSlug(analysis, fingerprint);
      const draftPath = path.join(paths.drafts, `${slug}.md`);
      const draftRelative = repoRelative(draftPath);
      const draftContent = draftMarkdown(analysis, fingerprint);

      if (!dryRun) {
        await fsp.writeFile(draftPath, draftContent, "utf8");
        state.files.push({
          fingerprint,
          original_source_file: originalPath,
          source_file: rename.newPath,
          draft_file: draftRelative,
          renamed: rename.renamed,
          extraction_method: analysis.extraction,
          extraction_model: analysis.model || "",
          confidence: analysis.confidence,
          status: "draft_created",
          created_at: new Date().toISOString(),
        });
      }

      created.push({
        source: originalPath,
        renamedTo: rename.newPath,
        draft: draftRelative,
        confidence: analysis.confidence,
        extraction: analysis.extraction,
      });
    } catch (error) {
      const failedItem = moveErrors
        ? await moveToError(filePath, error)
        : { source: repoRelative(filePath), target: "", error: error.message };
      failed.push(failedItem);
    }
  }

  await saveState(state);

  console.log(`Intake scan complete: ${created.length} draft(s), ${skipped.length} skipped, ${failed.length} failed.`);
  for (const item of created) {
    const renameText = item.source === item.renamedTo ? item.source : `${item.source} -> ${item.renamedTo}`;
    console.log(`+ ${renameText} -> ${item.draft} (${item.confidence}, ${item.extraction})`);
  }
  for (const item of failed) {
    const targetText = item.target ? ` -> ${item.target}` : "";
    console.error(`Error: ${item.source}${targetText}: ${item.error}`);
  }
  if (dryRun) console.log("Dry run: no files were written.");
  if (failed.length) process.exitCode = 1;
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
  const documentTitle = data.candidate_document_title || specialtyLabel || "медицинское событие";
  const title = `${person.name} — ${documentTitle}`;
  const id = slugify(`${eventDate}-${person.id}-${documentTitle}-${hashText(draft.filePath, 6)}`);
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
    const eventFileName = `${eventDate} ${person.name} — ${data.candidate_document_title || specialtyLabel}.md`;
    const eventPath = await uniquePath(path.join(clinicDir, sanitizeFilenamePart(eventFileName, "medical-event.md")));
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
