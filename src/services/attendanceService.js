import { AppState } from 'react-native';
import AsyncStorage from '../utils/AsyncStorage';
import { supabase } from './supabase';
import { EmployeeStorage } from './employeeStorage';

export const ATTENDANCE_LOGS_KEY = '@attendance_logs';
export const COOLDOWN_MINUTES = 2; // Lockout window to prevent duplicate scans
export const DEFAULT_BRANCH_ID = '72f5c2fb-1ffd-4812-b65e-65af2ca87017';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _isSyncingQueue = false;
let _isNetworkListenerStarted = false;

export const AttendanceService = {
  /**
   * Fast network connectivity check
   */
  async isOnline() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('https://bztspepijnvskcwjwjeb.supabase.co/rest/v1/', {
        method: 'HEAD',
        headers: { apikey: 'sb_publishable_WmVF8jHtS-OYJd6OnhD6wQ_KjU63bf6' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res.status < 500;
    } catch {
      return false;
    }
  },

  /**
   * 1. Get all local attendance records
   */
  async getLocalLogs() {
    try {
      const data = await AsyncStorage.getItem(ATTENDANCE_LOGS_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  /**
   * 2. Find the most recent punch today for this employee
   */
  async getLatestPunchToday(employeeId) {
    if (!employeeId) return null;
    const logs = await this.getLocalLogs();
    const today = new Date().toDateString();
    const targetId = String(employeeId).toLowerCase().trim();

    const employeePunchesToday = logs
      .filter((l) => {
        const idMatches =
          (l.employeeId && String(l.employeeId).toLowerCase().trim() === targetId) ||
          (l.employeeCode && String(l.employeeCode).toLowerCase().trim() === targetId);
        return idMatches && new Date(l.timestamp).toDateString() === today;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return employeePunchesToday.length > 0 ? employeePunchesToday[0] : null;
  },

  /**
   * Resolves authoritative employee UUID and non-null branch_id
   */
  async resolveEmployeeDetails(employee) {
    const rawId = employee.id || employee.userId || employee.employeeId || employee.employee_code;
    const rawCode = employee.employee_code || employee.employeeId || '';
    const rawName = employee.full_name || employee.name || '';

    let empRecord = EmployeeStorage.getEmployeeByIdOrCode(rawId);
    if (!empRecord && rawCode) {
      empRecord = EmployeeStorage.getEmployeeByIdOrCode(rawCode);
    }

    let employeeUuid = empRecord?.id || employee.id || employee.userId;
    let employeeCode = empRecord?.employee_code || rawCode;
    let employeeName = empRecord?.full_name || empRecord?.name || rawName || 'Staff';
    let department = empRecord?.department || employee.department || 'General';
    let branchId = empRecord?.branch_id || empRecord?.branchId || employee.branch_id || employee.branchId;

    // Validate that employeeUuid is a genuine UUID for PostgreSQL FK
    if (!employeeUuid || !UUID_REGEX.test(String(employeeUuid))) {
      try {
        const { data: remoteEmp } = await supabase
          .from('employees')
          .select('id, full_name, employee_code, branch_id, department')
          .or(`employee_code.eq.${employeeCode || rawId},full_name.eq.${employeeName}`)
          .limit(1);

        if (remoteEmp && remoteEmp.length > 0) {
          employeeUuid = remoteEmp[0].id;
          if (!branchId) branchId = remoteEmp[0].branch_id;
          if (remoteEmp[0].full_name) employeeName = remoteEmp[0].full_name;
          if (remoteEmp[0].department) department = remoteEmp[0].department;
        }
      } catch (err) {
        console.warn('[AttendanceService] Remote employee resolution error:', err.message);
      }
    }

    // Branch ID has a NOT-NULL constraint in attendance_logs
    if (!branchId || !UUID_REGEX.test(String(branchId))) {
      branchId = DEFAULT_BRANCH_ID;
    }

    return {
      employeeUuid: String(employeeUuid || rawId),
      employeeCode: String(employeeCode),
      employeeName,
      department,
      branchId: String(branchId),
    };
  },

  /**
   * 3. MAIN FUNCTION: Record attendance punch (Offline-First Queue with Auto-Sync)
   */
  async recordPunch({ employee, similarityScore = 1.0, cooldownMinutes = COOLDOWN_MINUTES }) {
    try {
      const now = new Date();
      const resolved = await this.resolveEmployeeDetails(employee);

      // Check last punch today by both UUID and employee_code
      const lastPunch =
        (await this.getLatestPunchToday(resolved.employeeUuid)) ||
        (resolved.employeeCode ? await this.getLatestPunchToday(resolved.employeeCode) : null);

      // --- RULE 1: DUPLICATE / COOLDOWN CHECK ---
      if (lastPunch) {
        const diffMs = now.getTime() - new Date(lastPunch.timestamp).getTime();
        const cooldownMs = cooldownMinutes * 60 * 1000;
        if (diffMs < cooldownMs) {
          const waitSeconds = Math.ceil((cooldownMs - diffMs) / 1000);
          console.log(`[AttendanceService] Duplicate blocked for "${resolved.employeeName}". Wait ${waitSeconds}s`);
          return {
            status: 'DUPLICATE_BLOCKED',
            waitSeconds,
            lastType: lastPunch.type,
            employeeName: resolved.employeeName,
          };
        }
      }

      // --- RULE 2: STRICT ALTERNATING IN -> OUT -> IN ---
      const isCheckIn = !lastPunch || String(lastPunch.type).toUpperCase() === 'OUT';
      const punchType = isCheckIn ? 'IN' : 'OUT';

      // --- RULE 3: SAVE LOCALLY FIRST (Zero Network Delay) ---
      const newPunch = {
        id: Date.now().toString(),
        employeeId: resolved.employeeUuid,
        employeeCode: resolved.employeeCode,
        employeeName: resolved.employeeName,
        department: resolved.department,
        branchId: resolved.branchId,
        timestamp: now.toISOString(),
        date: now.toISOString().split('T')[0], // "YYYY-MM-DD"
        type: punchType,
        score: Number(similarityScore),
        status: 'PRESENT',
        sync_status: 'pending_sync', // Fix 2: Flagged as pending_sync until cloud confirms
        synced: false,
      };

      const logs = await this.getLocalLogs();
      logs.unshift(newPunch);
      await AsyncStorage.setItem(ATTENDANCE_LOGS_KEY, JSON.stringify(logs.slice(0, 500)));

      // --- RULE 4: NETWORK-AWARE CLOUD SYNC ---
      this.isOnline().then((online) => {
        if (online) {
          this.syncPunchToCloud(newPunch)
            .then(() => {
              // Flush any other pending offline records
              this.syncPendingOfflinePunches().catch(() => {});
            })
            .catch((syncErr) => {
              console.warn('[AttendanceService] Cloud sync deferred (queued as pending_sync):', syncErr.message);
            });
        } else {
          console.log(`[AttendanceService] Device is offline. Queued "${resolved.employeeName}" (${punchType}) as pending_sync.`);
        }
      });

      return {
        status: 'SUCCESS',
        punch: newPunch,
        lastPunch,
      };
    } catch (err) {
      console.error('[AttendanceService] Failed to record punch:', err);
      return { status: 'ERROR', error: err.message };
    }
  },

  /**
   * 4. Upload punch to Supabase (IN creates row, OUT updates row)
   * Broadcasts realtime event so web dashboard table updates immediately.
   */
  async syncPunchToCloud(punch) {
    const nowIso = punch.timestamp;
    const todayStart = new Date(nowIso);
    todayStart.setHours(0, 0, 0, 0);

    // Ensure valid branch_id and employee_id
    let branchId = punch.branchId;
    if (!branchId || !UUID_REGEX.test(String(branchId))) {
      branchId = DEFAULT_BRANCH_ID;
    }

    let resultRecord = null;

    // ==========================================
    // CASE A: Punch OUT -> Update existing open row
    // ==========================================
    if (punch.type === 'OUT') {
      const { data: openLogs, error: searchError } = await supabase
        .from('attendance_logs')
        .select('id, check_in, check_out')
        .eq('employee_id', punch.employeeId)
        .gte('check_in', todayStart.toISOString())
        .is('check_out', null)
        .order('check_in', { ascending: false })
        .limit(1);

      if (!searchError && openLogs && openLogs.length > 0) {
        const { data: updatedRows, error: updateError } = await supabase
          .from('attendance_logs')
          .update({
            check_out: nowIso,
            status: 'PRESENT',
            metadata: {
              similarity_score: punch.score,
              punch_type: 'OUT',
              employee_name: punch.employeeName,
              employee_code: punch.employeeCode,
              client: 'KIOSK_FACE_VERIFIED',
              updated_at: nowIso,
            },
          })
          .eq('id', openLogs[0].id)
          .select();

        if (!updateError && updatedRows && updatedRows.length > 0) {
          resultRecord = updatedRows[0];
          await this.markPunchSynced(punch.id);
          this._broadcastRealtimeUpdate(resultRecord, punch);
          console.log(`[AttendanceService] Punch OUT successfully updated in cloud for ${punch.employeeName}`);
          return;
        }
      }
    }

    // ==========================================
    // CASE B: Punch IN (or fallback if no open IN found) -> Insert new row
    // ==========================================
    const { data: insertedRows, error: insertError } = await supabase
      .from('attendance_logs')
      .insert([
        {
          employee_id: punch.employeeId,
          branch_id: branchId,
          check_in: nowIso,
          check_out: punch.type === 'OUT' ? nowIso : null,
          status: 'PRESENT',
          source: 'BIOMETRIC',
          metadata: {
            similarity_score: punch.score,
            punch_type: punch.type,
            employee_name: punch.employeeName,
            employee_code: punch.employeeCode,
            client: 'KIOSK_FACE_VERIFIED',
          },
        },
      ])
      .select();

    if (!insertError && insertedRows && insertedRows.length > 0) {
      resultRecord = insertedRows[0];
      await this.markPunchSynced(punch.id);
      this._broadcastRealtimeUpdate(resultRecord, punch);
      console.log(`[AttendanceService] Punch ${punch.type} successfully recorded in cloud for ${punch.employeeName}`);
    } else {
      throw insertError || new Error('Insert returned empty result');
    }
  },

  /**
   * Emits Realtime broadcast event so web dashboard tables update instantaneously
   */
  _broadcastRealtimeUpdate(cloudRecord, localPunch) {
    try {
      const channel = supabase.channel('attendance_realtime');
      channel.send({
        type: 'broadcast',
        event: 'punch_recorded',
        payload: {
          id: cloudRecord?.id || localPunch.id,
          employee_id: localPunch.employeeId,
          branch_id: cloudRecord?.branch_id || localPunch.branchId,
          check_in: cloudRecord?.check_in || localPunch.timestamp,
          check_out: cloudRecord?.check_out || null,
          punch_type: localPunch.type,
          status: 'PRESENT',
          employee_name: localPunch.employeeName,
          employee_code: localPunch.employeeCode,
          timestamp: localPunch.timestamp,
        },
      });
    } catch (e) {
      console.warn('[AttendanceService] Realtime broadcast warning:', e.message);
    }
  },

  /**
   * 5. Helper to mark local punch as synced = true and sync_status = 'synced'
   */
  async markPunchSynced(punchId) {
    try {
      const logs = await this.getLocalLogs();
      const updated = logs.map((l) =>
        String(l.id) === String(punchId)
          ? { ...l, synced: true, sync_status: 'synced', synced_at: new Date().toISOString() }
          : l
      );
      await AsyncStorage.setItem(ATTENDANCE_LOGS_KEY, JSON.stringify(updated));
    } catch {}
  },

  /**
   * 6. Offline recovery: Upload any punches with pending_sync status
   */
  async syncPendingOfflinePunches() {
    if (_isSyncingQueue) return 0;
    _isSyncingQueue = true;

    try {
      const online = await this.isOnline();
      if (!online) {
        return 0;
      }

      const logs = await this.getLocalLogs();
      const unsynced = logs.filter((l) => l && (!l.synced || l.sync_status === 'pending_sync'));
      if (unsynced.length === 0) return 0;

      console.log(`[AttendanceService] Auto-retry: Found ${unsynced.length} pending offline punches. Syncing to cloud...`);

      // Sync in chronological order (oldest first)
      const sorted = [...unsynced].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      let syncedCount = 0;
      for (const p of sorted) {
        try {
          await this.syncPunchToCloud(p);
          syncedCount++;
        } catch (err) {
          console.warn(`[AttendanceService] Failed to sync offline punch for ${p.employeeName}:`, err.message);
        }
      }

      if (syncedCount > 0) {
        console.log(`[AttendanceService] Successfully synced ${syncedCount}/${unsynced.length} offline punches to Supabase.`);
      }
      return syncedCount;
    } catch (err) {
      console.warn('[AttendanceService] Offline sync queue error:', err);
      return 0;
    } finally {
      _isSyncingQueue = false;
    }
  },

  /**
   * Starts automatic network listener and periodic retry worker
   */
  startNetworkListener() {
    if (_isNetworkListenerStarted) return;
    _isNetworkListenerStarted = true;

    // 1. App State Listener: Auto-sync when app returns to foreground
    AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        AttendanceService.syncPendingOfflinePunches().catch(() => {});
      }
    });

    // 2. Periodic Queue Poller: Checks every 10 seconds if there are pending offline records
    setInterval(async () => {
      try {
        const logs = await AttendanceService.getLocalLogs();
        const hasPending = logs.some((l) => l && (!l.synced || l.sync_status === 'pending_sync'));
        if (hasPending) {
          AttendanceService.syncPendingOfflinePunches().catch(() => {});
        }
      } catch (_) {}
    }, 10000);

    console.log('[AttendanceService] Network-aware auto-retry listener initialized.');
  },
};

// Initialize background auto-sync worker
AttendanceService.startNetworkListener();

export default AttendanceService;
