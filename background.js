import { notificationIdFor, modFromNotificationId, uninstallFromGesture, validReinstallMod } from './modules/reinstall.js';
// Background owns profile mutations, scheduling, and mod selection.
const MIN_RANDOMIZE_MINUTES = 0.25;
const IDENTIFY_THROTTLE_MS = 1500;

let identifyInFlight = null;
let lastIdentifyAt = 0;

let randomizationInProgress = false;
let scheduledNotificationTimer = null;

// Track popup connection
const popupPorts = new Set();
let stateQueue = Promise.resolve();
function serializeState(task) {
  const result = stateQueue.then(task);
  stateQueue = result.catch(() => {});
  return result;
}

// ---------- Storage helper ----------
function callbackCall(invoke) {
  return new Promise((resolve, reject) => invoke(result => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}
const storage = {
  get(keys) { return callbackCall(cb => chrome.storage.local.get(keys, cb)); },
  set(obj) { return callbackCall(cb => chrome.storage.local.set(obj, cb)); },
  remove(keys) { return callbackCall(cb => chrome.storage.local.remove(keys, cb)); }
};
const management = {
  getAll() { return callbackCall(cb => chrome.management.getAll(cb)); },
  setEnabled(id, enabled) { return callbackCall(cb => chrome.management.setEnabled(id, enabled, cb)); }
};

function nowMs() { return Date.now(); }

// ---------- Port-based delivery ----------
function tryDeliverToPopup(message) {
  for (const port of popupPorts) {
    try { port.postMessage(message); }
    catch { popupPorts.delete(port); }
  }
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
});

// ---------- Identification ----------
async function identifyModExtensions(force = false) {
  if (identifyInFlight) return identifyInFlight;
  const now = Date.now();
  if (!force && now - lastIdentifyAt < IDENTIFY_THROTTLE_MS) {
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
let catalogLoadPromise = null;
let lastCatalogAttempt = 0;
loadCatalog();

async function loadCatalog() {
  if (catalogLoadPromise) return catalogLoadPromise;
  lastCatalogAttempt = Date.now();
  catalogLoadPromise = (async () => {
    async function readCatalog(url, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
      const value = await response.json();
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid catalog');
      return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
        try { return new URL(entry.url).origin === 'https://store.gx.me'; }
        catch { return false; }
      }));
    }
    // The packaged catalog remains usable offline and while refreshing remotely.
    if (!Object.keys(catalog).length) {
      try { catalog = await readCatalog(chrome.runtime.getURL('url-catalog.json')); }
      catch (error) { console.warn('Bundled catalog failed', error); }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try { catalog = { ...catalog, ...await readCatalog(CATALOG_URL, controller.signal) }; }
    catch (error) { console.warn('Remote catalog unavailable; using local catalog', error); }
    finally { clearTimeout(timeout); }
  })().finally(() => { catalogLoadPromise = null; });
  return catalogLoadPromise;
}

// Function to get a mod URL by name
// ---------------------- getModUrlByName ----------------------
function getModUrlByName(modName) {
  console.log(`[getModUrlByName] Looking for URL of mod: "${modName}"`);

  // Look up the mod in the catalog
  if (catalog[modName] && catalog[modName].url) {
    console.log(`[getModUrlByName] Found in catalog:`, catalog[modName].url);
    return catalog[modName].url;
  }

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
  const previousKnownArray = Array.isArray(knownWrapper.knownDetectedIds) ? knownWrapper.knownDetectedIds : [];
  const previousKnownSet = new Set(previousKnownArray);
  const knownChanged = updatedKnown.length !== previousKnownSet.size
    || updatedKnown.some(id => !previousKnownSet.has(id));

  // Persist only when data changed
  if (mutated) {
    if (knownChanged) await storage.set({ profiles, knownDetectedIds: updatedKnown });
    else await storage.set({ profiles });
  } else if (knownChanged) {
    await storage.set({ knownDetectedIds: updatedKnown });
  }

  return { detected: detectedList, profiles };
}
// ---------- Randomization ----------
// ---------------------- handleModEnableWorkflow ----------------------
async function pickNextMod(modsForRandomization, specificModId = null, lastEnabledId = null) {
  if (specificModId) {
    const selected = modsForRandomization.find(m => m.id === specificModId);
    if (selected) {
      console.log(`[pickNextMod] Using specific mod: ${selected.name}`);
      return selected;
    }
    console.warn(`[pickNextMod] Specific mod ID ${specificModId} not found, falling back to random`);
  }

  const alternatives = modsForRandomization.filter(m => m.id !== lastEnabledId);
  const candidates = alternatives.length ? alternatives : modsForRandomization;
  if (!candidates.length) return null;

  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  console.log(`[pickNextMod] Selected mod: ${selected.name} (id: ${selected.id})`);
  return selected;
}

async function enableMod(selectedMod, modsToDisable) {
  const currentlyEnabled = modsToDisable.filter(m => m.enabled && m.id !== selectedMod.id);
  await Promise.all(currentlyEnabled.map(m => management.setEnabled(m.id, false)));

  await management.setEnabled(selectedMod.id, true);
  await storage.set({ lastEnabledModId: selectedMod.id, currentMod: selectedMod.name });
  console.log(`[enableMod] Enabled mod: ${selectedMod.name}`);
}

async function disableModsOutsideActiveProfile(activeProfileIds = []) {
  const profileIdSet = new Set(activeProfileIds);
  const all = await management.getAll();
  const enabledModsOutsideProfile = all.filter(mod =>
    mod.updateUrl === 'https://api.gx.me/store/mods/update'
    && mod.enabled
    && !profileIdSet.has(mod.id)
  );

  if (!enabledModsOutsideProfile.length) return;

  await Promise.all(enabledModsOutsideProfile.map(mod => management.setEnabled(mod.id, false)));
  console.log(`[disableModsOutsideActiveProfile] Disabled ${enabledModsOutsideProfile.length} mod(s) outside active profile`);
}

async function triggerUXFeedback(source, selectedMod, settings, isUrlMissingFallback = false) {
  const openModsTabOn = settings.openModsTabChecked === undefined ? true : !!settings.openModsTabChecked;

  if (source === "manual") {
    return {
      id: selectedMod.id,
      name: selectedMod.name,
      modsTabUrl: openModsTabOn ? 'opera://configure/mods/manage' : null
    };
  }

  const notificationsOn = settings.showNotificationsChecked === undefined ? true : !!settings.showNotificationsChecked;

  if (notificationsOn) {
    const notificationDelay = source === 'startup' ? 5000 : 500;
    const messageBase = isUrlMissingFallback ? `URL missing - Enabled: ${selectedMod.name}` : `Enabled: ${selectedMod.name}`;
    const message = openModsTabOn ? `${messageBase}\n\nRedirecting to mods tab...` : messageBase;

    setTimeout(() => {
      chrome.notifications.create('modRandomizerAlert', {
        type: 'basic',
        iconUrl: 'icons/icon_128.png',
        title: 'Mod Randomizer',
        message: message,
        requireInteraction: false
      });
      console.log(`[triggerUXFeedback] Notification created for ${selectedMod.name}`);

      if (openModsTabOn) {
        setTimeout(() => {
          chrome.tabs.create({ url: 'opera://configure/mods/manage' });
          chrome.notifications.clear('modRandomizerAlert');
        }, 3000);
      } else {
        setTimeout(() => {
          chrome.notifications.clear('modRandomizerAlert');
        }, 5000);
      }
    }, notificationDelay);
  } else if (openModsTabOn) {
    setTimeout(() => {
      chrome.tabs.create({ url: 'opera://configure/mods/manage' });
    }, 3000);
  }

  return { id: selectedMod.id, name: selectedMod.name };
}

async function handleModEnableWorkflow(modIdsForRandomization, source, specificModId = null, isUrlMissingFallback = false) {
  console.log(`[handleModEnableWorkflow] Starting workflow. Mods:`, modIdsForRandomization, `source:`, source, `specificModId:`, specificModId);

  if (!modIdsForRandomization || modIdsForRandomization.length === 0) {
    console.warn('[handleModEnableWorkflow] No mods to randomize');
    return null;
  }

  const settings = await storage.get(['lastEnabledModId', 'openModsTabChecked', 'showNotificationsChecked']);
  const all = await management.getAll();
  const modIdSet = new Set(modIdsForRandomization);
  const mods = all.filter(e => modIdSet.has(e.id));

  if (!mods.length) {
    console.warn('[handleModEnableWorkflow] No mods found in management');
    return null;
  }

  const selected = await pickNextMod(mods, specificModId, settings.lastEnabledModId);
  if (!selected) return null;

  await enableMod(selected, mods);
  return await triggerUXFeedback(source, selected, settings, isUrlMissingFallback);
}// ---------------------- executeRandomization ----------------------
async function handleUninstallWorkflow(selectedMod, reinstallUrl, activeList, source, settings) {
  if (!validReinstallMod({ ...selectedMod, reinstallUrl })) {
    console.log('[executeRandomization] Reinstall URL missing, calling handleModEnableWorkflow with specific ID');
    return await handleModEnableWorkflow(activeList, source, selectedMod.id, true);
  }

  const all = await management.getAll();
  const mods = all.filter(e => activeList.includes(e.id));
  await enableMod(selectedMod, mods);

  if (source === 'manual') {
    const mod = { id: selectedMod.id, name: selectedMod.name, reinstallUrl };
    await storage.set({ pendingNotification: { modId: mod.id, modName: mod.name, reinstallUrl, uninstallMode: true, timestamp: nowMs() } });
    return mod;
  }

  const notificationsOn = settings.showNotificationsChecked === undefined ? true : !!settings.showNotificationsChecked;
  if (!notificationsOn) {
    console.log('[executeRandomization] Notifications off, calling handleModEnableWorkflow');
    return await handleModEnableWorkflow(activeList, source, selectedMod.id);
  }

  const notificationDelay = source === 'startup' ? 5000 : 500;
  const notificationId = notificationIdFor({ id: selectedMod.id, name: selectedMod.name, reinstallUrl });
  await storage.set({
    pendingNotification: {
      notificationId,
      modId: selectedMod.id,
      modName: selectedMod.name,
      reinstallUrl,
      uninstallMode: true,
      timestamp: nowMs()
    }
  });

  scheduledNotificationTimer = setTimeout(() => {
    scheduledNotificationTimer = null;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon_128.png',
      title: 'Mod Randomizer',
      message: `Ready to switch to: ${selectedMod.name}\n\nClick to uninstall and reinstall.`,
      requireInteraction: true
    });
    console.log(`[executeRandomization] Uninstall notification created for ${selectedMod.name}`);
    setTimeout(() => chrome.notifications.clear(notificationId), 15000);
  }, notificationDelay);

  return null;
}

