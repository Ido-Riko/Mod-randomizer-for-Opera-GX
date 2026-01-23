// background.js (fixed)
// - Stores detected mod list separately and exposes only mods to popup
// - Writes a pendingRandomization event to storage and only runtime.sendMessage
//   if a popup view is open (avoids sending to unloaded popup)
// - Redirect delay for manual randomize = 3000ms so popup shows redirect message
// - Adds console logs for toggles/saves/alarms/randomization events

const MAX_LAST_RANDOMIZATION_AGE = 24 * 60 * 60 * 1000;
const MIN_RANDOMIZE_MINUTES = 0.25; // 15s for testing
const MIN_COOLDOWN_MS = 5000;
const IDENTIFY_THROTTLE_MS = 1500;

let identifyInFlight = null;
let lastIdentifyAt = 0;

let redirectTimeout = null;
let randomizationInProgress = false;

// Track popup connection
let popupPort = null;

// ---------- Storage helper ----------
const storage = {
  get(keys) { return new Promise(resolve => chrome.storage.local.get(keys, resolve)); },
  set(obj) { return new Promise(resolve => chrome.storage.local.set(obj, resolve)); },
  remove(k) { return new Promise(resolve => chrome.storage.local.remove(k, resolve)); }
};

const management = {
  getAll() { return new Promise(resolve => chrome.management.getAll(resolve)); },
  setEnabled(id, enabled) { return new Promise(resolve => chrome.management.setEnabled(id, enabled, () => resolve())); }
};

function nowMs() { return Date.now(); }

// ---------- Port-based delivery ----------
async function tryDeliverToPopup(message) {
  if (popupPort) {
    try {
      popupPort.postMessage(message);
      console.log('Delivered to popup via port:', message.action);
      return true;
    } catch (e) {
      console.warn('Port delivery failed, clearing popupPort', e);
      popupPort = null;
    }
  }
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        console.debug('runtime.sendMessage fallback failed', chrome.runtime.lastError.message);
        resolve(false);
      } else {
        console.log('runtime.sendMessage fallback returned, may not be consumed');
        resolve(true);
      }
    });
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port && port.name === 'popup') {
    popupPort = port;
    console.log('Background: popup connected via port');

    port.onMessage.addListener(async (msg) => {
      if (!msg || !msg.action) return;

      if (msg.action === 'popupReady') {
        const { pendingRandomization } = await storage.get('pendingRandomization');
        if (pendingRandomization && pendingRandomization.enabledExtension) {
          popupPort.postMessage({
            action: 'randomizationCompleted',
            enabledExtension: pendingRandomization.enabledExtension,
            pendingId: pendingRandomization.timestamp
          });
          console.log('Sent pendingRandomization via port to popup');
        }
      } else if (msg.action === 'randomizationAck') {
        await storage.remove('pendingRandomization');
        console.log('Cleared pendingRandomization after ACK');
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('Popup port disconnected');
      popupPort = null;
    });
  }
});

// ---------- Identification ----------
async function identifyModExtensions() {
  if (identifyInFlight) return identifyInFlight;
  const now = Date.now();
  if (now - lastIdentifyAt < IDENTIFY_THROTTLE_MS) {
    const cached = await storage.get('detectedModList');
    return cached.detectedModList || [];
  }
  identifyInFlight = (async () => {
    try {
      const all = await management.getAll();
      const detectedIds = all
        .filter(e => e.updateUrl === 'https://api.gx.me/store/mods/update')
        .map(e => ({ id: e.id, name: e.name }));
      await storage.set({ detectedModList: detectedIds });
      lastIdentifyAt = Date.now();
      console.log('identifyModExtensions -> detected', detectedIds.length, 'mods');
      return detectedIds;
    } catch (err) {
      console.error('identifyModExtensions error', err);
      return [];
    } finally {
      identifyInFlight = null;
    }
  })();
  return identifyInFlight;
}

