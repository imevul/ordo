import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { ConfirmHost } from './components/ui/Modal.tsx';
import { AdminPage } from './routes/admin.tsx';
import {
  EmailLinkPage,
  ForgotPasswordPage,
  IndexRedirect,
  InvitePage,
  LoginPage,
  OnboardingPage,
  ResetPasswordPage,
  SignupPage,
} from './routes/auth.tsx';
import { CycleDetailPage, CyclesPage } from './routes/cycles.tsx';
import { InboxPage } from './routes/inbox.tsx';
import { InitiativePage, InitiativesPage } from './routes/initiatives.tsx';
import {
  IssuePage,
  MyIssuesPage,
  SearchPage,
  TeamIssuesPage,
  TrashPage,
} from './routes/issues.tsx';
import { ProjectDetailPage, ProjectsPage } from './routes/projects.tsx';
import { RoadmapPage } from './routes/roadmap.tsx';
import { SettingsPage, TeamSettingsPage } from './routes/settings/index.tsx';
import { ViewPage, ViewsPage } from './routes/views.tsx';
import { NotFound, WorkspaceIndex, WorkspaceLayout } from './routes/workspace.tsx';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <ConfirmHost />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-raised)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            borderRadius: 0,
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </>
  ),
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexRedirect,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (
    s: Record<string, unknown>,
  ): { redirect?: string; error?: string; workspace?: string } => ({
    ...(typeof s.redirect === 'string' && { redirect: s.redirect }),
    ...(typeof s.error === 'string' && { error: s.error }),
    ...(typeof s.workspace === 'string' && { workspace: s.workspace }),
  }),
  component: LoginPage,
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  validateSearch: (s: Record<string, unknown>): { invite?: string } =>
    typeof s.invite === 'string' ? { invite: s.invite } : {},
  component: SignupPage,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InvitePage,
});
const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: ForgotPasswordPage,
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password/$token',
  component: ResetPasswordPage,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email/$token',
  component: () => <EmailLinkPage kind="verify" />,
});
const confirmEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/confirm-email/$token',
  component: () => <EmailLinkPage kind="change" />,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/$section',
  component: AdminPage,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => <Navigate to="/admin/$section" params={{ section: 'overview' }} replace />,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
});

const wsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$slug',
  component: WorkspaceLayout,
});
const wsIndexRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/',
  component: WorkspaceIndex,
});
const inboxRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/inbox',
  component: InboxPage,
});
const myIssuesRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/my-issues/$tab',
  component: MyIssuesPage,
});
const teamIssuesRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/team/$key/$tab',
  component: TeamIssuesPage,
});
const cyclesRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/team/$key/cycles',
  component: CyclesPage,
});
const cycleRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/team/$key/cycle/$number',
  component: CycleDetailPage,
});
const projectsRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/projects',
  validateSearch: (s: Record<string, unknown>): { team?: string; new?: 1 } => ({
    ...(typeof s.team === 'string' ? { team: s.team } : {}),
    ...(s.new === 1 || s.new === '1' ? { new: 1 as const } : {}),
  }),
  component: ProjectsPage,
});
const projectRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/project/$projectId',
  validateSearch: (s: Record<string, unknown>): { tab?: 'issues' } =>
    s.tab === 'issues' ? { tab: 'issues' } : {},
  component: ProjectDetailPage,
});
const initiativesRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/initiatives',
  component: InitiativesPage,
});
const initiativeRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/initiative/$initiativeId',
  component: InitiativePage,
});
const roadmapRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/roadmap',
  component: RoadmapPage,
});
const viewsRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/views',
  component: ViewsPage,
});
const viewRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/view/$viewId',
  component: ViewPage,
});
const issueRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/issue/$identifier',
  component: IssuePage,
});
const searchRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/search',
  component: SearchPage,
});
const trashRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/trash',
  component: TrashPage,
});
const teamSettingsRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/settings/team/$key',
  component: TeamSettingsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => wsRoute,
  path: '/settings/$section',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  inviteRoute,
  forgotRoute,
  resetRoute,
  verifyEmailRoute,
  confirmEmailRoute,
  onboardingRoute,
  adminIndexRoute,
  adminRoute,
  wsRoute.addChildren([
    wsIndexRoute,
    inboxRoute,
    myIssuesRoute,
    teamIssuesRoute,
    cyclesRoute,
    cycleRoute,
    projectsRoute,
    projectRoute,
    initiativesRoute,
    initiativeRoute,
    roadmapRoute,
    viewsRoute,
    viewRoute,
    issueRoute,
    searchRoute,
    trashRoute,
    teamSettingsRoute,
    settingsRoute,
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: false,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