async function executeRandomization(source = 'unknown') {
  if (randomizationInProgress) return { status: 'error', message: 'A mod switch is already in progress.' };
  randomizationInProgress = true;
  try {
    if (catalogLoadPromise) await catalogLoadPromise;
    else if (Date.now() - lastCatalogAttempt > 60000) void loadCatalog();

    const s = await storage.get([
      'profiles', 'activeProfile', 'uninstallAndReinstallChecked',
      'autoModIdentificationChecked', 'openModsTabChecked',
      'showNotificationsChecked', 'lastEnabledModId',
      'toggleRandomizeOnSetTimeChecked', 'lastRandomizationTime',
      'disableModsOutsideProfileChecked'
    ]);

    if (source === 'alarm' && !s.toggleRandomizeOnSetTimeChecked) {
      console.warn('[executeRandomization] Alarm fired but toggle is OFF. Aborting.');
      chrome.alarms.clear('randomizeAlarm');
      return null;
    }

    if (source !== 'manual') {
      const { randomizeTime = 0 } = await storage.get('randomizeTime');
      const throttleMs = randomizeTime === 0.25 ? 10 * 1000 : 60 * 1000;
      const lastRandomTime = s.lastRandomizationTime || 0;
      if (nowMs() - lastRandomTime < throttleMs) {
        console.warn(`[executeRandomization] Skipping automatic randomization (${source}); throttled.`);
        return null;
      }
    }

    const { detectedModList = [] } = await storage.get('detectedModList');
    const useAll = !!s.autoModIdentificationChecked;
    const activeProfileList = s.profiles?.[s.activeProfile] || [];
    const activeList = useAll ? detectedModList.map(m => m.id) : (s.profiles?.[s.activeProfile] || []);

    if (!activeList || activeList.length === 0) {
      console.warn('[executeRandomization] No mods to randomize');
      return null;
    }

    await clearPendingNotification();

    if (s.disableModsOutsideProfileChecked && !useAll) {
      await disableModsOutsideActiveProfile(activeProfileList);
    }

    let result = null;

    if (s.uninstallAndReinstallChecked) {
      const all = await management.getAll();
      const mods = all.filter(e => activeList.includes(e.id));
      const selected = await pickNextMod(mods, null, s.lastEnabledModId);

      if (!selected) return null;

      const reinstallUrl = getModUrlByName(selected.name);
      result = await handleUninstallWorkflow(selected, reinstallUrl, activeList, source, s);
    } else {
      console.log('[executeRandomization] Uninstall off, calling handleModEnableWorkflow');
      result = await handleModEnableWorkflow(activeList, source);
    }

    await storage.set({ lastRandomizationTime: nowMs() });
    return result;
  } catch (err) {
    console.error('[executeRandomization] error', err);
    return { status: 'error', message: err.message || 'Could not switch mods.' };
  } finally {
    randomizationInProgress = false;
  }
}

