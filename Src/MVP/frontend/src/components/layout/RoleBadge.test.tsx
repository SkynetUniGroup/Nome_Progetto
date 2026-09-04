import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoleBadge } from './RoleBadge';
import type { UserRole } from '../../types';

describe('RoleBadge', () => {
  const CASI: [UserRole, string][] = [
    ['DEVELOPER', 'Dev'],
    ['SECURITY_AUDITOR', 'Auditor'],
    ['PROJECT_MANAGER', 'PM'],
  ];

  it.each(CASI)('per il ruolo %s mostra l\'etichetta abbreviata %s', (role, etichetta) => {
    render(<RoleBadge role={role} />);

    expect(screen.getByText(etichetta)).toBeInTheDocument();
  });

  it('distingue visivamente i tre ruoli', () => {
    // Il badge serve a riconoscere a colpo d'occhio sotto quale ruolo si sta
    // operando: due ruoli con lo stesso colore vanificherebbero lo scopo.
    const classi = CASI.map(([role]) => {
      const { container, unmount } = render(<RoleBadge role={role} />);
      const classe = container.querySelector('span')!.className;
      unmount();
      return classe;
    });

    expect(new Set(classi).size).toBe(3);
  });

  it('accetta classi aggiuntive senza perdere le proprie', () => {
    const { container } = render(<RoleBadge role="DEVELOPER" className="mt-4" />);

    const classe = container.querySelector('span')!.className;
    expect(classe).toContain('mt-4');
    expect(classe).toContain('rounded');
  });
});
