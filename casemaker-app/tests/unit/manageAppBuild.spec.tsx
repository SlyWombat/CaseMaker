// @vitest-environment jsdom
// #566 — the installed build names its commit, in the place a person checking a fix against the
// machine already looks.
//
// The ask came off k3: the `.deb` read a static 1.0.0, so telling one rebuilt binary from the next
// meant its md5 and the build timestamp. The service answers the commit on `/api/v1/health`
// (`build.rs` stamps it at compile time) and Manage → Machines shows that answer — the SERVICE's,
// not the page bundle's, because on a machine running the installed app the service is the thing
// being verified. A build with no service to ask draws nothing rather than inventing a version.

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

function healthWith(build: string) {
  return {
    ok: true,
    schemaVersion: 1,
    build,
    hasCatalogue: false,
    feedRows: 0,
    materialSpecRows: 0,
    catalogueSyncedAt: null,
    lastSync: null,
    problems: [],
    warnings: [],
  };
}

beforeEach(() => {
  cleanup();
  useToolRegistryStore.setState({ health: null });
});

describe('#566 the build the service reports', () => {
  it('names the commit the installed build came from', () => {
    useToolRegistryStore.setState({ health: healthWith('v1.0.0-825-gbea18572') });
    render(<MachinesScope />);
    const line = screen.getByTestId('manage-app-build');
    expect(line.textContent).toContain('v1.0.0-825-gbea18572');
    // It is the SERVICE's build that is named, and it says so.
    expect(line.textContent).toContain('Case Maker build');
  });

  it('says unknown when the service could not say — never a version nobody built', () => {
    useToolRegistryStore.setState({ health: healthWith('unknown') });
    render(<MachinesScope />);
    expect(screen.getByTestId('manage-app-build').textContent).toContain('unknown');
  });

  it('draws no build line where there is no service to ask', () => {
    render(<MachinesScope />);
    expect(screen.queryByTestId('manage-app-build')).toBeNull();
  });
});