async function ensureDefaults() {
  const s = await storage.get(['profiles', 'activeProfile']);
  if (!s.profiles) {
    const detected = await storage.get('detectedModList');
    const detectedIds = Array.isArray(detected.detectedModList)
      ? detected.detectedModList.map(m => m.id)
      : [];

    const profiles = { Default: detectedIds };
    await storage.set({ profiles, activeProfile: 'Default' });
    console.log(`Initialized default profile with ${detectedIds.length} mods`);
  }
}

const CATALOG_URL = 'https://raw.githubusercontent.com/Ido-Riko/Mod-randomizer-for-Opera-GX/main/url-catalog.json';
let catalog = {};
// Load catalog immediately on background startup
loadCatalog();


// Load static catalog on startup
async function loadCatalog() {
  try {
    const res = await fetch(CATALOG_URL);
    catalog = await res.json();
    console.log('Catalog loaded:', Object.keys(catalog).length, 'mods');
  } catch (err) {
    console.error('Failed to load catalog:', err);
  }
}

// Function to get a mod URL by name
// ---------------------- getModUrlByName ----------------------
async function getModUrlByName(modName) {
  console.log(`[getModUrlByName] Looking for URL of mod: "${modName}"`);

  // Check catalog first
  if (catalog[modName] && catalog[modName].url) {
    console.log(`[getModUrlByName] Found in catalog:`, catalog[modName].url);
    return catalog[modName].url;
  } else {
    console.log(`[getModUrlByName] Not found in catalog for name: "${modName}"`);
  }

  // Check newly installed mods
  const storageData = await chrome.storage.local.get(['newMods']);
  const newMods = storageData.newMods || {};
  const found = Object.values(newMods).find(m => m.name === modName);
  if (found && found.url) {
    console.log(`[getModUrlByName] Found in newMods storage:`, found.url);
    return found.url;
  } else {
    console.log(`[getModUrlByName] Not found in newMods storage for: "${modName}"`);
  }

  // Fallback
  console.warn(`[getModUrlByName] No URL found for "${modName}"`);
  return null; // temporarily remove fallback to mods/manage
}


