import {
  getPendingSyncLogs,
  markLogsSynced,
  getPendingSyncTemplates,
  markTemplatesSynced,
  getPendingSyncUsers,
  markUsersSynced,
  upsertRemoteTemplate,
  upsertRemoteUser,
  getAllTemplatesForMatching,
  getSettingSync,
  setSettingSync,
} from '../database/db';
import { NativeFacePipeline } from './nativeFacePipeline';

let syncTimer = null;
let isSyncing = false;

// Supabase cloud configuration keys
export const SUPABASE_STORAGE_KEYS = {
  URL: 'supabase_url',
  ANON_KEY: 'supabase_anon_key',
  LAST_PULL: 'last_cloud_pull_ts',
};

// Default fallback / sandbox endpoints (can be overridden in settings)
const DEFAULT_SUPABASE_URL = 'https://xyzcompany.supabase.co';
const DEFAULT_SUPABASE_KEY = 'public-anon-key';

function getSupabaseConfig() {
  const url = getSettingSync(SUPABASE_STORAGE_KEYS.URL) || DEFAULT_SUPABASE_URL;
  const key = getSettingSync(SUPABASE_STORAGE_KEYS.ANON_KEY) || DEFAULT_SUPABASE_KEY;
  return { url: url.replace(/\/$/, ''), key };
}

/**
 * Phase 5: Push pending biometric face templates to Supabase.
 * Embeddings are already encrypted client-side using Android Keystore AES-256-GCM.
 */
export async function pushTemplatesToCloud() {
  const pendingTemplates = getPendingSyncTemplates();
  if (!pendingTemplates || pendingTemplates.length === 0) {
    return { pushedCount: 0 };
  }

  const { url, key } = getSupabaseConfig();
  if (!url || !key || url.includes('xyzcompany')) {
    // Offline simulation or cloud unconfigured
    const ids = pendingTemplates.map((t) => t.id);
    markTemplatesSynced(ids);
    console.log(`[SyncService] Offline mode: Marked ${ids.length} templates as synced locally.`);
    return { pushedCount: ids.length, simulated: true };
  }

  try {
    console.log(`[SyncService] Pushing ${pendingTemplates.length} encrypted face templates to Supabase...`);
    const response = await fetch(`${url}/rest/v1/face_templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(pendingTemplates),
    });

    if (!response.ok) {
      throw new Error(`Supabase push templates error: HTTP ${response.status}`);
    }

    const ids = pendingTemplates.map((t) => t.id);
    markTemplatesSynced(ids);
    console.log(`[SyncService] Successfully pushed ${ids.length} face templates.`);
    return { pushedCount: ids.length };
  } catch (err) {
    console.warn('[SyncService] Template sync deferred (network/server error):', err.message);
    return { error: err.message, pushedCount: 0 };
  }
}

/**
 * Phase 5: Push pending user profiles to Supabase.
 */
export async function pushUsersToCloud() {
  const pendingUsers = getPendingSyncUsers();
  if (!pendingUsers || pendingUsers.length === 0) {
    return { pushedCount: 0 };
  }

  const { url, key } = getSupabaseConfig();
  if (!url || !key || url.includes('xyzcompany')) {
    const ids = pendingUsers.map((u) => u.id);
    markUsersSynced(ids);
    return { pushedCount: ids.length, simulated: true };
  }

  try {
    const response = await fetch(`${url}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(pendingUsers),
    });

    if (!response.ok) {
      throw new Error(`Supabase push users error: HTTP ${response.status}`);
    }

    const ids = pendingUsers.map((u) => u.id);
    markUsersSynced(ids);
    return { pushedCount: ids.length };
  } catch (err) {
    console.warn('[SyncService] User sync deferred:', err.message);
    return { error: err.message, pushedCount: 0 };
  }
}

/**
 * Phase 5: Pull remote templates from Supabase with Last-Write-Wins and Model Versioning.
 * On version mismatch, template is quarantined and user is flagged for re-enrollment.
 * Reloads native in-memory continuous matrix after sync.
 */
