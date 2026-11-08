// Helpers shared by capture.mjs and verdict.mjs.

/** The same finding on one screen at several sizes or themes, listed once. */
export function groupFindings(list) {
  const groups = new Map();
  for (const f of list) {
    const [screen, where] = f.screen.split("@");
    const key = `${screen}\0${f.id}\0${f.message}`;
    const g = groups.get(key) ?? { screen, id: f.id, message: f.message, shots: [] };
    g.shots.push(where);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, where: g.shots.join(", ") }));
}