// Add only newly detected mods to all profiles when randomize-all is OFF.
// Maintain a persistent set of knownDetectedIds so previously unchecked mods stay unchecked.
async function addDetectedModsToAllProfiles(autoIdentify /* randomizeAllMods */) {
  const [detectedWrapper, profilesWrapper, knownWrapper] = await Promise.all([
    storage.get('detectedModList'),
    storage.get(['profiles', 'activeProfile']),
    storage.get('knownDetectedIds')
  ]);

  const detectedList = detectedWrapper.detectedModList || [];
  const detectedIds = detectedList.map(m => m.id);
  const profiles = profilesWrapper.profiles || {};

  // Ensure there is at least a Default profile
  if (!Object.keys(profiles).length) profiles['Default'] = [];

  // Build set of previously known ids (persisted)
  const knownDetectedIds = Array.isArray(knownWrapper.knownDetectedIds) ? new Set(knownWrapper.knownDetectedIds) : new Set();

  // Compute only genuinely new ids (newly installed mods since last time)
  const newIds = detectedIds.filter(id => !knownDetectedIds.has(id));

  let mutated = false;

  // Only mutate profiles when randomize-all is OFF, and only by adding newIds
  if (!autoIdentify && newIds.length) {
    for (const profileName of Object.keys(profiles)) {
      const set = new Set(profiles[profileName] || []);
      let addedCount = 0;
      for (const id of newIds) {
        if (!set.has(id)) {
          profiles[profileName].push(id); // add new mod ON for all profiles
          addedCount++;
        }
      }
      if (addedCount > 0) {
        console.log(`identify: added ${addedCount} new mod(s) to profile '${profileName}'`);
        mutated = true;
      }
    }
  }

  // Update knownDetectedIds to include all currently detected ids (union)
  const updatedKnown = Array.from(new Set([...knownDetectedIds, ...detectedIds]));
  // Persist storage updates atomically
  if (mutated) {
    await storage.set({ profiles, knownDetectedIds: updatedKnown });
  } else {
    await storage.set({ knownDetectedIds: updatedKnown });
  }

  return { detected: detectedList, profiles };
}
// ---------- Randomization ----------
// ---------------------- handleModEnableWorkflow ----------------------
async function handleModEnableWorkflow(modIdsForRandomization, source) {
  // This function should only be used when enabling mods.
  // It disables all mods in profile.
  // Then, if source is manual, and if open mods tab is on, show redirect message and then redirect. (Redirect message is in popup.js)
  // if source is manual and opens mods tab is off, don't show redirect message on popup, and don't redirect.
  // if source is not manual, check if notifications are on, and if open mods tab is on.
  // If notifications are on, and opens mods tab is on, create a notification that when clicked, redirects the user to mods tab,
  // but also redirect after 3 seconds anyways.
  // If notifications are on, but opens mods tab is off, don't redirect after 3 seconds, only show the notification that can be clicked.
  // If notifications are off, but open mods tab is on, redirect after 3 seconds without a notification
  // If notifications are off and open mods tab is off, don't redirect, and don't create a notification.

  console.log(`[handleModEnableWorkflow] Starting workflow. Mods:`, modIdsForRandomization, `source:`, source);

  if (!modIdsForRandomization || modIdsForRandomization.length === 0) {
    console.warn('[handleModEnableWorkflow] No mods to randomize');
    return null;
  }
  const s = await storage.get(['lastEnabledModId', 'openModsTabChecked', 'showNotificationsChecked']);
  const lastEnabled = s.lastEnabledModId;
  const all = await management.getAll();
  const mods = all.filter(e => modIdsForRandomization.includes(e.id));

  if (!mods.length) {
    console.warn('[handleModEnableWorkflow] No mods found in management');
    return null;
  }

  // Disable currently enabled mods
  const currentlyEnabled = mods.filter(m => m.enabled);
  await Promise.all(currentlyEnabled.map(m => management.setEnabled(m.id, false)));

  // Pick new candidate (not last enabled)
  const candidates = mods.filter(m => m.id !== lastEnabled);
  if (!candidates.length) return null;

  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  console.log(`[handleModEnableWorkflow] Selected mod: ${selected.name} (id: ${selected.id})`);

  // Enable the selected mod
  await management.setEnabled(selected.id, true);
  await storage.set({ lastEnabledModId: selected.id, currentMod: selected.name });
  console.log(`[handleModEnableWorkflow] Enabled mod: ${selected.name}`);

  if (source === "manual") {
    // MANUAL: check if open mods tab is on
    const shouldRedirect = s.openModsTabChecked === undefined ? true : !!s.openModsTabChecked;
    return {
      id: selected.id,
      name: selected.name,
      modsTabUrl: shouldRedirect ? 'opera://configure/mods/manage' : null
    };
  } else {
    // NON-MANUAL (alarm/startup): check notifications and open mods tab settings
    const notificationsOn = s.showNotificationsChecked === undefined ? true : !!s.showNotificationsChecked;
    const openModsTabOn = s.openModsTabChecked === undefined ? true : !!s.openModsTabChecked;

    if (notificationsOn) {
      // Create notification
      const notificationDelay = source === 'startup' ? 5000 : 500;
      const message = openModsTabOn
        ? `Enabled: ${selected.name}\n\nRedirecting to mods tab...`
        : `Enabled: ${selected.name}`;

      setTimeout(() => {
        chrome.notifications.create('modRandomizerAlert', {
          type: 'basic',
          iconUrl: 'icons/icon_128.png',
          title: 'Mod Randomizer',
          message: message,
          requireInteraction: false
        });
        console.log(`[handleModEnableWorkflow] Notification created for ${selected.name}`);

        if (openModsTabOn) {
          // Redirect after 3 seconds
          setTimeout(() => {
            chrome.tabs.create({ url: 'opera://configure/mods/manage' });
            chrome.notifications.clear('modRandomizerAlert');
          }, 3000);
        } else {
          // Auto-clear notification after a few seconds
          setTimeout(() => {
            chrome.notifications.clear('modRandomizerAlert');
          }, 5000);
        }
      }, notificationDelay);
    } else {
      // No notifications
      if (openModsTabOn) {
        // Redirect after 3 seconds without notification
        setTimeout(() => {
          chrome.tabs.create({ url: 'opera://configure/mods/manage' });
        }, 3000);
      }
      // else: do nothing
    }

    return {
      id: selected.id,
      name: selected.name
    };
  }
}// ---------------------- executeRandomization ----------------------
async function executeRandomization(source = 'unknown') {
  // This function should always be used for randomization from background. If it's not a "manual with uninstall on", then use this function.
  // The function should first check if uninstall is on. if it is, fetch the url. if the url is missing, call handleModEnableWorkflow to enable instead.
  // if uninstall isn't on, call handleModEnableWorkflow
  // If the url isn't missing, do the same flow of disabling mods in profile, then if notifications are on, create notification for uninstall.
  // if notifications aren't on, call handleEnableWorkFlow as if uninstall is off. and don't create any notification.
  console.log(`[executeRandomization] Source: ${source}`);
  try {
    const s = await storage.get([
      'profiles',
      'activeProfile',
      'uninstallAndReinstallChecked',
      'autoModIdentificationChecked',
      'openModsTabChecked',
      'showNotificationsChecked',
      'lastEnabledModId',
      'toggleRandomizeOnSetTimeChecked'
    ]);

    // Guard: If triggered by alarm but the feature is disabled, abort and clean up.
    if (source === 'alarm' && !s.toggleRandomizeOnSetTimeChecked) {
      console.warn('[executeRandomization] Alarm fired but toggleRandomizeOnSetTimeChecked is OFF. Aborting and clearing alarm.');
      chrome.alarms.clear('randomizeAlarm');
      return null;
    }

    const { detectedModList = [] } = await storage.get('detectedModList');
    const useAll = !!s.autoModIdentificationChecked;
    const activeList = useAll ? detectedModList.map(m => m.id) : (s.profiles?.[s.activeProfile] || []);

    if (!activeList || activeList.length === 0) {
      console.warn('[executeRandomization] No mods to randomize');
      return null;
    }

    // Check if uninstall is on
    if (s.uninstallAndReinstallChecked) {
      // Get candidates
      const all = await management.getAll();
      const mods = all.filter(e => activeList.includes(e.id));
      const lastEnabled = s.lastEnabledModId;
      const candidates = mods.filter(m => m.id !== lastEnabled);

      if (!candidates.length) return null;

      const selected = candidates[Math.floor(Math.random() * candidates.length)];

      // Fetch URL
      const reinstallUrl = await getModUrlByName(selected.name);

      if (!reinstallUrl) {
        // URL missing: call handleModEnableWorkflow to enable instead
        console.log('[executeRandomization] Reinstall URL missing, calling handleModEnableWorkflow');
        const result = await handleModEnableWorkflow(activeList, source);

        if (result && source === 'manual') {
          const pending = { enabledExtension: result, timestamp: nowMs() };
          await storage.set({ pendingRandomization: pending });
          tryDeliverToPopup({ action: 'randomizationCompleted', enabledExtension: result, pendingId: pending.timestamp });
        }

        return result;
      } else {
        // URL found: disable mods in profile
        const currentlyEnabled = mods.filter(m => m.enabled);
        await Promise.all(currentlyEnabled.map(m => management.setEnabled(m.id, false)));
        await storage.set({ lastEnabledModId: selected.id, currentMod: selected.name });

        if (source === 'manual') {
          // Manual uninstall: return result to popup (popup handles uninstall + redirect)
          console.log('[executeRandomization] Manual uninstall mode, returning result to popup');
          return {
            id: selected.id,
            name: selected.name,
            reinstallUrl: reinstallUrl
          };
        } else {
          // Non-manual (alarm/startup): check if notifications are on
          const notificationsOn = s.showNotificationsChecked === undefined ? true : !!s.showNotificationsChecked;

          if (notificationsOn) {
            // Create notification for uninstall
            const notificationDelay = source === 'startup' ? 5000 : 500;

            await storage.set({
              pendingNotification: {
                modId: selected.id,
                modName: selected.name,
                reinstallUrl: reinstallUrl,
                uninstallMode: true,
                timestamp: nowMs()
              }
            });

            setTimeout(() => {
              chrome.notifications.create('modRandomizerAlert', {
                type: 'basic',
                iconUrl: 'icons/icon_128.png',
                title: 'Mod Randomizer',
                message: `Ready to switch to: ${selected.name}\n\nClick to uninstall and reinstall.`,
                requireInteraction: true
              });
              console.log(`[executeRandomization] Uninstall notification created for ${selected.name}`);
            }, notificationDelay);

            return null;
          } else {
            // Notifications off: call handleModEnableWorkflow as if uninstall is off
            console.log('[executeRandomization] Notifications off, calling handleModEnableWorkflow');
            return await handleModEnableWorkflow(activeList, source);
          }
        }
      }
    } else {
      // Uninstall off: call handleModEnableWorkflow
      console.log('[executeRandomization] Uninstall off, calling handleModEnableWorkflow');
      const result = await handleModEnableWorkflow(activeList, source);

      if (result && source === 'manual') {
        const pending = { enabledExtension: result, timestamp: nowMs() };
        await storage.set({ pendingRandomization: pending });
        tryDeliverToPopup({ action: 'randomizationCompleted', enabledExtension: result, pendingId: pending.timestamp });
      }

      return result;
    }
  } catch (err) {
    console.error('[executeRandomization] error', err);
    return null;
  }
}
// Handle notification clicks - only for uninstall mode
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'modRandomizerAlert') {
    // Use callback-based storage to preserve user gesture synchronously
    chrome.storage.local.get('pendingNotification', (result) => {
      const pendingNotification = result.pendingNotification;
      if (!pendingNotification) return;

      // Only handle uninstall mode clicks (enable mode notification is informational only)
      if (!pendingNotification.uninstallMode) {
        console.log('Notification clicked but enable mode - no action needed');
        return;
      }

      console.log(`Notification clicked for ${pendingNotification.modName} - triggering uninstall`);

      // Clear notification immediately
      chrome.notifications.clear(notificationId);

      // Trigger uninstall IMMEDIATELY using this click event (user gesture) - MUST be synchronous
      chrome.management.uninstall(pendingNotification.modId, { showConfirmDialog: true }, () => {
        if (chrome.runtime.lastError) {
          console.log('Uninstall cancelled by user');
        } else {
          console.log('Mod uninstalled successfully from notification');
        }
        // Clear storage after uninstall completes (whether cancelled or not)
        chrome.storage.local.remove('pendingNotification');
      });

      // Redirect immediately (don't wait for uninstall to complete)
      if (pendingNotification.reinstallUrl) {
        chrome.tabs.create({ url: pendingNotification.reinstallUrl });
      }
    });
  }
});