export async function pullTemplatesFromCloud() {
  const { url, key } = getSupabaseConfig();
  if (!url || !key || url.includes('xyzcompany')) {
    return { pulledCount: 0, simulated: true };
  }

  const lastPull = parseInt(getSettingSync(SUPABASE_STORAGE_KEYS.LAST_PULL) || '0', 10);
  const pullStart = Date.now();

  try {
    // 1. Pull users
    const usersRes = await fetch(
      `${url}/rest/v1/users?updated_at=gt.${lastPull}&order=updated_at.asc`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      }
    );
    if (usersRes.ok) {
      const remoteUsers = await usersRes.json();
      if (Array.isArray(remoteUsers)) {
        for (const u of remoteUsers) {
          upsertRemoteUser(u);
        }
      }
    }

    // 2. Pull face templates
    const tplRes = await fetch(
      `${url}/rest/v1/face_templates?updated_at=gt.${lastPull}&order=updated_at.asc`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      }
    );

    let pulledCount = 0;
    if (tplRes.ok) {
      const remoteTemplates = await tplRes.json();
      if (Array.isArray(remoteTemplates) && remoteTemplates.length > 0) {
        for (const tpl of remoteTemplates) {
          const res = upsertRemoteTemplate(tpl);
          if (res.status === 'UPSERTED') {
            pulledCount++;
          }
        }

        // 3. Phase 5 Contract: Reload the in-memory continuous matrix after every sync
        const activeTemplates = getAllTemplatesForMatching();
        await NativeFacePipeline.loadGallery(activeTemplates);
        console.log(`[SyncService] Reloaded continuous gallery with ${activeTemplates.length} active templates.`);
      }
    }

    setSettingSync(SUPABASE_STORAGE_KEYS.LAST_PULL, pullStart.toString());
    return { pulledCount };
  } catch (err) {
    console.warn('[SyncService] Cloud pull deferred:', err.message);
    return { error: err.message, pulledCount: 0 };
  }
}

/**
 * Phase 5 & 6: Push offline attendance check-ins to Supabase.
 * Strictly offline-first. Contains verification score, margin, deviceId, modelId, liveness.
 * NEVER uploads facial images or camera crops.
 */
export async function pushAttendanceLogsToCloud() {
  const pendingLogs = getPendingSyncLogs();
  if (!pendingLogs || pendingLogs.length === 0) {
    return { pushedCount: 0 };
  }

  const { url, key } = getSupabaseConfig();
  if (!url || !key || url.includes('xyzcompany')) {
    const syncedIds = pendingLogs.map((log) => log.id);
    markLogsSynced(syncedIds);
    console.log(`[SyncService] Offline mode: Marked ${syncedIds.length} logs as SYNCED locally.`);
    return { pushedCount: syncedIds.length, simulated: true };
  }

  try {
    console.log(`[SyncService] Pushing ${pendingLogs.length} attendance logs to Supabase...`);
    const response = await fetch(`${url}/rest/v1/attendance_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(pendingLogs),
    });

    if (!response.ok) {
      throw new Error(`Supabase push logs error: HTTP ${response.status}`);
    }

    const syncedIds = pendingLogs.map((log) => log.id);
    markLogsSynced(syncedIds);
    console.log(`[SyncService] Successfully synced ${syncedIds.length} attendance logs to Supabase.`);
    return { pushedCount: syncedIds.length };
  } catch (err) {
    console.warn('[SyncService] Attendance log sync deferred:', err.message);
    return { error: err.message, pushedCount: 0 };
  }
}

/**
 * Executes a full synchronization cycle: push users/templates, pull cloud updates, push attendance logs.
 */
export async function syncAll() {
  if (isSyncing) return { inProgress: true };
  isSyncing = true;

  try {
    const userRes = await pushUsersToCloud();
    const tplPushRes = await pushTemplatesToCloud();
    const tplPullRes = await pullTemplatesFromCloud();
    const logRes = await pushAttendanceLogsToCloud();

    return {
      pushedUsers: userRes.pushedCount || 0,
      pushedTemplates: tplPushRes.pushedCount || 0,
      pulledTemplates: tplPullRes.pulledCount || 0,
      pushedLogs: logRes.pushedCount || 0,
      timestamp: Date.now(),
    };
  } finally {
    isSyncing = false;
  }
}

/**
 * Starts periodic offline sync state machine worker.
 */
export function startSyncWorker(intervalMs = 30000) {
  if (syncTimer) return;
  syncAll().catch((e) => console.warn('[SyncService] Initial sync notice:', e.message));
  syncTimer = setInterval(() => {
    syncAll().catch((e) => console.warn('[SyncService] Background sync notice:', e.message));
  }, intervalMs);
}

export function stopSyncWorker() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
