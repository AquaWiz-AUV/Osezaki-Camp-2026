import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDemo } from "../src/sample-data.js";

const samplesRoot = new URL("../public/samples/", import.meta.url);
const variants = [
  ["triton", false],
  ["triton", true],
  ["umibot", false],
  ["umibot", true]
];

for (const [vehicle, adversarial] of variants) {
  const demo = createDemo(vehicle, adversarial);
  const folderName = `${vehicle}-${adversarial ? "adversarial" : "normal"}`;
  const folder = new URL(`${folderName}/`, samplesRoot);
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(new URL("DATA.CSV", folder), demo.dataText, "utf8"),
    writeFile(new URL("EVENT.CSV", folder), demo.eventText, "utf8")
  ]);
  process.stdout.write(`${folderName}: DATA=${demo.dataText.length} chars EVENT=${demo.eventText.length} chars\n`);
}

process.stdout.write(`Generated under ${fileURLToPath(samplesRoot)}\n`);
