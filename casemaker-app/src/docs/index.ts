import gettingStartedRaw from './getting-started.md?raw';
import userManualRaw from './user-manual.md?raw';
import technicalReferenceRaw from './technical-reference.md?raw';
import changelogRaw from './CHANGELOG.md?raw';
import contributingRaw from './CONTRIBUTING.md?raw';

export interface DocEntry {
  id: string;
  title: string;
  source: string;
}

export const DOCS: ReadonlyArray<DocEntry> = [
  { id: 'getting-started', title: 'Getting Started', source: gettingStartedRaw },
  { id: 'user-manual', title: 'User Manual', source: userManualRaw },
  { id: 'technical-reference', title: 'Technical Reference', source: technicalReferenceRaw },
  { id: 'changelog', title: 'Changelog', source: changelogRaw },
  { id: 'contributing', title: 'Contributing', source: contributingRaw },
];

export function findDoc(id: string): DocEntry | undefined {
  return DOCS.find((d) => d.id === id);
}
