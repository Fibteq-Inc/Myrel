// Imported by name in its own module, so bundlers keep only the common grammars (a dynamic
// import("lowlight") pulls in all of them).
import { common, createLowlight } from "lowlight";

export const lowlight = createLowlight(common);
