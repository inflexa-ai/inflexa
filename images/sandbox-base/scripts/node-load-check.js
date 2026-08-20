// The load check of the node track: require() each package of NODE_PKGS,
// then write the names that loaded to the FRAG file. Zero loaded packages
// fail the check.
//
// A bare require() resolves from the directory of THIS file, not from the
// working directory. The installed tree lives elsewhere. Thus the check
// builds a resolver anchored at the working directory, which is /opt/node
// in the image build.
const path = require("path");
const { createRequire } = require("module");

const requireFromTree = createRequire(path.join(process.cwd(), "package.json"));
const pkgs = (process.env.NODE_PKGS || "").split(/\s+/).filter(Boolean);
const bad = [];
for (const p of pkgs) {
  try {
    requireFromTree(p);
    console.log("  OK: " + p);
  } catch (e) {
    console.log("DROP " + p + ": " + e.message);
    bad.push(p);
  }
}
const ok = pkgs.filter((p) => !bad.includes(p));
require("fs").writeFileSync(process.env.FRAG, "## Node (npm)\n" + ok.join(", ") + "\n");
if (bad.length) console.error("NOTE: " + bad.length + " Node package(s) dropped");
if (!ok.length) {
  console.error("ERROR: the node track loaded ZERO packages (non-empty floor)");
  process.exit(1);
}
console.log("Load check OK: " + ok.length + "/" + pkgs.length + " Node package(s) loaded");
