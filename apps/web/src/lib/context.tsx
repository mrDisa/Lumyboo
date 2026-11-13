import { createContext, useContext } from 'react';
import type { Settings } from './db';
export const AppContext = createContext<{ settings: Settings; notify: (text: string) => void; act: (task: () => Promise<unknown>, success?: string) => Promise<boolean> }>(null!);
export const useApp = () => useContext(AppContext);
