// --- Port connection for robust messaging ---
// THIS MUST BE AT THE TOP LEVEL (global scope)
// Note: In modules, top level execution happens once on import.
export const port = chrome.runtime.connect({ name: 'popup' });

export const storageGet = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
export const storageSet = (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve));
export const sendMsg = (action, data = {}) =>
    new Promise(resolve => chrome.runtime.sendMessage({ action, ...data }, (res) => {
        if (chrome.runtime.lastError) {
            console.warn('sendMsg lastError:', chrome.runtime.lastError.message);
        }
        resolve(res);
    }));
