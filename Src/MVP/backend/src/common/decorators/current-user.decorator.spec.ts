import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser } from '../authenticated-user';

/**
 * @CurrentUser è ciò che realizza davvero una garanzia che i test dei
 * controller si limitavano a dichiarare nei commenti: l'identità e il ruolo
 * di chi chiama vengono letti dalla richiesta autenticata — dove li ha
 * scritti JwtStrategy dopo aver verificato il token — e non da un parametro
 * che il chiamante possa scegliersi. Chiamando `controller.findAll('ADMIN')`
 * a mano il decoratore viene scavalcato del tutto, quindi la proprietà va
 * verificata qui.
 */

/**
 * Estrae la funzione che Nest invocherà a ogni richiesta.
 *
 * Un decoratore di parametro non è chiamabile direttamente: applicandolo a
 * un metodo fittizio, Nest registra la propria factory nei metadati della
 * rotta, ed è quella la funzione sotto esame.
 */
function fabbricaDelDecoratore() {
  class Fittizia {
    // I parametri non vengono mai letti: esistono solo perché applicando il
    // decoratore Nest scriva la propria factory nei metadati della classe.
    metodo(@CurrentUser() tutto: unknown, @CurrentUser('role') ruolo: unknown) {}
  }

  const metadati = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Fittizia,
    'metodo',
  ) as Record<string, { factory: (dato: unknown, ctx: ExecutionContext) => unknown }>;

  return Object.values(metadati)[0].factory;
}

/** Una ExecutionContext HTTP la cui richiesta porta l'utente indicato. */
function contestoCon(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('@CurrentUser', () => {
  const factory = fabbricaDelDecoratore();
  const utente: AuthenticatedUser = { userId: 'user1', role: 'DEVELOPER' };

  it('returns the whole authenticated user when no field is requested', () => {
    expect(factory(undefined, contestoCon(utente))).toEqual(utente);
  });

  it('returns just the requested field', () => {
    expect(factory('role', contestoCon(utente))).toBe('DEVELOPER');
    expect(factory('userId', contestoCon(utente))).toBe('user1');
  });

  it('reads the role from the request, never from anything the caller supplies', () => {
    // Il ruolo restituito è quello scritto sulla richiesta da JwtStrategy
    // dopo la verifica del token: un chiamante che si dichiarasse
    // SECURITY_AUDITOR non sposterebbe questo valore.
    const auditor: AuthenticatedUser = {
      userId: 'user2',
      role: 'SECURITY_AUDITOR',
    };

    expect(factory('role', contestoCon(auditor))).toBe('SECURITY_AUDITOR');
    expect(factory('role', contestoCon(utente))).toBe('DEVELOPER');
  });

  it('yields undefined on a request with no authenticated user', () => {
    // Non deve sollevare: senza la guardia davanti la rotta non è
    // autenticata, e il valore assente è quello corretto da propagare.
    expect(factory(undefined, contestoCon(undefined))).toBeUndefined();
    expect(factory('role', contestoCon(undefined))).toBeUndefined();
  });
});
