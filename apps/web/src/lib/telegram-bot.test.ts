import { expect, it, vi } from 'vitest';
import { handle } from '../../../../supabase/functions/telegram-bot/index';
const settings = { token: 'fake-token', secret: 'fake-secret' };
const request = (body: unknown, secret = settings.secret) => new Request('https://bot.example.test', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
it('rejects untrusted webhooks before contacting Telegram', async () => {
 const fetch = vi.fn(); expect((await handle(request({}, 'wrong'), { ...settings, fetch })).status).toBe(403); expect(fetch).not.toHaveBeenCalled();
});
it('sends the welcome and mini menu only in private chats', async () => {
 const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}'));
 expect((await handle(request({ message: { text: '/start app', chat: { id: 42, type: 'private' } } }), { ...settings, fetch })).status).toBe(200);
 const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string); expect(payload.chat_id).toBe(42); expect(payload.text).toContain('Привет!');
 expect(payload.reply_markup.inline_keyboard[1][1].web_app.url).toContain('view=profile');
 fetch.mockClear(); await handle(request({ message: { text: '/start', chat: { id: 42, type: 'group' } } }), { ...settings, fetch }); expect(fetch).not.toHaveBeenCalled();
});
it('keeps delivery errors free of credentials and retries rejected deliveries', async () => {
 const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('secret URL'); });
 const response = await handle(request({ message: { text: '/profile', chat: { id: 42, type: 'private' } } }), { ...settings, fetch });
 expect(response.status).toBe(502); expect(await response.text()).not.toContain(settings.token);
});