async function clearPendingNotification(modId = null) {
  const { pendingNotification } = await storage.get('pendingNotification');
  if (modId && pendingNotification?.modId !== modId) return;
  if (scheduledNotificationTimer) { clearTimeout(scheduledNotificationTimer); scheduledNotificationTimer = null; }
  if (pendingNotification?.notificationId) chrome.notifications.clear(pendingNotification.notificationId);
  chrome.notifications.clear('modRandomizerAlert');
  await storage.remove('pendingNotification');
}

// Payload lives in the notification ID, so a cold service worker can call uninstall
// directly in the click event, without awaiting storage or a network operation.
chrome.notifications.onClicked.addListener(notificationId => {
  const mod = modFromNotificationId(notificationId);
  if (!mod) {
    if (notificationId === 'modRandomizerAlert') chrome.tabs.create({ url: 'opera://configure/mods/manage' });
    return;
  }
  uninstallFromGesture(mod, error => {
    if (error) {
      tryDeliverToPopup({ action: 'uninstallFailed', message: error.message });
      return;
    }
    chrome.notifications.clear(notificationId);
    serializeState(() => clearPendingNotification(mod.id)).catch(console.error);
  }, chrome);
});
// Closing an OS notification leaves the explicit Reinstall action available in UI.

// ---------- Alarms & Scheduling ----------
async function setRandomizeTime(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed < 0 || (parsed > 0 && parsed < MIN_RANDOMIZE_MINUTES)) {
    throw new Error(`Interval must be zero or at least ${MIN_RANDOMIZE_MINUTES} minutes.`);
  }
  await callbackCall(cb => chrome.alarms.clear('randomizeAlarm', cb));
  await storage.set({ randomizeTime: parsed });
  const { toggleRandomizeOnSetTimeChecked } = await storage.get('toggleRandomizeOnSetTimeChecked');
  if (parsed > 0 && toggleRandomizeOnSetTimeChecked) {
    await chrome.alarms.create('randomizeAlarm', { delayInMinutes: parsed, periodInMinutes: parsed });
  }
}

