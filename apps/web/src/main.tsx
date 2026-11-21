import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createRootRoute, createRoute, createRouter, createHashHistory, RouterProvider, Outlet, useRouterState, Navigate, Link } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ErrorBoundary } from './App';
import { MissingPage, OpeningScreen, RecoveryScreen } from './components/AppState';
import { Home, Catalog, BookDetail } from './pages/Library';
import './styles/prototype.css';
import './styles/app.css';
import { staticHost } from './lib/hosting';
const Landing = lazy(() => import('./pages/Landing').then(m => ({ default: m.Landing })));
const Demo = lazy(() => import('./pages/Demo').then(m => ({ default: m.Demo })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Downloads = lazy(() => import('./pages/Downloads').then(m => ({ default: m.Downloads })));
const Profile = lazy(() => import('./pages/Personal').then(m => ({ default: m.Profile })));
const Together = lazy(() => import('./pages/Personal').then(m => ({ default: m.Together })));
const Onboarding = lazy(() => import('./pages/Personal').then(m => ({ default: m.Onboarding })));
const SettingsPage = lazy(() => import('./pages/Personal').then(m => ({ default: m.SettingsPage })));
const Reader = lazy(() => import('./pages/Reader').then(m => ({ default: m.Reader })));
const AccountReader = lazy(() => import('./pages/Reader').then(m => ({ default: m.AccountReader })));
function Root() {
  const path = useRouterState({ select: state => state.location.pathname });
  return path === '/' || path === '/demo' ? <Suspense fallback={<OpeningScreen />}><Outlet /></Suspense> : <App />;
}
function Welcome() {
  const installed = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  const applicationLink = new URLSearchParams(location.search).get('app') === '1';
  return installed || applicationLink ? <Navigate to="/app" replace /> : <Landing />;
}
function PreviewAccess() {
  return <><p className="greeting">Чтение без регистрации</p><div className="headline"><h1>Сначала —<br /><em>своя история.</em></h1></div><p className="description">В этой демоверсии доступны книги, личная полка, дневная цель и чтение с сохранением места на устройстве. Вход в аккаунт и челленджи пока недоступны.</p><Link className="primary" to="/catalog">Выбрать книгу</Link><Link className="secondary section" to="/settings">Настроить чтение</Link></>;
}
const root = createRootRoute({ component: Root, errorComponent: RecoveryScreen, notFoundComponent: MissingPage });
const routes = [
  createRoute({ getParentRoute: () => root, path: '/account/read/$bookId', component: () => staticHost ? <PreviewAccess /> : <Suspense fallback={<OpeningScreen reader />}><AccountReader /></Suspense> }),
  createRoute({ getParentRoute: () => root, path: '/login', component: () => staticHost ? <PreviewAccess /> : <Login /> }),
  createRoute({ getParentRoute: () => root, path: '/downloads', component: Downloads }),
  createRoute({ getParentRoute: () => root, path: '/', component: Welcome }),
  createRoute({ getParentRoute: () => root, path: '/app', component: Home }),
  createRoute({ getParentRoute: () => root, path: '/demo', component: Demo }),
  createRoute({ getParentRoute: () => root, path: '/catalog', component: Catalog }),
  createRoute({ getParentRoute: () => root, path: '/book/$bookId', component: BookDetail }),
  createRoute({ getParentRoute: () => root, path: '/read/$bookId', component: () => <Suspense fallback={<OpeningScreen reader />}><Reader /></Suspense> }),
  createRoute({ getParentRoute: () => root, path: '/profile', component: () => staticHost ? <PreviewAccess /> : <Profile /> }),
  createRoute({ getParentRoute: () => root, path: '/together', component: () => staticHost ? <PreviewAccess /> : <Together /> }),
  createRoute({ getParentRoute: () => root, path: '/onboarding', component: Onboarding }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage }),
];
const router = createRouter({ routeTree: root.addChildren(routes), ...(staticHost ? { history: createHashHistory() } : {}) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const queryClient = new QueryClient();
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></ErrorBoundary></React.StrictMode>);
