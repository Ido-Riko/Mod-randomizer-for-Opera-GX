// Reconnect long-lived views after an extension worker/connection restart.
const listeners = new Set();
let connection;
let reconnectTimer;
function connect() {
    connection = chrome.runtime.connect({ name: 'popup' });
    connection.onMessage.addListener(message => {
        for (const listener of listeners) listener(message);
    });
    connection.onDisconnect.addListener(() => {
        connection = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            connect();
            for (const listener of listeners) listener({ action: 'extensionsUpdated' });
        }, 500);
    });
}
connect();
export const port = {
    onMessage: { addListener(listener) { listeners.add(listener); } }
};
function call(invoke) {
    return new Promise((resolve, reject) => invoke(result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
    }));
}
export const storageGet = keys => call(cb => chrome.storage.local.get(keys, cb));
export const storageSet = obj => call(cb => chrome.storage.local.set(obj, cb));
export async function sendMsg(action, data = {}) {
    const result = await call(cb => chrome.runtime.sendMessage({ action, ...data }, cb));
    if (result?.status === 'error') throw new Error(result.message || 'Operation failed');
    return result;
}
