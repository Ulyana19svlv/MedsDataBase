import { copyDocuments, distDocumentsDir } from "./dashboard-lib.mjs";

const count = await copyDocuments(distDocumentsDir);
console.log(`Copied ${count} documents to dist/files/documents.`);
