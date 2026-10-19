import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export { schema };

export function createDb(d1: Parameters<typeof drizzle>[0]) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
