import type { ReactNode } from 'react';
import { Icon } from './ui';

export function ProfileSection({ title, description, icon, children }: { title: string; description: string; icon: string; children: ReactNode }) {
 return <details className="profile-section">
  <summary><span className="profile-section-icon"><Icon name={icon} /></span><span className="profile-section-label"><strong>{title}</strong><small>{description}</small></span><span className="profile-section-arrow" aria-hidden="true">↗</span></summary>
  <div className="profile-section-content">{children}</div>
 </details>;
}