// Clean up on notification dismiss
chrome.notifications.onClosed.addListener(async (notificationId) => {
  if (notificationId === 'modRandomizerAlert') {
    await storage.remove('pendingNotification');
    console.log('Notification dismissed, cleared pending action');
  }
});
// ---------- Alarms & Scheduling ----------
async function setRandomizeTime(minutes) {
  const parsed = parseFloat(minutes);
  if (isNaN(parsed)) {
    console.warn('setRandomizeTime -> invalid number', minutes);
    return;
  }

  // Clear existing alarm first
  chrome.alarms.clear('randomizeAlarm', () => {
    // then schedule if needed
    if (parsed === 0) {
      storage.set({ randomizeTime: parsed });
      console.log('setRandomizeTime -> disabled (0)');
      return;
    }
    if (parsed < MIN_RANDOMIZE_MINUTES) {
      console.warn(`setRandomizeTime -> refused to set below ${MIN_RANDOMIZE_MINUTES} minutes.`);
      return;
    }

    storage.set({ randomizeTime: parsed }).then(() => {
      chrome.alarms.create('randomizeAlarm', { delayInMinutes: parsed, periodInMinutes: parsed });
      console.log(`setRandomizeTime -> scheduled randomizeAlarm every ${parsed} minutes`);
    });
  });
}

