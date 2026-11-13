import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createRootRoute, createRoute, createRouter, RouterProvider, Link } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ErrorBoundary } from './App';
import { Home, Catalog, BookDetail } from './pages/Library';
import './styles/prototype.css';
import './styles/app.css';
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Downloads = lazy(() => import('./pages/Downloads').then(m => ({ default: m.Downloads })));
const Profile = lazy(() => import('./pages/Personal').then(m => ({ default: m.Profile })));
const Together = lazy(() => import('./pages/Personal').then(m => ({ default: m.Together })));
const Onboarding = lazy(() => import('./pages/Personal').then(m => ({ default: m.Onboarding })));
const SettingsPage = lazy(() => import('./pages/Personal').then(m => ({ default: m.SettingsPage })));
const Reader = lazy(() => import('./pages/Reader').then(m => ({ default: m.Reader })));
const AccountReader = lazy(() => import('./pages/Reader').then(m => ({ default: m.AccountReader })));
const root = createRootRoute({ component: App, errorComponent: () => <div className="stage"><div className="phone"><main className="screen"><h1>Не удалось открыть экран</h1><p className="description">Подключись к сети и попробуй ещё раз. Сохранённые позиции и закладки остаются на устройстве.</p><button className="primary" onClick={() => location.reload()}>Попробовать снова</button><Link className="secondary section" to="/">На главную</Link></main></div></div>, notFoundComponent: () => <div className="empty">Такой страницы нет. <Link to="/">На главную</Link></div> });
const routes = [
  createRoute({ getParentRoute: () => root, path: '/account/read/$bookId', component: () => <Suspense fallback={<p className="empty">Открываем читалку…</p>}><AccountReader /></Suspense> }),
  createRoute({ getParentRoute: () => root, path: '/login', component: Login }),
  createRoute({ getParentRoute: () => root, path: '/downloads', component: Downloads }),
  createRoute({ getParentRoute: () => root, path: '/', component: Home }),
  createRoute({ getParentRoute: () => root, path: '/catalog', component: Catalog }),
  createRoute({ getParentRoute: () => root, path: '/book/$bookId', component: BookDetail }),
  createRoute({ getParentRoute: () => root, path: '/read/$bookId', component: () => <Suspense fallback={<p className="empty">Открываем читалку…</p>}><Reader /></Suspense> }),
  createRoute({ getParentRoute: () => root, path: '/profile', component: Profile }),
  createRoute({ getParentRoute: () => root, path: '/together', component: Together }),
  createRoute({ getParentRoute: () => root, path: '/onboarding', component: Onboarding }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage }),
];
const router = createRouter({ routeTree: root.addChildren(routes) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const queryClient = new QueryClient();
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></ErrorBoundary></React.StrictMode>);
