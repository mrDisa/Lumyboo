// Deploy with verify_jwt=false: Telegram authenticates using its secret header.
// The bot token and webhook secret are project secrets, never frontend variables.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
export const welcome = 'Привет! Это Lumyboo — твоё время для хороших книг.\n\nВыбирай полные произведения, настраивай чтение, сохраняй место и закладки. В профиле — твоя полка, дневная цель и история чтения.\n\nНажми кнопку ниже — и откроем первую историю.';
export const commands = [
 { command: 'start', description: 'Главное меню' }, { command: 'read', description: 'Открыть читалку' },
 { command: 'catalog', description: 'Выбрать книгу' }, { command: 'profile', description: 'Моя полка и история' }, { command: 'help', description: 'Как пользоваться Lumyboo' },
];
const appURL = (view = 'app') => `https://mrdisa.github.io/Lumyboo/?app=1&view=${view}`;
type Settings = { token?: string; secret?: string; fetch?: typeof fetch };
async function sameSecret(a: string, b: string) {
 const digest = (text: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
 const [left, right] = await Promise.all([digest(a), digest(b)]); const l = new Uint8Array(left), r = new Uint8Array(right);
 let difference = 0; for (let i = 0; i < l.length; i++) difference |= l[i] ^ r[i]; return difference === 0;
}
export async function handle(request: Request, settings: Settings): Promise<Response> {
 if (!settings.token || !settings.secret) return new Response('Unavailable', { status: 503 });
 if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
 const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
 if (!secret || !await sameSecret(secret, settings.secret)) return new Response('Forbidden', { status: 403 });
 const raw = await request.text(); if (raw.length > 65536) return new Response('Too large', { status: 413 });
 let update: { message?: { text?: string; chat?: { type?: string; id?: number } } };
 try { update = JSON.parse(raw); } catch { return new Response('Invalid update', { status: 400 }); }
 const message = update?.message;
 if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id) || typeof message.text !== 'string') return new Response('OK');
 const command = message.text.trim().split(/\s/)[0].split('@')[0];
 if (!commands.some(item => '/' + item.command === command)) return new Response('OK');
 const text = command === '/help'
  ? 'Открой «Читать» или выбери книгу в каталоге. В читалке доступны оглавление, шрифт, тема и закладки.\n\nТвоя полка, цель и история — в профиле. Гостевое чтение сохраняется на этом устройстве.\n\nКоманды: /read · /catalog · /profile'
  : welcome;
 const selected = command === '/catalog' ? 'catalog' : command === '/profile' ? 'profile' : 'app';
 const payload = { chat_id: message.chat.id, text, reply_markup: { inline_keyboard: [
  [{ text: selected === 'catalog' ? 'Выбрать книгу' : selected === 'profile' ? 'Мой профиль' : 'Начать читать', web_app: { url: appURL(selected) } }],
  [{ text: 'Каталог', web_app: { url: appURL('catalog') } }, { text: 'Мой профиль', web_app: { url: appURL('profile') } }],
 ] } };
 try {
  const result = await (settings.fetch ?? fetch)(`https://api.telegram.org/bot${settings.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  const data = await result.json(); if (!result.ok || data.ok !== true) return new Response('Delivery failed', { status: 502 });
  return new Response('OK');
 } catch { return new Response('Delivery failed', { status: 502 }); }
}
if (typeof Deno !== 'undefined') Deno.serve(request => handle(request, { token: Deno.env.get('TELEGRAM_BOT_TOKEN'), secret: Deno.env.get('TELEGRAM_WEBHOOK_SECRET') }));