// ---------- Message handling ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'identifyModExtensions': {
          const detected = await identifyModExtensions();
          const s = await storage.get('autoModIdentificationChecked');
          // Only add genuinely new mods when randomize-all is OFF
          await addDetectedModsToAllProfiles(!!s.autoModIdentificationChecked);
          sendResponse({ status: 'success', detectedModList: detected });
          console.log('Message: identifyModExtensions -> responded');
          break;
        }
        //This handles the direct, synchronous request from the popup's button.
        case 'getRandomMod': {
          console.log('Message: getRandomMod received (direct from popup)');
          // Always use executeRandomization for any randomization from background
          const result = await executeRandomization('manual');
          sendResponse(result);
          break;
        }
        case 'getExtensions': {
          // Return only detected mods (so popup shows only mods), plus profiles + activeProfile
          const { detectedModList = [] } = await storage.get('detectedModList');
          const { profiles = {}, activeProfile = 'Default' } = await storage.get(['profiles', 'activeProfile']);
          const { autoModIdentificationChecked = true } = await storage.get('autoModIdentificationChecked');
          sendResponse({ detectedModList, profiles, activeProfile, autoModIdentificationChecked });
          console.log('Message: getExtensions -> returned detectedModList + profiles');
          break;
        }

        case 'saveModExtensionIds': {
          // message.profileName optional - if provided save to that profile; else to activeProfile
          const { modExtensionIds = [], profileName } = message;
          const s = await storage.get(['profiles', 'activeProfile']);
          const profiles = s.profiles || {};
          const active = profileName || s.activeProfile || 'Default';
          profiles[active] = Array.isArray(modExtensionIds) ? modExtensionIds : [];
          await storage.set({ profiles });
          console.log(`Saved ${profiles[active].length} ids to profile '${active}'`);
          sendResponse({ status: 'success' });
          break;
        }

        case 'popupOpened': {
          const { autoModIdentificationChecked } = await storage.get('autoModIdentificationChecked');
          await identifyModExtensions();
          await addDetectedModsToAllProfiles(!!autoModIdentificationChecked);
          console.log('popupOpened -> identification done (profiles updated only for newly detected mods and only if randomize-all OFF)');
          // Give popup any pendingRandomization and then clear it (popup will display)
          const { pendingRandomization } = await storage.get('pendingRandomization');
          if (pendingRandomization) {
            // Try to send; if popup isn't actively listening, storage fallback remains.
            try {
              chrome.runtime.sendMessage({ action: 'randomizationCompleted', enabledExtension: pendingRandomization.enabledExtension });
              console.log('popupOpened -> sent runtime randomizationCompleted to popup');
            } catch (e) {
              console.debug('popupOpened: runtime.sendMessage likely no listener; popup will read from storage.', e && e.message);
            }
            // Optionally keep or clear pending event; we'll clear so it doesn't show again
            await storage.remove('pendingRandomization');
          }
          sendResponse({ status: 'success' });
          break;
        }

        case 'setRandomizeTime': {
          console.log('Message: setRandomizeTime ->', message.time);
          await setRandomizeTime(message.time);
          sendResponse({ status: 'success' });
          break;
        }

        case 'toggleRandomizeOnSetTimeChecked': {
          console.log('Message: toggleRandomizeOnSetTimeChecked ->', message.value);
          await storage.set({ toggleRandomizeOnSetTimeChecked: message.value });
          if (message.value) {
            const { randomizeTime = 0 } = await storage.get('randomizeTime');
            if (randomizeTime > 0) {
              chrome.alarms.create('randomizeAlarm', { delayInMinutes: randomizeTime, periodInMinutes: randomizeTime });
              console.log('Scheduled randomizeAlarm because toggle enabled and randomizeTime > 0');
            } else {
              console.log('Toggle enabled but randomizeTime is 0, not scheduling alarm');
            }
          } else {
            await new Promise(resolve => {
              chrome.alarms.clear('randomizeAlarm', (wasCleared) => {
                console.log(`Cleared randomizeAlarm because toggle disabled: ${wasCleared}`);
                resolve();
              });
            });
          }
          sendResponse({ status: 'success' });
          break;
        }

        case 'createProfile': {
          const { profileName } = message;
          const name = (profileName || '').trim();
          const { profiles = {} } = await storage.get('profiles');
          if (!name) {
            sendResponse({ status: 'error', message: 'Profile name cannot be empty' });
            break;
          }
          const nameLc = name.toLowerCase();
          if (Object.keys(profiles).some(k => k.toLowerCase() === nameLc)) {
            sendResponse({ status: 'error', message: 'Profile already exists' });
          } else {
            // Initialize the new profile with ALL detected mods checked
            const { detectedModList = [] } = await storage.get('detectedModList');
            const allIds = Array.isArray(detectedModList) ? detectedModList.map(m => m.id) : [];
            profiles[name] = allIds;

            await storage.set({ profiles });
            console.log('Created profile with all mods checked:', name, 'count=', allIds.length);
            sendResponse({ status: 'success' });
          }
          break;
        }

        case 'deleteProfile': {
          const { profileName } = message;
          const data = await storage.get(['profiles', 'activeProfile', 'detectedModList']);
          const profiles = data.profiles || {};
          let active = data.activeProfile || 'Default';

          if (!profiles[profileName]) {
            sendResponse({ status: 'error', message: 'Profile not found' });
            break;
          }

          delete profiles[profileName];

          // Determine remaining profiles
          let remaining = Object.keys(profiles);

          // If none remain, recreate Default with ALL detected mods checked
          if (!remaining.length) {
            const detected = Array.isArray(data.detectedModList) ? data.detectedModList : [];
            profiles['Default'] = detected.map(m => m.id);
            remaining = ['Default'];
            console.log('Recreated Default profile with all detected mods after deletion');
          }

          // Pick a new active if needed
          if (active === profileName) active = remaining[0] || 'Default';

          await storage.set({ profiles, activeProfile: active });
          console.log('Deleted profile', profileName, 'new active', active);
          sendResponse({ status: 'success', activeProfile: active });
          break;
        }

        case 'renameProfile': {
          const { oldName, newName } = message;
          const oldN = (oldName || '').trim();
          const newN = (newName || '').trim();
          const { profiles = {}, activeProfile = 'Default' } = await storage.get(['profiles', 'activeProfile']);
          if (!profiles[oldN]) {
            sendResponse({ status: 'error', message: 'Old profile not found' });
            break;
          }
          if (!newN) {
            sendResponse({ status: 'error', message: 'New profile name cannot be empty' });
            break;
          }
          const oldLc = oldN.toLowerCase();
          const newLc = newN.toLowerCase();
          // If the new name is different (beyond casing) and collides with another profile (case-insensitive), reject
          if (newLc !== oldLc && Object.keys(profiles).some(k => k.toLowerCase() === newLc)) {
            sendResponse({ status: 'error', message: 'New profile name already exists' });
            break;
          }
          // Perform rename (allow case-only change as well)
          profiles[newN] = profiles[oldN];
          delete profiles[oldN];
          const newActive = (activeProfile === oldN) ? newN : activeProfile;
          await storage.set({ profiles, activeProfile: newActive });
          console.log(`Renamed profile ${oldN} -> ${newN}`);
          sendResponse({ status: 'success', activeProfile: newActive });
          break;
        }

        case 'setActiveProfile': {
          const { profileName } = message;
          const name = (profileName || '').trim();
          const { profiles = {} } = await storage.get('profiles');
          if (!profiles[name]) {
            sendResponse({ status: 'error', message: 'Profile not found' });
            break;
          }
          await storage.set({ activeProfile: name });
          console.log('Active profile set to', name);
          sendResponse({ status: 'success' });
          break;
        }

        default:
          console.warn('Unknown message action:', message.action);
          sendResponse({ status: 'error', message: 'Unknown action' });
      }
    } catch (err) {
      console.error('onMessage handling error', err);
      sendResponse({ status: 'error', message: err && err.message });
    }
  })();
  return true;
});

