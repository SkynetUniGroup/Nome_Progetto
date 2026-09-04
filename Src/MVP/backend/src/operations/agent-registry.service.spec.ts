import {
  AgentRegistry,
  MAX_OPERATION_TIMEOUT_S,
} from './agent-registry.service';
import { OperationCode } from '../common/domain-types';
import { AgentRegistryEntry } from './agent-registry.types';

function codesOf(descriptors: { code: OperationCode }[]): OperationCode[] {
  return descriptors.map((d) => d.code).sort();
}

describe('AgentRegistry', () => {
  const registry = new AgentRegistry();

  it('gives DEVELOPER exactly the Docs operations plus the shared changelog one', () => {
    expect(codesOf(registry.getForRole('DEVELOPER'))).toEqual(
      ['CHANGELOG_TECHNICAL', 'DOCS_API', 'DOCS_INLINE', 'DOCS_README'].sort(),
    );
  });

  it('gives SECURITY_AUDITOR exactly the two Security operations', () => {
    expect(codesOf(registry.getForRole('SECURITY_AUDITOR'))).toEqual(
      ['SECURITY_OWASP', 'SECURITY_POLICY'].sort(),
    );
  });

  it('gives PROJECT_MANAGER both changelog operations and nothing else', () => {
    expect(codesOf(registry.getForRole('PROJECT_MANAGER'))).toEqual(
      ['CHANGELOG_BUSINESS', 'CHANGELOG_TECHNICAL'].sort(),
    );
  });

  it('never leaks allowedRoles into the returned descriptors', () => {
    const [first] = registry.getForRole('DEVELOPER');
    expect(first).not.toHaveProperty('allowedRoles');
    expect(Object.keys(first).sort()).toEqual(
      ['agent', 'code', 'description', 'displayName'].sort(),
    );
  });

  it('returns the configured timeout for a known operation', () => {
    expect(registry.getTimeoutS('DOCS_INLINE')).toBe(90);
  });

  describe('the 300s hard ceiling (RQ.6, BE-15)', () => {
    // The spy below has to come off even when the test that installs it
    // fails. Restoring at the end of the test body only runs on the happy
    // path, so a genuine failure of the ceiling test used to leave `entry`
    // mocked for every test after it in this file — four unrelated ones went
    // red alongside it, and the one that meant something was hard to find.
    // There is no `restoreMocks` in the Jest config, so it belongs here.
    afterEach(() => {
      jest.restoreAllMocks();
    });
    it('never returns more than the ceiling, even for a registry entry above it', () => {
      // The shipped table tops out at 180s, so nothing in it can demonstrate
      // the ceiling — a test written only against the real entries would
      // pass just as happily with no clamp at all. This substitutes a single
      // over-budget entry, which is exactly the change someone editing
      // ENTRIES could make, and asserts the ceiling holds anyway.
      const overBudget: AgentRegistryEntry = {
        code: 'DOCS_README',
        displayName: 'README generation/update',
        description: 'irrelevant here',
        agent: 'DOCS',
        allowedRoles: ['DEVELOPER'],
        timeoutS: 900,
      };
      jest
        .spyOn(
          registry as unknown as {
            entry: (code: OperationCode) => AgentRegistryEntry;
          },
          'entry',
        )
        .mockReturnValue(overBudget);

      expect(registry.getTimeoutS('DOCS_README')).toBe(300);
      expect(registry.getTimeoutS('DOCS_README')).toBe(MAX_OPERATION_TIMEOUT_S);
    });

    it('leaves an entry below the ceiling exactly as configured', () => {
      // The clamp is a ceiling, not a normalization: nothing legitimate
      // moves because of it.
      expect(registry.getTimeoutS('SECURITY_OWASP')).toBe(180);
      expect(registry.getTimeoutS('CHANGELOG_TECHNICAL')).toBe(90);
    });

    it('keeps every shipped entry under the ceiling', () => {
      // If this ever fails, the clamp above is silently shortening a real
      // operation's budget rather than merely standing guard — worth
      // noticing rather than absorbing.
      const codes: OperationCode[] = [
        'DOCS_README',
        'DOCS_INLINE',
        'DOCS_API',
        'SECURITY_OWASP',
        'SECURITY_POLICY',
        'CHANGELOG_TECHNICAL',
        'CHANGELOG_BUSINESS',
      ];
      for (const code of codes) {
        expect(registry.getTimeoutS(code)).toBeLessThanOrEqual(
          MAX_OPERATION_TIMEOUT_S,
        );
      }
    });
  });

  it('throws for an unknown operation code', () => {
    expect(() => registry.getTimeoutS('NOT_REAL' as never)).toThrow(
      'Unknown OperationCode',
    );
  });

  it('returns the agent that owns a known operation', () => {
    expect(registry.getAgent('CHANGELOG_BUSINESS')).toBe('CHANGELOG');
    expect(registry.getAgent('DOCS_README')).toBe('DOCS');
    expect(registry.getAgent('SECURITY_OWASP')).toBe('SECURITY');
  });

  it('throws for an unknown operation code when looking up the owning agent', () => {
    expect(() => registry.getAgent('NOT_REAL' as never)).toThrow(
      'Unknown OperationCode',
    );
  });

  it('returns the human-readable display name for a known operation', () => {
    expect(registry.getDisplayName('DOCS_README')).toBe(
      'README generation/update',
    );
  });

  it('throws for an unknown operation code when looking up the display name', () => {
    expect(() => registry.getDisplayName('NOT_REAL' as never)).toThrow(
      'Unknown OperationCode',
    );
  });
});