// ---------- Message handling ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  serializeState(async () => {
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
          const { autoModIdentificationChecked = false } = await storage.get('autoModIdentificationChecked');
          sendResponse({ detectedModList, profiles, activeProfile, autoModIdentificationChecked });
          console.log('Message: getExtensions -> returned detectedModList + profiles');
          break;
        }

        case 'saveModExtensionIds': {
          // message.profileName optional - if provided save to that profile; else to activeProfile
          const { profileName } = message;
          const s = await storage.get(['profiles', 'activeProfile']);
          const profiles = s.profiles || {};
          const active = profileName || s.activeProfile || 'Default';
          if (!Object.hasOwn(profiles, active)) throw new Error('Profile no longer exists');
          const ids = new Set(profiles[active]);
          if (message.changes) {
            for (const [id, checked] of Object.entries(message.changes)) {
              if (checked) ids.add(id); else ids.delete(id);
            }
          } else {
            throw new Error('Profile selection changes are required');
          }
          profiles[active] = [...ids];
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
          await cleanupUndetectedMods();
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
          if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) {
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
          const { profilesOrder = {} } = await storage.get('profilesOrder');
          delete profilesOrder[profileName];

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

          await storage.set({ profiles, profilesOrder, activeProfile: active });
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
          if (!newN || ['__proto__', 'constructor', 'prototype'].includes(newN)) {
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
          if (newN === oldN) { sendResponse({ status: 'success', activeProfile }); break; }
          const { profilesOrder = {} } = await storage.get('profilesOrder');
          if (Object.hasOwn(profilesOrder, oldN)) { profilesOrder[newN] = profilesOrder[oldN]; delete profilesOrder[oldN]; }
          // Perform rename (allow case-only change as well)
          profiles[newN] = profiles[oldN];
          delete profiles[oldN];
          const newActive = (activeProfile === oldN) ? newN : activeProfile;
          await storage.set({ profiles, profilesOrder, activeProfile: newActive });
          console.log(`Renamed profile ${oldN} -> ${newN}`);
          sendResponse({ status: 'success', activeProfile: newActive });
          break;
        }

        case 'setActiveProfile': {
          const { profileName } = message;
          const name = (profileName || '').trim();
          const { profiles = {}, disableModsOutsideProfileChecked = false } = await storage.get(['profiles', 'disableModsOutsideProfileChecked']);
          if (!profiles[name]) {
            sendResponse({ status: 'error', message: 'Profile not found' });
            break;
          }
          await storage.set({ activeProfile: name });
          if (disableModsOutsideProfileChecked) {
            await disableModsOutsideActiveProfile(profiles[name] || []);
          }
          console.log('Active profile set to', name);
          sendResponse({ status: 'success' });
          break;
        }

        case 'clearMissedNotification': {
          console.log('Clearing missed notification across UI and OS');
          await clearPendingNotification(message.modId);
          sendResponse({ status: 'success' });
          break;
        }

        case 'ensureProfilesOrder': {
          sendResponse(await ensureProfilesOrder());
          break;
        }
        case 'importProfiles': {
          sendResponse(await importProfileData(message.data));
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
  }).catch(error => sendResponse({ status: 'error', message: error.message }));
  return true;
});

