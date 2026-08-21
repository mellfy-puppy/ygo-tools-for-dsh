const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { execSync } = require("node:child_process");
const axios = require("axios");

function getCurrentBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  } catch (err) {
    console.warn("Failed to get current git branch, assuming non-develop:", err.message);
    return null;
  }
}

const branch = getCurrentBranch();
const libName = branch === "develop" ? "libocgcore-koishi-develop" : "libocgcore-koishi";

const files = [
  {
    url: `https://cdntx.moecube.com/${libName}/wasm_cjs/libocgcore.cjs`,
    dest: path.join("src", "vendor", "wasm_cjs", "libocgcore.cjs"),
  },
  {
    url: `https://cdntx.moecube.com/${libName}/wasm_cjs/libocgcore.wasm`,
    dest: path.join("src", "vendor", "wasm_cjs", "libocgcore.wasm"),
  },
  {
    url: `https://cdntx.moecube.com/${libName}/wasm_esm/libocgcore.mjs`,
    dest: path.join("src", "vendor", "wasm_esm", "libocgcore.mjs"),
  },
  {
    url: `https://cdntx.moecube.com/${libName}/wasm_esm/libocgcore.wasm`,
    dest: path.join("src", "vendor", "wasm_esm", "libocgcore.wasm"),
  },
];

async function download(url, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const response = await axios.get(url, { responseType: "stream" });
  const fileStream = fs.createWriteStream(dest);
  await pipeline(response.data, fileStream);
}

async function main() {
  console.log(`Using lib: ${libName} (branch: ${branch ?? "unknown"})`);
  for (const file of files) {
    await download(file.url, file.dest);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
