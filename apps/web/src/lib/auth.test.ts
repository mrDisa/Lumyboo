import { afterEach, expect, it, vi } from 'vitest';
import { getSession, requestCode, verifyCode } from './auth';
import { ApiError, requestJSON } from './api';
afterEach(() => vi.unstubAllGlobals());
it('treats only a 401 as a guest and surfaces server failures', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', {status:401})).mockResolvedValueOnce(new Response('{}', {status:503})));
 expect(await getSession()).toBeNull(); await expect(getSession()).rejects.toBeInstanceOf(ApiError);
});
it('uses same-origin cookies, no-store and the typed challenge contract', async () => {
 const challenge={challengeId:'challenge',expiresIn:600,resendAfter:60,delivery:'test'};
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(challenge)));vi.stubGlobal('fetch',fetch);
 expect(await requestCode('reader@example.test')).toEqual(challenge);
 expect(fetch).toHaveBeenCalledWith('/api/v1/auth/code',expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store',body:JSON.stringify({email:'reader@example.test'})}));
});
it('passes Retry-After without exposing raw server errors', async () => {
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'rate_limited',message:'Подожди'}}),{status:429,headers:{'Retry-After':'60'}})));
 await expect(requestCode('reader@example.test')).rejects.toMatchObject({status:429,code:'rate_limited',retryAfter:60,message:'Подожди'});
});
it('keeps verification data in the request body and supports empty logout responses', async () => {
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({user:{id:'id',email:'reader@example.test'},csrfToken:'csrf'}))).mockResolvedValueOnce(new Response(null,{status:204}));vi.stubGlobal('fetch',fetch);
 await verifyCode('challenge','123456'); expect(fetch.mock.calls[0][0]).toBe('/api/v1/auth/verify');expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({challengeId:'challenge',code:'123456'}));
 expect(await requestJSON<void>('/auth/logout',{method:'POST'})).toBeUndefined();
});

it('aborts an unresponsive authentication request', async () => {
 vi.useFakeTimers();
 try {
  vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{init.signal?.addEventListener('abort',()=>reject(init.signal?.reason));})));
  const checked=expect(requestCode('reader@example.test')).rejects.toMatchObject({name:'TimeoutError'});
  await vi.advanceTimersByTimeAsync(20_000);await checked;
 } finally {vi.useRealTimers();}
});
