import { expect, it, vi } from 'vitest';
import { createInstallPrompt, type InstallPrompt } from './install-prompt';
it('requests a captured install prompt once and waits for the actual installation event', async () => {
 const target = new EventTarget(); const controller = createInstallPrompt(target); const listener = vi.fn(); controller.subscribe(listener);
 const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPrompt;
 event.prompt = vi.fn().mockResolvedValue(undefined); event.userChoice = Promise.resolve({ outcome: 'accepted' });
 target.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); expect(controller.available()).toBe(true);
 const request = controller.request(); expect(event.prompt).toHaveBeenCalledOnce(); expect(controller.available()).toBe(false);
 expect(await request).toBe('accepted'); expect(controller.installed()).toBe(false);
 expect(await controller.request()).toBe('unavailable');
 target.dispatchEvent(new Event('appinstalled')); expect(controller.installed()).toBe(true); expect(listener).toHaveBeenCalled(); controller.dispose();
});
it('does not reuse a dismissed prompt and releases listeners', async () => {
 const target = new EventTarget(); const controller = createInstallPrompt(target);
 const event = new Event('beforeinstallprompt') as InstallPrompt;
 event.prompt = vi.fn().mockResolvedValue(undefined); event.userChoice = Promise.resolve({ outcome: 'dismissed' });
 target.dispatchEvent(event); expect(await controller.request()).toBe('dismissed'); expect(controller.installed()).toBe(false);
 controller.dispose(); target.dispatchEvent(event); expect(controller.available()).toBe(false);
});
it('clears a failed prompt so a browser failure cannot cause repeated automatic prompts', async () => {
 const target = new EventTarget(); const controller = createInstallPrompt(target);
 const event = new Event('beforeinstallprompt') as InstallPrompt;
 event.prompt = vi.fn().mockRejectedValue(new Error('unsupported')); event.userChoice = Promise.resolve({ outcome: 'dismissed' }); target.dispatchEvent(event);
 await expect(controller.request()).rejects.toThrow('unsupported'); expect(await controller.request()).toBe('unavailable'); controller.dispose();
});