// alarms
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'randomizeAlarm') {
    console.log('Alarm fired: randomizeAlarm');
    await executeRandomization('alarm');
  }
});

// startup & install
chrome.runtime.onStartup.addListener(async () => {
  const s = await storage.get(['toggleRandomizeOnStartupChecked', 'autoModIdentificationChecked']);
  if (s.autoModIdentificationChecked === undefined) {
    await storage.set({ autoModIdentificationChecked: false });
    console.log('Startup: randomize-all missing; set to OFF by default');
  }
  if (s.toggleRandomizeOnStartupChecked) {
    console.log('onStartup -> toggleRandomizeOnStartupChecked true; scheduling startup randomize');
    setTimeout(() => executeRandomization('startup'), 1000);
  }
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    // Initialize sensible defaults
    await storage.set({
      toggleRandomizeOnStartupChecked: false,
      autoModIdentificationChecked: false, // randomize-all: OFF by default
      uninstallAndReinstallChecked: true,
      openModsTabChecked: true, // open mods tab: ON by default
      showNotificationsChecked: true, // show notifications: ON by default
      toggleRandomizeOnSetTimeChecked: false,
      randomizeTime: 0,
      currentMod: 'None'
    });
    console.log('Installed: default settings saved (randomize-all OFF)');
    await identifyModExtensions();
    await ensureDefaults();
  } else if (details.reason === 'update') {
    console.log('Extension updated');
    // Migration: if key is missing, default appropriately
    const s = await storage.get(['autoModIdentificationChecked', 'openModsTabChecked', 'showNotificationsChecked']);
    const updates = {};
    if (s.autoModIdentificationChecked === undefined) {
      updates.autoModIdentificationChecked = false;
    }
    if (s.openModsTabChecked === undefined) {
      updates.openModsTabChecked = true;
    }
    if (s.showNotificationsChecked === undefined) {
      updates.showNotificationsChecked = true;
    }
    if (Object.keys(updates).length > 0) {
      await storage.set(updates);
      console.log('Migration: set defaults', updates);
    }
    await identifyModExtensions();
  }
  await ensureDefaults();
});

