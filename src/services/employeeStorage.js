import AsyncStorage from '../utils/AsyncStorage';
import { supabase, subscribeToEmployeeChanges } from './supabase';
import {
  getDb,
  querySync,
  extractRows,
  saveEmployeeWithTemplates,
  getAllTemplatesForMatching,
  deleteEmployee,
} from '../database/db';
import { NativeFacePipeline } from './nativeFacePipeline';
import {
  cosineSimilarity,
  FaceMatcher,
  ENROLLMENT_COLLISION_THRESHOLD,
  l2Normalize,
} from './faceMatcher';

export const EMPLOYEES_KEY = '@attendance_employees';
export const ATTENDANCE_LOGS_KEY = '@attendance_logs';
export const LAST_SYNCED_KEY = '@attendance_last_synced';
export const CONFIG_KEY = '@app_dashboard_config';
export const KIOSK_SETTINGS_KEY = '@kiosk_live_settings';

let _syncPromise = null;
let _cachedEmployees = [];
const _listeners = new Set();
let _isRealtimeSubscribed = false;

function _notifyListeners(employees) {
  for (const listener of _listeners) {
    try {
      listener(employees);
    } catch (e) {
      console.warn('[EmployeeStorage] Listener error:', e);
    }
  }
}

export const EmployeeStorage = {
  /**
   * Subscribe to employee directory mutations (e.g. deletions from web)
   */
  addListener(listener) {
    if (typeof listener === 'function') {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    }
    return () => {};
  },

  /**
   * 1. Instant Cache Warm: Reads local storage into memory (<50ms)
   * Pre-loads in-memory contiguous templates into native Kotlin RAM.
   * Starts Realtime cloud employee change listener.
   */
  async init() {
    try {
      const local = await this.getAllEmployees();
      _cachedEmployees = local;

      // Warm up native gallery with all enrolled templates
      const enrolled = local.filter((e) => e.hasFace && e.template);
      if (NativeFacePipeline.isAvailable() && enrolled.length > 0) {
        await NativeFacePipeline.loadGallery(
          enrolled.map((e) => ({
            id: `tpl_${e.id}_frontal`,
            userId: String(e.id),
            employeeId: e.employee_code || e.employeeId || String(e.id),
            name: e.full_name || e.name || '',
            poseTag: 'frontal',
            embedding: Array.from(e.template),
          }))
        );
        console.log(`[EmployeeStorage] Pre-warmed native gallery with ${enrolled.length} enrolled staff.`);
      }

      // Realtime listener for web dashboard deletions and updates
      if (!_isRealtimeSubscribed) {
        _isRealtimeSubscribed = true;
        subscribeToEmployeeChanges(async (payload) => {
          console.log(`[EmployeeStorage] Realtime cloud change event: ${payload.eventType}`);
          if (payload.eventType === 'DELETE') {
            const delId = payload.old?.id;
            const delCode = payload.old?.employee_code;
            console.log(`[EmployeeStorage] Web DELETE received for id=${delId}, code=${delCode}`);
            await EmployeeStorage.removeEmployee(delId || delCode);
          } else if (payload.eventType === 'UPDATE') {
            const isInactive =
              payload.new?.is_active === false ||
              payload.new?.status === 'INACTIVE' ||
              payload.new?.status === 'DELETED';
            if (isInactive) {
              console.log(`[EmployeeStorage] Web soft-delete (INACTIVE) received for:`, payload.new?.full_name);
              await EmployeeStorage.removeEmployee(payload.new?.id || payload.new?.employee_code);
            } else {
              EmployeeStorage.syncEmployeesFromCloud().catch(() => {});
            }
          } else if (payload.eventType === 'INSERT') {
            EmployeeStorage.syncEmployeesFromCloud().catch(() => {});
          }
        });
      }

      return enrolled.length;
    } catch (err) {
      console.warn('[EmployeeStorage] Init error:', err);
      return 0;
    }
  },

  /**
   * Completely removes an employee from local memory, AsyncStorage, SQLite, and Native gallery.
   */
  async removeEmployee(idOrCode) {
    if (!idOrCode) return _cachedEmployees;
    const str = String(idOrCode).toLowerCase().trim();

    // 1. Identify target
    const target = _cachedEmployees.find(
      (e) =>
        (e.id && String(e.id).toLowerCase() === str) ||
        (e.employee_code && String(e.employee_code).toLowerCase() === str) ||
        (e.employeeId && String(e.employeeId).toLowerCase() === str)
    );

    const targetId = target?.id ? String(target.id).toLowerCase().trim() : null;
    const targetCode = (target?.employee_code || target?.employeeId)
      ? String(target.employee_code || target.employeeId).toLowerCase().trim()
      : null;

    // 2. Filter out of in-memory cache
    _cachedEmployees = _cachedEmployees.filter((e) => {
      const eId = e.id ? String(e.id).toLowerCase().trim() : null;
      const eCode = (e.employee_code || e.employeeId)
        ? String(e.employee_code || e.employeeId).toLowerCase().trim()
        : null;
      if (eId === str || eCode === str) return false;
      if (targetId && eId === targetId) return false;
      if (targetCode && eCode === targetCode) return false;
      return true;
    });

    // 3. Persist to AsyncStorage
    await AsyncStorage.setItem(EMPLOYEES_KEY, JSON.stringify(_cachedEmployees));

    // 4. Delete from SQLite users & face_templates
    try {
      if (target?.employee_code) deleteEmployee(target.employee_code);
      if (target?.id) deleteEmployee(target.id);
      deleteEmployee(idOrCode);
    } catch (dbErr) {
      console.warn('[EmployeeStorage] SQLite delete error:', dbErr?.message);
    }

    // 5. Reload synchronized FaceMatcher & native SIMD gallery
    FaceMatcher.loadEnrolledUsersSync();
    const enrolled = _cachedEmployees.filter((e) => e.hasFace && e.template);
    if (NativeFacePipeline.isAvailable()) {
      await NativeFacePipeline.loadGallery(
        enrolled.map((e) => ({
          id: `tpl_${e.id}_frontal`,
          userId: String(e.id),
          employeeId: e.employee_code || String(e.id),
          name: e.full_name || '',
          poseTag: 'frontal',
          embedding: Array.from(e.template),
        }))
      );
    }

    console.log(`[EmployeeStorage] Removed employee: "${target?.full_name || idOrCode}". Active count now: ${_cachedEmployees.length}`);
    _notifyListeners(_cachedEmployees);
    return _cachedEmployees;
  },

  /**
   * Look up employee from in-memory cache by ID or employee_code
   */
  getEmployeeByIdOrCode(idOrCode) {
    if (!idOrCode) return null;
    const str = String(idOrCode).toLowerCase().trim();
    return (
      _cachedEmployees.find(
        (e) =>
          (e.id && String(e.id).toLowerCase() === str) ||
          (e.employee_code && String(e.employee_code).toLowerCase() === str) ||
          (e.employeeId && String(e.employeeId).toLowerCase() === str)
      ) || null
    );
  },

  /**
   * Retrieves all local employees from AsyncStorage or SQLite fallback.
   */
  async getAllEmployees() {
    try {
      const json = await AsyncStorage.getItem(EMPLOYEES_KEY);
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          _cachedEmployees = parsed;
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[EmployeeStorage] AsyncStorage read failed, falling back to SQLite:', e);
    }

    // Fallback: Read from local SQLite
    try {
      const templates = getAllTemplatesForMatching() || [];
      const userTemplatesMap = new Map();
      for (const t of templates) {
        if (!userTemplatesMap.has(t.userId)) {
          userTemplatesMap.set(t.userId, t);
        }
      }

      const database = getDb();
      const res = querySync(database, `SELECT id, employee_id, name, created_at, updated_at FROM users WHERE deleted = 0`);
      const rows = extractRows(res) || [];
      const fallbackList = rows.map((u) => {
        const tpl = userTemplatesMap.get(u.id);
        const hasFace = Boolean(tpl && tpl.embedding);
        return {
          id: u.id,
          full_name: u.name,
          employee_code: u.employee_id,
          role: 'STAFF',
          status: 'ACTIVE',
          hasFace,
          template: tpl?.embedding ? Array.from(tpl.embedding) : null,
          face_updated_at: tpl?.updated_at ? new Date(tpl.updated_at).toISOString() : null,
        };
      });

      if (fallbackList.length > 0) {
        _cachedEmployees = fallbackList;
        AsyncStorage.setItem(EMPLOYEES_KEY, JSON.stringify(fallbackList)).catch(() => {});
      }
      return fallbackList;
    } catch (dbErr) {
      console.warn('[EmployeeStorage] SQLite fallback error:', dbErr);
      return _cachedEmployees || [];
    }
  },

  /**
   * Background Cloud Sync with Authoritative Reconciliation & Mutex Protection
   */
  async syncEmployeesFromCloud() {
    if (_syncPromise) {
      return _syncPromise;
    }

    _syncPromise = (async () => {
      try {
        const localList = await this.getAllEmployees();

        console.log(`[EmployeeStorage] Starting authoritative cloud sync... Local count: ${localList.length}`);

        // Fetch authoritative active employees directory from Supabase
        const { data: remoteEmployees, error } = await supabase
          .from('employees')
          .select('id, full_name, employee_code, role, department, branch_id, phone, status, is_active, face_embedding, face_updated_at')
          .order('full_name', { ascending: true });

        if (error) {
          console.warn('[EmployeeStorage] Supabase query error (keeping offline cache):', error.message);
          return localList;
        }

        console.log(`[EmployeeStorage] Received ${remoteEmployees?.length || 0} remote records from Supabase.`);

        // 1. Filter authoritative active remote staff
        const activeRemote = (remoteEmployees || []).filter(
          (rem) => rem.is_active !== false && rem.status !== 'INACTIVE' && rem.status !== 'DELETED'
        );

        const activeRemoteIdSet = new Set();
        const activeRemoteCodeSet = new Set();
        for (const rem of activeRemote) {
          if (rem.id) activeRemoteIdSet.add(String(rem.id).toLowerCase().trim());
          if (rem.employee_code) activeRemoteCodeSet.add(String(rem.employee_code).toLowerCase().trim());
        }

        // 2. Authoritative Reconciliation: Purge deleted staff from SQLite
        const toPurge = [];
        for (const loc of localList) {
          const locId = loc.id ? String(loc.id).toLowerCase().trim() : null;
          const locCode = (loc.employee_code || loc.employeeId)
            ? String(loc.employee_code || loc.employeeId).toLowerCase().trim()
            : null;
          const inRemote = (locId && activeRemoteIdSet.has(locId)) || (locCode && activeRemoteCodeSet.has(locCode));
          if (!inRemote) {
            toPurge.push(loc);
          }
        }

        if (toPurge.length > 0) {
          console.log(`[EmployeeStorage] Authoritative reconciliation: purging ${toPurge.length} deleted/inactive employees from local storage.`);
          for (const del of toPurge) {
            try {
              if (del.employee_code) deleteEmployee(del.employee_code);
              if (del.employeeId) deleteEmployee(del.employeeId);
              if (del.id) deleteEmployee(del.id);
            } catch (e) {
              console.warn('[EmployeeStorage] SQLite delete error for purged user:', e.message);
            }
          }
        }

        // 3. Map local records for face embedding matching
        const localMap = new Map();
        for (const loc of localList) {
          if (loc.id) localMap.set(String(loc.id).toLowerCase().trim(), loc);
          if (loc.employee_code) localMap.set(String(loc.employee_code).toLowerCase().trim(), loc);
          if (loc.employeeId) localMap.set(String(loc.employeeId).toLowerCase().trim(), loc);
        }

        const autoHealPromises = [];
        const mergedList = [];

        for (const rem of activeRemote) {
          const remId = rem.id ? String(rem.id).toLowerCase().trim() : null;
          const remCode = rem.employee_code ? String(rem.employee_code).toLowerCase().trim() : null;
          const localMatch = (remId && localMap.get(remId)) || (remCode && localMap.get(remCode)) || null;

          const remoteHasFace = Array.isArray(rem.face_embedding) && rem.face_embedding.length === 512;
          const localHasFace = Boolean(localMatch && localMatch.hasFace && localMatch.template && localMatch.template.length === 512);

          let finalTemplate = null;
          let finalFaceUpdated = rem.face_updated_at;
          let hasFace = false;

          // Rule 1: Auto-Heal Cloud
          // If local has embedding but cloud record has none, upload local embedding to Supabase in background
          if (localHasFace && !remoteHasFace) {
            finalTemplate = localMatch.template;
            finalFaceUpdated = localMatch.face_updated_at || new Date().toISOString();
            hasFace = true;

            autoHealPromises.push(
              supabase
                .from('employees')
                .update({
                  face_embedding: Array.from(finalTemplate),
                  face_updated_at: finalFaceUpdated,
                })
                .eq('id', rem.id)
                .then(() => console.log(`[EmployeeStorage] Auto-healed cloud embedding for: ${rem.full_name}`))
                .catch((e) => console.warn(`[EmployeeStorage] Auto-heal failed for ${rem.full_name}:`, e.message))
            );
          } else if (remoteHasFace) {
            // Rule 2: Conflict Resolution (Last-Write-Wins based on face_updated_at)
            if (localHasFace && localMatch.face_updated_at && rem.face_updated_at) {
              const remoteTime = new Date(rem.face_updated_at).getTime();
              const localTime = new Date(localMatch.face_updated_at).getTime();
              if (localTime > remoteTime) {
                finalTemplate = localMatch.template;
                finalFaceUpdated = localMatch.face_updated_at;
              } else {
                finalTemplate = rem.face_embedding;
                finalFaceUpdated = rem.face_updated_at;
              }
            } else {
              finalTemplate = rem.face_embedding;
              finalFaceUpdated = rem.face_updated_at;
            }
            hasFace = true;
          }

          const mergedEmp = {
            id: rem.id,
            full_name: rem.full_name,
            employee_code: rem.employee_code,
            role: rem.role || 'STAFF',
            department: rem.department || '',
            branch_id: rem.branch_id || '',
            phone: rem.phone || '',
            status: rem.status || 'ACTIVE',
            hasFace,
            template: finalTemplate ? Array.from(finalTemplate) : null,
            face_updated_at: finalFaceUpdated,
          };

          mergedList.push(mergedEmp);

          // Sync to SQLite users & face_templates
          if (hasFace && finalTemplate) {
            try {
              saveEmployeeWithTemplates(
                rem.employee_code || rem.id,
                rem.full_name,
                [
                  {
                    poseTag: 'frontal',
                    embedding: finalTemplate,
                    qualityScore: 1.0,
                    luma: 120,
                    blurVariance: 100,
                  },
                ],
                { isSync: true }
              );
            } catch (sqErr) {
              console.warn('[EmployeeStorage] SQLite sync error for employee:', rem.full_name, sqErr);
            }
          }
        }

        _cachedEmployees = mergedList;

        // Persist to local AsyncStorage
        await AsyncStorage.setItem(EMPLOYEES_KEY, JSON.stringify(mergedList));
        await AsyncStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());

        // Refresh FaceMatcher and native SIMD RAM gallery
        FaceMatcher.loadEnrolledUsersSync();
        const enrolled = mergedList.filter((e) => e.hasFace && e.template);
        if (NativeFacePipeline.isAvailable()) {
          await NativeFacePipeline.loadGallery(
            enrolled.map((e) => ({
              id: `tpl_${e.id}_frontal`,
              userId: String(e.id),
              employeeId: e.employee_code || String(e.id),
              name: e.full_name,
              poseTag: 'frontal',
              embedding: Array.from(e.template),
            }))
          );
        }

        // Fetch live organization settings
        try {
          const { data: settingsData } = await supabase.from('organization_settings').select('*');
          if (settingsData && settingsData.length > 0) {
            const settingsObj = {};
            for (const s of settingsData) {
              settingsObj[s.key] = s.value;
            }
            await AsyncStorage.setItem(KIOSK_SETTINGS_KEY, JSON.stringify(settingsObj));
          }
        } catch (_) {}

        if (autoHealPromises.length > 0) {
          Promise.allSettled(autoHealPromises).catch(() => {});
        }

        _notifyListeners(mergedList);
        console.log(`[EmployeeStorage] Sync complete. Total active staff: ${mergedList.length}, Enrolled: ${enrolled.length}`);
        return mergedList;
      } catch (err) {
        console.error('[EmployeeStorage] syncEmployeesFromCloud error:', err);
        return _cachedEmployees || [];
      }
    })().finally(() => {
      _syncPromise = null;
    });

    return _syncPromise;
  },

  /**
   * Verifies that the given face embedding vector does not already match
   * any active employee in either Supabase (cloud) or local storage / SQLite.
   *
   * @param {Object} params
   * @param {Array|Float32Array} params.candidateEmbedding - 512-D float vector
   * @param {Object} params.currentEmployee - Current employee being enrolled
   * @param {number} [params.threshold=ENROLLMENT_COLLISION_THRESHOLD] - Collision rejection threshold
   * @returns {Promise<{ isDuplicate: boolean, matchedEmployee?: Object, similarity?: number, source?: string }>}
   */
  async verifyFaceUniqueness({
    candidateEmbedding,
    currentEmployee,
    threshold = ENROLLMENT_COLLISION_THRESHOLD,
  }) {
    if (!candidateEmbedding || candidateEmbedding.length !== 512) {
      return { isDuplicate: false };
    }

    const normCandidate = l2Normalize(
      Array.isArray(candidateEmbedding)
        ? new Float32Array(candidateEmbedding)
        : candidateEmbedding,
      false
    );

    const isMatchSelf = (other) => {
      if (!other || !currentEmployee) return false;
      const clean = (v) => {
        if (!v) return null;
        const s = String(v).trim().toLowerCase();
        if (!s || s === 'id-n/a' || s === 'null' || s === 'undefined' || s === 'employee') return null;
        return s;
      };

      const currId = clean(currentEmployee.id);
      const currCode = clean(currentEmployee.employee_code || currentEmployee.employeeId);

      const otherId = clean(other.id || other.userId);
      const otherCode = clean(other.employee_code || other.employeeId);

      if (currId && otherId && currId === otherId) return true;
      if (currCode && otherCode && currCode === otherCode) return true;
      if (currId && otherCode && currId === otherCode) return true;
      if (currCode && otherId && currCode === otherId) return true;
      return false;
    };

    // 1. Supabase Cloud Check (First-line Cloud Authority if online)
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cloud verification timeout')), 3500)
      );

      const fetchPromise = supabase
        .from('employees')
        .select('id, full_name, employee_code, department, role, is_active, status, face_embedding')
        .not('face_embedding', 'is', null);

      const { data: cloudStaff, error } = await Promise.race([fetchPromise, timeoutPromise]);

      if (!error && Array.isArray(cloudStaff) && cloudStaff.length > 0) {
        for (const rem of cloudStaff) {
          const isActive =
            rem.is_active !== false &&
            rem.status !== 'INACTIVE' &&
            rem.status !== 'DELETED';
          if (!isActive) continue;

          if (isMatchSelf(rem)) continue;

          let remVec = null;
          if (Array.isArray(rem.face_embedding)) {
            remVec = rem.face_embedding;
          } else if (typeof rem.face_embedding === 'string') {
            try {
              remVec = JSON.parse(rem.face_embedding);
            } catch (_) {}
          }

          if (remVec && remVec.length === 512) {
            const normRem = l2Normalize(new Float32Array(remVec), false);
            const sim = cosineSimilarity(normCandidate, normRem);
            if (sim >= threshold) {
              console.log(
                `[EmployeeStorage] Cloud collision detected vs "${rem.full_name}" (${rem.employee_code || rem.id}): Sim=${sim.toFixed(4)} >= ${threshold}`
              );
              return {
                isDuplicate: true,
                matchedEmployee: rem,
                similarity: sim,
                source: 'SUPABASE_CLOUD',
              };
            }
          }
        }
      }
    } catch (cloudErr) {
      console.warn('[EmployeeStorage] Cloud uniqueness check skipped/offline:', cloudErr.message);
    }

    // 2. Local In-Memory & AsyncStorage Employees Check
    try {
      const localStaff = await this.getAllEmployees();
      for (const loc of localStaff) {
        const isActive =
          loc.is_active !== false &&
          loc.status !== 'INACTIVE' &&
          loc.status !== 'DELETED';
        if (!isActive) continue;

        if (isMatchSelf(loc)) continue;

        let locVec = null;
        if (Array.isArray(loc.template)) {
          locVec = loc.template;
        } else if (typeof loc.template === 'string') {
          try {
            locVec = JSON.parse(loc.template);
          } catch (_) {}
        } else if (Array.isArray(loc.face_embedding)) {
          locVec = loc.face_embedding;
        }

        if (locVec && locVec.length === 512) {
          const normLoc = l2Normalize(new Float32Array(locVec), false);
          const sim = cosineSimilarity(normCandidate, normLoc);
          if (sim >= threshold) {
            console.log(
              `[EmployeeStorage] Local storage collision detected vs "${loc.full_name}" (${loc.employee_code || loc.id}): Sim=${sim.toFixed(4)} >= ${threshold}`
            );
            return {
              isDuplicate: true,
              matchedEmployee: loc,
              similarity: sim,
              source: 'LOCAL_STORAGE',
            };
          }
        }
      }
    } catch (localErr) {
      console.warn('[EmployeeStorage] Local storage uniqueness check error:', localErr.message);
    }

    // 3. Local SQLite face_templates & users Check
    try {
      const sqliteTemplates = getAllTemplatesForMatching() || [];
      for (const t of sqliteTemplates) {
        if (isMatchSelf({ id: t.userId, employee_code: t.employeeId })) continue;

        let tplVec = null;
        if (Array.isArray(t.embedding) || t.embedding instanceof Float32Array) {
          tplVec = t.embedding;
        } else if (typeof t.embedding === 'string') {
          if (t.embedding.startsWith('[') && t.embedding.endsWith(']')) {
            try {
              tplVec = JSON.parse(t.embedding);
            } catch (_) {}
          } else if (NativeFacePipeline.isAvailable()) {
            try {
              tplVec = await NativeFacePipeline.decryptEmbedding(t.embedding);
            } catch (_) {}
          }
        }

        if (tplVec && tplVec.length === 512) {
          const normTpl = l2Normalize(
            tplVec instanceof Float32Array ? tplVec : new Float32Array(tplVec),
            false
          );
          const sim = cosineSimilarity(normCandidate, normTpl);
          if (sim >= threshold) {
            console.log(
              `[EmployeeStorage] SQLite collision detected vs "${t.name}" (${t.employeeId}): Sim=${sim.toFixed(4)} >= ${threshold}`
            );
            return {
              isDuplicate: true,
              matchedEmployee: {
                id: t.userId,
                full_name: t.name,
                employee_code: t.employeeId,
              },
              similarity: sim,
              source: 'LOCAL_SQLITE',
            };
          }
        }
      }
    } catch (sqlErr) {
      console.warn('[EmployeeStorage] SQLite uniqueness check error:', sqlErr.message);
    }

    return { isDuplicate: false };
  },

  /**
   * Saves employee face template both locally and pushes to Supabase
   */
  async saveEmployeeFaceCloudAndLocal({ employee, template, skipDuplicateCheck = false }) {
    if (!employee || !template || template.length !== 512) {
      throw new Error('Invalid employee or 512-D template vector');
    }

    const templateArray = Array.from(template);
    const nowIso = new Date().toISOString();

    // 1. Duplicate Biometric Check: Prevent registering same face under multiple IDs
    if (!skipDuplicateCheck) {
      const uniquenessResult = await this.verifyFaceUniqueness({
        candidateEmbedding: templateArray,
        currentEmployee: employee,
        threshold: ENROLLMENT_COLLISION_THRESHOLD,
      });

      if (uniquenessResult.isDuplicate) {
        const m = uniquenessResult.matchedEmployee;
        const matchedName = m.full_name || m.name || 'Registered Employee';
        const matchedCode = m.employee_code || m.id || 'N/A';
        const simPct = (uniquenessResult.similarity * 100).toFixed(1);
        throw new Error(
          `COLLISION_ERROR: Biometric template matches "${matchedName}" (${matchedCode}) in ${uniquenessResult.source} with score ${simPct}%`
        );
      }
    }

    // 2. Save Locally First (Instant Offline Readiness)
    const employeeToSave = {
      ...employee,
      hasFace: true,
      template: templateArray,
      face_embedding: templateArray,
      face_updated_at: nowIso,
    };

    // Update SQLite database
    const savedUser = saveEmployeeWithTemplates(
      employee.employee_code || employee.id,
      employee.full_name,
      [
        {
          poseTag: 'frontal',
          embedding: templateArray,
          qualityScore: 1.0,
          luma: 120,
          blurVariance: 100,
        },
      ]
    );

    // Update RAM gallery
    if (NativeFacePipeline.isAvailable()) {
      await NativeFacePipeline.addTemplate({
        id: `tpl_${employee.id}_frontal`,
        userId: String(employee.id),
        employeeId: employee.employee_code || String(employee.id),
        name: employee.full_name,
        poseTag: 'frontal',
        embedding: templateArray,
      });
    }

    // Update local list cache
    const currentList = await this.getAllEmployees();
    const index = currentList.findIndex((e) => e.id === employee.id || e.employee_code === employee.employee_code);
    if (index >= 0) {
      currentList[index] = employeeToSave;
    } else {
      currentList.push(employeeToSave);
    }
    _cachedEmployees = currentList;
    await AsyncStorage.setItem(EMPLOYEES_KEY, JSON.stringify(currentList));

    // 3. Push to Supabase Cloud
    let cloudSynced = false;
    try {
      let targetUuid = employee.id;
      const isValidUuid =
        typeof targetUuid === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUuid);

      if (!isValidUuid) {
        const { data: found } = await supabase
          .from('employees')
          .select('id')
          .or(`employee_code.eq.${employee.employee_code},full_name.eq.${employee.full_name}`)
          .limit(1);

        if (found && found.length > 0) {
          targetUuid = found[0].id;
        } else {
          const { data: created } = await supabase
            .from('employees')
            .insert([
              {
                full_name: employee.full_name,
                employee_code: employee.employee_code || `EMP_${Date.now()}`,
                role: employee.role || 'STAFF',
                status: 'ACTIVE',
                face_embedding: templateArray,
                face_updated_at: nowIso,
              },
            ])
            .select('id')
            .single();

          if (created?.id) {
            targetUuid = created.id;
            cloudSynced = true;
            console.log(`[EmployeeStorage] Provisioned new cloud staff record for: ${employee.full_name}`);
          }
        }
      }

      if (!cloudSynced && targetUuid) {
        const { error } = await supabase
          .from('employees')
          .update({
            face_embedding: templateArray,
            face_updated_at: nowIso,
          })
          .eq('id', targetUuid);

        if (!error) {
          cloudSynced = true;
          console.log(`[EmployeeStorage] Successfully pushed face embedding to Supabase for: ${employee.full_name}`);
        } else {
          console.warn('[EmployeeStorage] Cloud push error:', error.message);
        }
      }
    } catch (pushErr) {
      console.warn('[EmployeeStorage] Cloud push network error:', pushErr.message);
    }

    return {
      success: true,
      cloudSynced,
      user: savedUser,
    };
  },
};

export default EmployeeStorage;
