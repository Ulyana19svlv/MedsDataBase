import { getAssetStats } from "./dashboard-lib.mjs";

const MB = 1024 * 1024;
const warningTotal = 500 * MB;
const fatalTotal = 900 * MB;
const warningFile = 50 * MB;
const fatalFile = 100 * MB;

const { assets, totalSize } = await getAssetStats();
let fatal = false;

function formatMb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

if (totalSize > fatalTotal) {
  fatal = true;
  console.error(`[FATAL] Documents total size is ${formatMb(totalSize)}. Move heavy assets to external storage.`);
} else if (totalSize > warningTotal) {
  console.warn(`[WARN] Documents total size is ${formatMb(totalSize)}. GitHub Pages limits may become a problem soon.`);
}

for (const asset of assets) {
  if (asset.size > fatalFile) {
    fatal = true;
    console.error(`[FATAL] ${asset.path} is ${formatMb(asset.size)}.`);
  } else if (asset.size > warningFile) {
    console.warn(`[WARN] ${asset.path} is ${formatMb(asset.size)}.`);
  }
}

console.log(`Validated ${assets.length} assets, total size ${formatMb(totalSize)}.`);

if (fatal) process.exitCode = 1;
