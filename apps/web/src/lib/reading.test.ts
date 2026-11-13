import { describe, it, expect } from 'vitest';
import { ReadingClock, localDay, sumReadingSeconds } from './reading';
describe('time behind visible text', () => {
 it('accumulates short sessions without rounding each session', () => { const clock = new ReadingClock(); const sessions: {seconds:number}[]=[]; for(let i=0;i<150;i++){const start=i*1000; clock.tick(start,true);sessions.push({seconds:clock.tick(start+400,false)});} expect(sumReadingSeconds(sessions)).toBe(60); });
 it('excludes hidden and suspended intervals', () => { const c=new ReadingClock(); expect(c.tick(0,true)).toBe(0);expect(c.tick(1000,true)).toBe(1);expect(c.tick(2000,false)).toBe(1);expect(c.tick(600000,false)).toBe(0);expect(c.tick(601000,true)).toBe(0);expect(c.tick(900000,true)).toBe(0); });
 it('uses local calendar dates', () => { expect(localDay(new Date(2026,0,2,23,59))).toBe('2026-01-02'); });
});
