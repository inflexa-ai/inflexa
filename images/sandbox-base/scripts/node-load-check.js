// The load check of the node track: require() each package of NODE_PKGS,
// then write the JSON inventory fragment to the FRAG file. An entry carries
// the name of the package and its version, which comes from
// node_modules/<name>/package.json under the working directory. Zero loaded
// packages fail the check.
//
// A bare require() resolves from the directory of THIS file, not from the
// working directory. The installed tree lives elsewhere. Thus the check
// builds a resolver anchored at the working directory, which is /opt/node
// in the image build.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const requireFromTree = createRequire(path.join(process.cwd(), "package.json"));
const pkgs = (process.env.NODE_PKGS || "").split(/\s+/).filter(Boolean);
const loaded = [];
const bad = [];
for (const p of pkgs) {
  try {
    requireFromTree(p);
  } catch (e) {
    console.log("DROP " + p + ": " + e.message);
    bad.push(p);
    continue;
  }
  let version;
  try {
    const manifest = path.join(process.cwd(), "node_modules", p, "package.json");
    version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  } catch (e) {
    console.log("DROP " + p + ": the version read failed — " + e.message);
    bad.push(p);
    continue;
  }
  if (typeof version !== "string" || !version) {
    console.log("DROP " + p + ": the package.json of the package names no version");
    bad.push(p);
    continue;
  }
  console.log("  OK: " + p + " " + version);
  loaded.push({ name: p, version: version });
}
loaded.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
fs.writeFileSync(process.env.FRAG, JSON.stringify(loaded, null, 2) + "\n");
if (bad.length) console.error("NOTE: " + bad.length + " Node package(s) dropped");
if (!loaded.length) {
  console.error("ERROR: the node track loaded ZERO packages (non-empty floor)");
  process.exit(1);
}
console.log("Load check OK: " + loaded.length + "/" + pkgs.length + " Node package(s) loaded");