// alarms
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'randomizeAlarm') {
    console.log('Alarm fired: randomizeAlarm');
    await serializeState(() => executeRandomization('alarm'));
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
    setTimeout(() => serializeState(() => executeRandomization('startup')).catch(console.error), 1000);
  }
});

chrome.runtime.onInstalled.addListener(details => serializeState(async () => {
  if (details.reason === 'install') {
    // Initialize sensible defaults
    await storage.set({
      toggleRandomizeOnStartupChecked: false,
      autoModIdentificationChecked: false, // randomize-all: OFF by default
      uninstallAndReinstallChecked: true,
      openModsTabChecked: true, // open mods tab: ON by default
      showNotificationsChecked: true, // show notifications: ON by default
      disableModsOutsideProfileChecked: false,
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
    const s = await storage.get(['autoModIdentificationChecked', 'openModsTabChecked', 'showNotificationsChecked', 'disableModsOutsideProfileChecked']);
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
    if (s.disableModsOutsideProfileChecked === undefined) {
      updates.disableModsOutsideProfileChecked = false;
    }
    if (Object.keys(updates).length > 0) {
      await storage.set(updates);
      console.log('Migration: set defaults', updates);
    }
    await identifyModExtensions();
  }
  await ensureDefaults();
}).catch(console.error));

// Monitor for mod installation/uninstallation/enabling/disabling
const updateDetectedMods = async () => {
  console.log('Management event detected, updating mod list...');
  await identifyModExtensions(true);
  const s = await storage.get('autoModIdentificationChecked');
  await addDetectedModsToAllProfiles(!!s.autoModIdentificationChecked);

  tryDeliverToPopup({ action: 'extensionsUpdated' });
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

chrome.management.onInstalled.addListener(details => serializeState(() => onInstalled(details)).catch(console.error));
chrome.management.onUninstalled.addListener(id => serializeState(() => onUninstalled(id)).catch(console.error));
// Removed onEnabled/onDisabled listeners as requested

async function cleanupUndetectedMods() {
  const state = await storage.get(['detectedModList', 'recentlyUninstalled', 'profiles', 'profilesOrder', 'knownDetectedIds']);
  const validIds = new Set((state.detectedModList || []).map(mod => mod.id));
  for (const [id, entry] of Object.entries(state.recentlyUninstalled || {})) {
    const timestamp = typeof entry === 'number' ? entry : entry.timestamp;
    if (Date.now() - timestamp < 60000) validIds.add(id);
  }
  const profiles = state.profiles || {};
  const profilesOrder = state.profilesOrder || {};
  let changed = false;
  for (const collection of [profiles, profilesOrder]) {
    for (const name of Object.keys(collection)) {
      const before = collection[name];
      collection[name] = before.filter(id => validIds.has(id));
      if (before.length !== collection[name].length) changed = true;
    }
  }
  const knownDetectedIds = (state.knownDetectedIds || []).filter(id => validIds.has(id));
  if (changed || knownDetectedIds.length !== (state.knownDetectedIds || []).length) {
    await storage.set({ profiles, profilesOrder, knownDetectedIds });
  }
}

async function ensureProfilesOrder() {
    const st = await storage.get(['profilesOrder', 'profiles']);
    const profiles = st.profiles || {};
    let profilesOrder = st.profilesOrder || {};
    let changed = false;
    for (const profileName of Object.keys(profiles)) {
        if (!profilesOrder[profileName]) {
            profilesOrder[profileName] = Array.isArray(profiles[profileName]) ? [...profiles[profileName]] : [];
            changed = true;
        } else {
            const enabled = Array.isArray(profiles[profileName]) ? profiles[profileName] : [];
            const orderSet = new Set(profilesOrder[profileName]);
            for (const id of enabled) {
                if (!orderSet.has(id)) {
                    profilesOrder[profileName].push(id);
                    orderSet.add(id);
                    changed = true;
                }
            }
        }
    }
    if (changed) {
        await storage.set({ profilesOrder });
        console.log('Initialized/updated profilesOrder');
    }
    return profilesOrder;
}


async function importProfileData(importData) {
  if (!importData?.profiles || Array.isArray(importData.profiles) || typeof importData.profiles !== 'object') throw new Error('Invalid profile file format');
  const s = await storage.get(['profiles', 'profilesOrder', 'detectedModList']);
  const existingProfiles = s.profiles || {};
  const existingOrder = s.profilesOrder || {};
  const detectedModList = s.detectedModList || [];

  const modNameToId = new Map(detectedModList.map(m => [m.name.toLowerCase(), m.id]));
  const detectedIds = new Set(detectedModList.map(m => m.id));

  const results = {
      imported: [],
      skipped: [],
      missingMods: {}
  };

  for (const [profileName, modsArray] of Object.entries(importData.profiles)) {
      if (!profileName.trim() || ['__proto__', 'constructor', 'prototype'].includes(profileName) || !Array.isArray(modsArray)) throw new Error('Invalid profile');
      const existingNames = Object.keys(existingProfiles).map(n => n.toLowerCase());
      if (existingNames.includes(profileName.toLowerCase())) {
          results.skipped.push(profileName);
          continue;
      }

      if (!modsArray || modsArray.length === 0) {
          existingProfiles[profileName] = [];
          existingOrder[profileName] = [];
          results.imported.push(profileName);
          continue;
      }

      const validModIds = [];
      const missingMods = [];

      for (const mod of modsArray) {
          if (!mod || (typeof mod !== 'string' && typeof mod !== 'object')) throw new Error('Invalid mod entry');
          const modId = mod.id || mod;
          const modName = mod.name;

          if (detectedIds.has(modId)) {
              validModIds.push(modId);
          } else if (typeof modName === 'string') {
              const matchedId = modNameToId.get(modName.toLowerCase());
              if (matchedId) {
                  validModIds.push(matchedId);
              } else {
                  missingMods.push(modName);
              }
          } else {
              missingMods.push(`Unknown (${modId})`);
          }
      }

      existingProfiles[profileName] = validModIds;
      existingOrder[profileName] = validModIds;

      results.imported.push(profileName);
      if (missingMods.length > 0) {
          results.missingMods[profileName] = missingMods;
      }
  }

  if (results.imported.length > 0) {
      await storage.set({ profiles: existingProfiles, profilesOrder: existingOrder });
  }
  return results;
}
