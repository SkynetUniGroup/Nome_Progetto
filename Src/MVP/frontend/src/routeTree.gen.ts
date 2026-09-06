/**
 * Route tree — manually maintained.
 *
 * Assembles all route definitions into the tree consumed by createRouter().
 * When adding or removing routes, update this file accordingly.
 */
import { rootRoute } from './routes/root';
import { indexRoute } from './routes/index';
import { loginRoute } from './routes/login';
import { registerRoute } from './routes/register';
import { authRoute } from './routes/_auth';
import { credentialsRoute } from './routes/_auth.credentials';
import { selectRoute } from './routes/_auth.select';
import { runRoute } from './routes/_auth.run';
import { tasksRoute } from './routes/_auth.tasks';
import { reportsRoute } from './routes/_auth.reports';
import { reportDetailRoute } from './routes/_auth.reports.$id';
import { templateRoute } from './routes/_auth.template';

/**
 * Authenticated children are nested under authRoute (the pathless layout route).
 * Public routes (login, register) are direct children of the root.
 */
const authenticatedChildren = authRoute.addChildren([
  credentialsRoute,
  selectRoute,
  runRoute,
  tasksRoute,
  reportsRoute,
  reportDetailRoute,
  templateRoute,
]);

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  authenticatedChildren,
]);
