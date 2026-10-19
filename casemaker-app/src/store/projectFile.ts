import type { Project } from '@/types';
import { projectSchema } from './projectSchema';

/**
 * The project document's plain-text round trip — serialize and parse, nothing else. Kept in its own
 * module (not `store/persistence.ts`) so the headless scripts can import it without reaching the
 * browser-only picker/download code that lives beside it (#544, same class as #534).
 */

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(text: string): Project {
  const raw = JSON.parse(text);
  const parsed = projectSchema.parse(raw);
  return parsed as Project;
}
