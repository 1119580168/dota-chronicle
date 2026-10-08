// Reuse the shared deterministic Panorama behavior suite with only the scoped
// authoring path and public namespace replaced. It executes the new controller
// source, not a copy of that controller or a native renderer emulator.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../../..");
const harness = fs
  .readFileSync(path.join(root, "tests/legacy-ability-ui.cjs"), "utf8")
  .replace('"legacy-ability", "ui"', '"legacy-ability", "7.27c", "ui"')
  .replaceAll("chronicle_ability_", "chronicle_labyrinth_ability_")
  .replaceAll("ChronicleAbilityEditor", "ChronicleLabyrinthAbilityEditor");
vm.runInNewContext(
  harness,
  { require, console, __dirname: path.join(root, "tests") },
  { filename: "labyrinth-panorama-ui-shared-harness.cjs" },
);