// Monitor for mod installation/uninstallation/enabling/disabling
const updateDetectedMods = async () => {
  console.log('Management event detected, updating mod list...');
  await identifyModExtensions();
  const s = await storage.get('autoModIdentificationChecked');
  await addDetectedModsToAllProfiles(!!s.autoModIdentificationChecked);

  // Notify connected popup/sidebar
  if (popupPort) {
    try {
      popupPort.postMessage({ action: 'extensionsUpdated' });
    } catch (e) {
      console.warn('Failed to notify popup', e);
    }
  }
};

const onInstalled = async (details) => {
  console.log('Mod installed, updating list...', details.id);
  await updateDetectedMods();
};

const onUninstalled = async (id) => {
  console.log('Mod uninstalled, tracking id:', id);

  // Try to find the name from the existing detected list before updating it
  const st = await storage.get('detectedModList');
  const list = st.detectedModList || [];
  const mod = list.find(m => m.id === id);
  const name = mod ? mod.name : 'Uninstalled Mod';

  // Track uninstalled mod for grace period (e.g. 1 minute)
  const s = await storage.get('recentlyUninstalled');
  const recent = s.recentlyUninstalled || {};
  recent[id] = { timestamp: Date.now(), name: name };
  await storage.set({ recentlyUninstalled: recent });

  await updateDetectedMods();
};

chrome.management.onInstalled.addListener(onInstalled);
chrome.management.onUninstalled.addListener(onUninstalled);
// Removed onEnabled/onDisabled listeners as requested