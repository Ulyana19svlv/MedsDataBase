import { copyDocuments, publicDocumentsDir, writeDashboardData } from "./dashboard-lib.mjs";

const args = new Set(process.argv.slice(2));
const validateOnly = args.has("--validate");
const devAssets = args.has("--dev-assets");

const data = await writeDashboardData();

if (devAssets) {
  const count = await copyDocuments(publicDocumentsDir);
  console.log(`Copied ${count} documents to public/documents for local dev.`);
}

for (const issue of data.issues) {
  const prefix = issue.severity.toUpperCase();
  console.log(`[${prefix}] ${issue.message}${issue.entityPath ? ` (${issue.entityPath})` : ""}`);
}

console.log(
  `Generated data: ${data.stats.people} people, ${data.stats.events} events, ${data.stats.documents} documents, ${data.stats.tasks} tasks.`,
);

if (data.stats.fatal > 0) {
  process.exitCode = 1;
} else if (validateOnly) {
  console.log("Data validation completed.");
}
