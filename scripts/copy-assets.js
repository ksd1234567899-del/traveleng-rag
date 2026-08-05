import { cpSync } from "node:fs";

cpSync("src/data/scenarios", "dist/data/scenarios", { recursive: true });
