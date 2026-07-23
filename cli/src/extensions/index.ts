// Central loader for global runtime extensions. Importing this module once from
// the entry point installs every augmentation, so call sites can use the new
// globals (Promise.sleep, JSON.parseWith, …) without importing each ext file.
// Side-effect imports only — adding an ext file here is the whole registration.
import "./date.ext.ts";
import "./json.ext.ts";
import "./number.ext.ts";
import "./promise.ext.ts";
import "./response.ext.ts";
import "./string.ext.ts";
