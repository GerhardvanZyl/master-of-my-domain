// src/storage.js — thin async wrapper over chrome.storage.local
const DSP = {
  get(key, fallback) {
    return new Promise(resolve => {
      chrome.storage.local.get(key, obj =>
        resolve(Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback));
    });
  },
  set(key, value) {
    return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
  },
};
