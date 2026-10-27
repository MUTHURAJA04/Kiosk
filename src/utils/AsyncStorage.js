import {
  getSettingSync,
  setSettingSync,
  removeSettingSync,
  getDb,
  querySync,
  extractRows,
} from '../database/db.js';

/**
 * Standard AsyncStorage implementation backed by persistent OP-SQLite app_settings table.
 * Fully compatible with the @react-native-async-storage/async-storage API.
 */
const AsyncStorage = {
  async getItem(key) {
    try {
      const val = getSettingSync(key);
      return val !== null && val !== undefined ? String(val) : null;
    } catch (e) {
      console.warn('[AsyncStorage] getItem error:', e);
      return null;
    }
  },

  async setItem(key, value) {
    try {
      setSettingSync(key, String(value));
    } catch (e) {
      console.warn('[AsyncStorage] setItem error:', e);
      throw e;
    }
  },

  async removeItem(key) {
    try {
      removeSettingSync(key);
    } catch (e) {
      console.warn('[AsyncStorage] removeItem error:', e);
      throw e;
    }
  },

  async clear() {
    try {
      const database = getDb();
      querySync(database, `DELETE FROM app_settings`);
    } catch (e) {
      console.warn('[AsyncStorage] clear error:', e);
      throw e;
    }
  },

  async getAllKeys() {
    try {
      const database = getDb();
      const res = querySync(database, `SELECT key FROM app_settings`);
      const rows = extractRows(res);
      return rows ? rows.map((r) => r.key) : [];
    } catch (e) {
      console.warn('[AsyncStorage] getAllKeys error:', e);
      return [];
    }
  },

  async multiGet(keys) {
    try {
      const result = [];
      for (const key of keys) {
        const val = await this.getItem(key);
        result.push([key, val]);
      }
      return result;
    } catch (e) {
      console.warn('[AsyncStorage] multiGet error:', e);
      return keys.map((k) => [k, null]);
    }
  },

  async multiSet(keyValuePairs) {
    try {
      for (const [key, value] of keyValuePairs) {
        await this.setItem(key, value);
      }
    } catch (e) {
      console.warn('[AsyncStorage] multiSet error:', e);
      throw e;
    }
  },

  async multiRemove(keys) {
    try {
      for (const key of keys) {
        await this.removeItem(key);
      }
    } catch (e) {
      console.warn('[AsyncStorage] multiRemove error:', e);
      throw e;
    }
  },
};

export default AsyncStorage;
export { AsyncStorage };
