// Uninstall must be invoked synchronously from a real UI/notification click.
// Never await storage, messaging, or fetch before calling this helper.
const PREFIX = 'modRandomizerReinstall:';

export function validReinstallMod(mod) {
    if (!mod || !/^[a-p]{32}$/.test(mod.id) || typeof mod.name !== 'string') return false;
    try {
        const url = new URL(mod.reinstallUrl);
        return url.origin === 'https://store.gx.me' && url.pathname.startsWith('/mods/');
    } catch { return false; }
}

export function notificationIdFor(mod) {
    if (!validReinstallMod(mod)) throw new Error('Invalid reinstall target');
    return PREFIX + encodeURIComponent(JSON.stringify(mod));
}

export function modFromNotificationId(id) {
    if (!id.startsWith(PREFIX)) return null;
    try {
        const mod = JSON.parse(decodeURIComponent(id.slice(PREFIX.length)));
        return validReinstallMod(mod) ? mod : null;
    } catch { return null; }
}

const inFlight = new Set();
export function uninstallFromGesture(mod, onComplete, api = chrome) {
    if (!validReinstallMod(mod)) { onComplete(new Error('Invalid reinstall target')); return; }
    if (inFlight.has(mod.id)) return;
    inFlight.add(mod.id);
    try {
        // Keep this call in the initiating click's synchronous stack.
        api.management.uninstall(mod.id, { showConfirmDialog: true }, () => {
            const error = api.runtime.lastError;
            inFlight.delete(mod.id);
            if (error) { onComplete(new Error(error.message)); return; }
            api.tabs.create({ url: mod.reinstallUrl });
            onComplete(null);
        });
    } catch (error) {
        inFlight.delete(mod.id);
        onComplete(error);
    }
}
