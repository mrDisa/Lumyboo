import { setSettings } from '../lib/db';
import { useApp } from '../lib/context';
import styles from '../pages/Reader.module.css';

export function ReaderSettings() {
 const { settings, act } = useApp();
 return <div className={styles.readerSettings}>
  <div className={styles.typePreview} style={{ fontFamily: settings.font === 'serif' ? 'var(--serif)' : 'var(--font)', fontSize: settings.fontSize, lineHeight: settings.lineHeight }}>
   <span className={styles.previewLabel}>Образец текста</span>
   <p>У каждой истории свой ритм.</p>
  </div>
  <div className={styles.sizeHeading}><label htmlFor="font-size">Размер текста</label><output htmlFor="font-size">{settings.fontSize}<small> px</small></output></div>
  <div className={styles.sizeControl}><span aria-hidden="true">А</span><input id="font-size" aria-valuetext={`${settings.fontSize} пикселей`} type="range" min="15" max="32" value={settings.fontSize} onChange={e => void act(() => setSettings({ fontSize: Number(e.target.value) }))} /><span aria-hidden="true">А</span></div>
  <fieldset className={styles.readerChoices}><legend>Начертание</legend><div className={styles.fontChoices}>{(['serif', 'sans'] as const).map((font, i) => <button className={styles.fontChoice} key={font} aria-pressed={settings.font === font} onClick={() => void act(() => setSettings({ font }))}>
   <span aria-hidden="true" style={{ fontFamily: font === 'serif' ? 'var(--serif)' : 'var(--font)' }}>Аа</span><b>{['Книжное', 'Современное'][i]}</b><small>{settings.font === font ? 'Выбрано' : 'Выбрать'}</small>
  </button>)}</div></fieldset>
  <fieldset className={styles.readerChoices}><legend>Межстрочный интервал</legend><div className={styles.leadingChoices}>{[1.5, 1.75, 1.95, 2.2].map(value => <button key={value} aria-label={`Интервал ${value}`} aria-pressed={settings.lineHeight === value} onClick={() => void act(() => setSettings({ lineHeight: value }))}>
   <span className={styles.leadingSample} style={{ gap: `${(value - 1) * 7}px` }} aria-hidden="true"><i /><i /><i /></span><span>{value}</span>
  </button>)}</div></fieldset>
 </div>;
}
