import { featureSim } from '@/platform/features';
import gettingStartedRaw from './getting-started.md?raw';
import userManualRaw from './user-manual.md?raw';
import technicalReferenceRaw from './technical-reference.md?raw';
import changelogRaw from './CHANGELOG.md?raw';
import contributingRaw from './CONTRIBUTING.md?raw';
import cncGuideRaw from './cnc-guide.md?raw';

export interface DocEntry {
  id: string;
  title: string;
  source: string;
}

// The CNC guide is listed only when the CNC UI is on (`featureSim`, #343): the public site
// switches it off unless the address says `?BETA=yes`, and it must not offer a guide to screens that are not there.
const cncDocs: DocEntry[] = featureSim
  ? [{ id: 'cnc-guide', title: 'CNC Guide', source: cncGuideRaw }]
  : [];

export const DOCS: ReadonlyArray<DocEntry> = [
  { id: 'user-manual', title: 'User Manual', source: userManualRaw },
  { id: 'getting-started', title: 'Getting Started', source: gettingStartedRaw },
  { id: 'technical-reference', title: 'Technical Reference', source: technicalReferenceRaw },
  { id: 'changelog', title: 'Changelog', source: changelogRaw },
  { id: 'contributing', title: 'Contributing', source: contributingRaw },
  ...cncDocs,
];

export function findDoc(id: string): DocEntry | undefined {
  return DOCS.find((d) => d.id === id);
}
