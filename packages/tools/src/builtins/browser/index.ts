// Side-effect imports — each module registers its tools at load time.
import "./navigation.js";
import "./snapshot.js";
import "./actions.js";
import "./inspection.js";
import "./tabs.js";
import "./act.js";

export {
  bindBrowser,
  getBrowserBindings,
  type BrowserBindings,
} from "./bindings.js";
