import { useEffect, useRef, type ReactNode } from 'react';
import { icons } from './icons';
export function Icon({ name }: { name: string }) { return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={icons[name] || icons.spark} /></svg>; }
export function Sculpture({ className = 'sculpture' }: { className?: string }) { return <img className={`${className} ink-sculpture`} src="/assets/sculpture.svg" alt="" />; }
export function Cover({ id, title }: { id: number; title: string }) { return <img className="cover" src={`/assets/cover-${id}.svg`} alt={`Обложка: ${title}`} />; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClick={e => { if (e.target === dialog.current) close(); }}><div className="sheet"><div className="handle" /><div className="sheet-head"><h2>{title}</h2><button className="circle" onClick={close} aria-label="Закрыть окно"><Icon name="close" /></button></div>{children}</div></dialog>;
}
