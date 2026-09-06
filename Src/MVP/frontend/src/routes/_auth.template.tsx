import { createRoute } from '@tanstack/react-router';
import { authRoute } from './_auth';
import { TemplatePage } from '../pages/TemplatePage';

/**
 * Template route — /template (authenticated)
 *
 * RF.79-RF.81: gestione del template README personalizzato. Come le
 * credenziali, è una risorsa personale dell'utente e non dipende dal
 * repository selezionato, quindi vive fuori dal flusso di analisi.
 */
export const templateRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/template',
  component: TemplatePage,
});
