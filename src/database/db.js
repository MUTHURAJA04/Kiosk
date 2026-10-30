import { open } from '@op-engineering/op-sqlite';

let db = null;

/**
 * Safely executes a SQL query synchronously using op-sqlite executeSync or async fallback.
 */
export function querySync(database, sql, params = []) {
  if (typeof database.executeSync === 'function') {
    return database.executeSync(sql, params);
  }
  // Fallback for older versions or web wrappers
  return database.execute(sql, params);
}

/**
 * Safely extracts row objects from op-sqlite query result regardless of SDK version.
 */
export function extractRows(result) {
  if (!result || !result.rows) return [];
  if (Array.isArray(result.rows)) {
    return result.rows;
  }
  if (Array.isArray(result.rows._array)) {
    return result.rows._array;
  }
  const list = [];
  const len = result.rows.length ?? 0;
  for (let i = 0; i < len; i++) {
    const item = typeof result.rows.item === 'function' ? result.rows.item(i) : result.rows[i];
    if (item) list.push(item);
  }
  return list;
}

/**
 * Initializes SQLite database and creates tables if they don't exist.
 */
export function getDb() {
  if (!db) {
    console.log('[OP-SQLite] Opening database: attendance_kiosk.db');
    db = open({ name: 'attendance_kiosk.db' });
    initTables();
  }
  return db;
}

function initTables() {
  const database = getDb();
  console.log('[OP-SQLite] Ensuring schema and indexes exist...');

  // Table for registered employees and their 512-d embeddings
  querySync(
    database,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      employee_id TEXT UNIQUE NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );`
  );

  // Safe schema migration: ensure updated_at column exists
  try {
    querySync(database, `ALTER TABLE users ADD COLUMN updated_at INTEGER;`);
  } catch (e) {
    // Column already exists
  }

  // Multi-template table for guided enrollment (5-8 templates per user covering poses)
  querySync(
    database,
    `CREATE TABLE IF NOT EXISTS face_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pose_tag TEXT NOT NULL,
      embedding TEXT NOT NULL,
      quality_score REAL NOT NULL,
      luma REAL,
      blur_variance REAL,
      yaw REAL,
      pitch REAL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`
  );

  querySync(database, `CREATE INDEX IF NOT EXISTS idx_face_templates_user ON face_templates(user_id);`);

  // Phase 5 Schema Migrations: Ensure cloud sync, encryption, and model versioning columns exist
  const templateCols = [
    { col: 'model_id', type: "TEXT DEFAULT 'edgeface_s_g05_fp32_v1'" },
    { col: 'pipeline_version', type: "TEXT DEFAULT 'v1.0'" },
    { col: 'quality_json', type: 'TEXT' },
    { col: 'session_id', type: 'TEXT' },
    { col: 'updated_at', type: 'INTEGER' },
    { col: 'deleted', type: 'INTEGER DEFAULT 0' },
    { col: 'synced', type: 'INTEGER DEFAULT 0' },
  ];
  for (const { col, type } of templateCols) {
    try {
      querySync(database, `ALTER TABLE face_templates ADD COLUMN ${col} ${type};`);
    } catch (_) {}
  }

  querySync(database, `CREATE INDEX IF NOT EXISTS idx_face_templates_synced ON face_templates(synced);`);
  querySync(database, `CREATE INDEX IF NOT EXISTS idx_face_templates_updated ON face_templates(updated_at);`);

  const userCols = [
    { col: 'consent_timestamp', type: 'INTEGER' },
    { col: 'consent_version', type: 'TEXT' },
    { col: 're_enroll_required', type: 'INTEGER DEFAULT 0' },
    { col: 'deleted', type: 'INTEGER DEFAULT 0' },
    { col: 'synced', type: 'INTEGER DEFAULT 0' },
  ];
  for (const { col, type } of userCols) {
    try {
      querySync(database, `ALTER TABLE users ADD COLUMN ${col} ${type};`);
    } catch (_) {}
  }

  querySync(database, `CREATE INDEX IF NOT EXISTS idx_users_synced ON users(synced);`);

  // Migrate legacy users with single embeddings into face_templates
  try {
    querySync(
      database,
      `INSERT INTO face_templates (id, user_id, pose_tag, embedding, quality_score, luma, blur_variance, yaw, pitch, created_at, updated_at, deleted, synced, model_id, pipeline_version)
       SELECT 'tpl_' || id || '_mig', id, 'frontal', embedding, 1.0, 128.0, 100.0, 0.0, 0.0, created_at, created_at, 0, 0, 'edgeface_s_g05_fp32_v1', 'v1.0'
       FROM users
       WHERE embedding IS NOT NULL AND embedding != ''
         AND id NOT IN (SELECT DISTINCT user_id FROM face_templates);`
    );
  } catch (migErr) {
    console.warn('[OP-SQLite] Migration of legacy embeddings into face_templates warning:', migErr?.message);
  }

  // Safe schema migration: verify embedding column is nullable
  try {
    querySync(
      database,
      `INSERT INTO users (id, name, employee_id, embedding, created_at) VALUES ('__test_mig__', 'test', '__test_mig__', NULL, 0);`
    );
    querySync(database, `DELETE FROM users WHERE id = '__test_mig__';`);
  } catch (notNullErr) {
    console.log('[OP-SQLite] Migrating users table to make embedding nullable...');
    querySync(database, `CREATE TABLE IF NOT EXISTS users_mig (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      employee_id TEXT UNIQUE NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );`);
    querySync(
      database,
      `INSERT INTO users_mig (id, name, employee_id, embedding, created_at)
       SELECT id, name, employee_id, embedding, created_at FROM users;`
    );
    querySync(database, `DROP TABLE users;`);
    querySync(database, `ALTER TABLE users_mig RENAME TO users;`);
    console.log('[OP-SQLite] Migration complete. All employee records preserved.');
  }

  // Table for offline attendance check-ins and cloud sync tracking
  querySync(
    database,
    `CREATE TABLE IF NOT EXISTS attendance_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      name TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      sync_status TEXT DEFAULT 'PENDING'
    );`
  );

  querySync(
    database,
    `CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      name TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      sync_status TEXT DEFAULT 'PENDING'
    );`
  );

  querySync(database, `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON attendance_logs(timestamp);`);
  querySync(database, `CREATE INDEX IF NOT EXISTS idx_logs_sync ON attendance_logs(sync_status);`);
  querySync(database, `CREATE INDEX IF NOT EXISTS idx_records_timestamp ON attendance_records(timestamp);`);

  // Phase 5: Ensure attendance log schema columns exist for offline-first sync
  const logCols = [
    { col: 'type', type: "TEXT DEFAULT 'IN'" },
    { col: 'margin', type: 'REAL DEFAULT 0.0' },
    { col: 'device_id', type: 'TEXT' },
    { col: 'model_id', type: "TEXT DEFAULT 'edgeface_s_g05_fp32_v1'" },
    { col: 'liveness_passed', type: 'INTEGER DEFAULT 1' },
    { col: 'synced', type: 'INTEGER DEFAULT 0' },
  ];
  for (const { col, type } of logCols) {
    try {
      querySync(database, `ALTER TABLE attendance_logs ADD COLUMN ${col} ${type};`);
    } catch (_) {}
  }
  querySync(database, `CREATE INDEX IF NOT EXISTS idx_logs_synced ON attendance_logs(synced);`);

  // Table for key-value application settings & tuning persistence
  querySync(
    database,
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`
  );

  console.log('[OP-SQLite] Tables and indexes initialized successfully.');
}

/**
 * Save newly registered user with averaged 512-d vector.
 * Strictly validates that vector is non-null, non-empty, and non-zero.
 */
export function registerUser(name, employeeId, embeddingArray) {
  if (!embeddingArray || embeddingArray.length === 0) {
    throw new Error('Registration failed: Face embedding vector is empty or null.');
  }

  // Validate vector numbers and check for all-zeros / NaNs
  let sumSq = 0;
  for (let i = 0; i < embeddingArray.length; i++) {
    const val = embeddingArray[i];
    if (isNaN(val)) {
      throw new Error(`Registration failed: Face embedding contains NaN at index ${i}.`);
    }
    sumSq += val * val;
  }

  if (sumSq <= 1e-6) {
    throw new Error('Registration failed: Face embedding is an all-zero or degenerate vector.');
  }

  const database = getDb();
  const id = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const embeddingJson = JSON.stringify(Array.from(embeddingArray));
  const createdAt = Date.now();

  const sampleVals = Array.from(embeddingArray.slice(0, 4)).map((v) => v.toFixed(3));
  console.log(
    `[OP-SQLite] Inserting user "${name}" (ID: ${employeeId}) into users table with dim=${embeddingArray.length}, sample=[${sampleVals.join(', ')}]...`
  );

  querySync(
    database,
    `INSERT INTO users (id, name, employee_id, embedding, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       name = excluded.name,
       embedding = excluded.embedding,
       updated_at = excluded.updated_at`,
    [id, name, employeeId, embeddingJson, createdAt, createdAt]
  );

  console.log(`[OP-SQLite] User saved successfully with id: ${id}`);
  return { id, name, employeeId, createdAt };
}

/**
 * Creates or updates an employee's basic profile (name and ID) without requiring a face embedding.
 */
export function createOrUpdateEmployeeBasicInfo(employeeId, fullName) {
  const database = getDb();
  const empId = employeeId.trim();
  const name = fullName.trim();
  const now = Date.now();
  const id = `usr_${now}_${Math.random().toString(36).substring(2, 7)}`;

  querySync(
    database,
    `INSERT INTO users (id, name, employee_id, embedding, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at`,
    [id, name, empId, now, now]
  );

  return { id, name, employeeId: empId, createdAt: now, updatedAt: now };
}

/**
 * Saves or updates an employee and stores their multi-pose templates in face_templates.
 * Also keeps users.embedding synchronized with the frontal template for backward compatibility.
 */
export function saveEmployeeWithTemplates(employeeId, fullName, templatesArray, options = {}) {
  if (!templatesArray || templatesArray.length === 0) {
    throw new Error('Multi-template enrollment failed: No valid templates provided.');
  }

  const database = getDb();
  const empId = employeeId.trim();
  const name = fullName.trim();
  const now = Date.now();
  const sessionId = options.sessionId || `sess_${now}_${Math.random().toString(36).substring(2, 6)}`;
  const consentTimestamp = options.consentTimestamp || now;
  const consentVersion = options.consentVersion || 'DPDP-2023-v1';

  // Find existing user or generate new id
  const existingUserRes = querySync(database, `SELECT id FROM users WHERE employee_id = ?`, [empId]);
  const existingRows = extractRows(existingUserRes);
  const userId =
    existingRows && existingRows.length > 0
      ? existingRows[0].id
      : `usr_${now}_${Math.random().toString(36).substring(2, 7)}`;

  // Find primary frontal template or first template
  const frontalTpl = templatesArray.find((t) => t.poseTag === 'frontal') || templatesArray[0];
  const primaryEmbedding = typeof frontalTpl.embedding === 'string'
    ? frontalTpl.embedding
    : JSON.stringify(Array.from(frontalTpl.embedding));

  // Upsert user with DPDP consent and sync flags
  querySync(
    database,
    `INSERT INTO users (id, name, employee_id, embedding, created_at, updated_at, consent_timestamp, consent_version, deleted, synced, re_enroll_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
     ON CONFLICT(employee_id) DO UPDATE SET
       name = excluded.name,
       embedding = excluded.embedding,
       updated_at = excluded.updated_at,
       consent_timestamp = COALESCE(excluded.consent_timestamp, users.consent_timestamp),
       consent_version = COALESCE(excluded.consent_version, users.consent_version),
       deleted = 0,
       synced = 0,
       re_enroll_required = 0`,
    [userId, name, empId, primaryEmbedding, now, now, consentTimestamp, consentVersion]
  );

  // Soft-delete or clear existing templates for this user to ensure only fresh pose set is active
  querySync(database, `DELETE FROM face_templates WHERE user_id = ?`, [userId]);

  // Insert all new templates with model versioning and cloud sync attributes
  for (const tpl of templatesArray) {
    const tplId = `tpl_${userId}_${tpl.poseTag || 'pose'}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const embStored = typeof tpl.embedding === 'string'
      ? tpl.embedding
      : JSON.stringify(Array.from(tpl.embedding));

    const qualityJson = JSON.stringify({
      luma: tpl.luma,
      blurVariance: tpl.blurVariance,
      yaw: tpl.yaw,
      pitch: tpl.pitch,
      roll: tpl.roll,
      eyeOpenProbability: tpl.eyeOpenProbability,
    });

    querySync(
      database,
      `INSERT INTO face_templates (
        id, user_id, pose_tag, embedding, quality_score, luma, blur_variance, yaw, pitch,
        model_id, pipeline_version, quality_json, session_id, created_at, updated_at, deleted, synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'edgeface_s_g05_fp32_v1', 'v1.0', ?, ?, ?, ?, 0, 0)`,
      [
        tplId,
        userId,
        tpl.poseTag || 'unknown',
        embStored,
        Number(tpl.qualityScore || 1.0),
        tpl.luma != null ? Number(tpl.luma) : null,
        tpl.blurVariance != null ? Number(tpl.blurVariance) : null,
        tpl.yaw != null ? Number(tpl.yaw) : null,
        tpl.pitch != null ? Number(tpl.pitch) : null,
        qualityJson,
        sessionId,
        now,
        now,
      ]
    );
  }

  console.log(`[OP-SQLite] Saved employee ${name} (${empId}) with ${templatesArray.length} face templates.`);
  return { id: userId, employeeId: empId, name, templateCount: templatesArray.length };
}

/**
 * Updates or registers the 512-d biometric face embedding for an existing employee.
 */
export function updateEmployeeEmbedding(employeeId, embeddingArray) {
  if (!embeddingArray || embeddingArray.length === 0) {
    throw new Error('Face embedding vector is empty or null.');
  }

  const database = getDb();
  const empId = employeeId.trim();
  const embeddingJson = JSON.stringify(Array.from(embeddingArray));
  const now = Date.now();

  querySync(
    database,
    `UPDATE users SET embedding = ?, updated_at = ? WHERE employee_id = ?`,
    [embeddingJson, now, empId]
  );

  return { employeeId: empId, updatedAt: now };
}

/**
 * Permanently deletes an employee and their biometric records.
 */
export function deleteEmployee(employeeIdOrUuid) {
  if (!employeeIdOrUuid) return { success: false };
  const database = getDb();
  const target = String(employeeIdOrUuid).trim();
  querySync(
    database,
    `DELETE FROM face_templates WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE employee_id = ? OR id = ?)`,
    [target, target, target]
  );
  querySync(database, `DELETE FROM users WHERE employee_id = ? OR id = ?`, [target, target]);
  return { success: true, target };
}

/**
 * Fetches all employees for directory view, returning their enrollment status and dates.
 */
export function getAllEmployees() {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT id, name, employee_id, embedding, created_at, updated_at FROM users ORDER BY created_at DESC`
  );
  const rawList = extractRows(result);
  const employees = [];

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item) continue;
    const hasFace = Boolean(item.embedding && item.embedding.length > 10);
    employees.push({
      id: item.id,
      name: item.name,
      employeeId: item.employee_id,
      hasFace,
      enrolledAt: item.created_at,
      updatedAt: item.updated_at || item.created_at,
    });
  }

  return employees;
}

/**
 * Fetch all registered users with valid embeddings for vector matching in FaceMatcher.
 */
export function getAllUsers() {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT id, name, employee_id, embedding FROM users WHERE embedding IS NOT NULL AND embedding != ''`
  );
  const rawList = extractRows(result);
  const users = [];

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || !item.embedding) continue;
    try {
      const parsed = typeof item.embedding === 'string' ? JSON.parse(item.embedding) : item.embedding;
      const embedding = new Float32Array(parsed);

      if (embedding.length > 0 && !isNaN(embedding[0])) {
        users.push({
          id: item.id,
          name: item.name,
          employeeId: item.employee_id,
          embedding: embedding,
        });
      } else {
        console.warn(`[OP-SQLite] User ${item.employee_id} has invalid embedding data`);
      }
    } catch (err) {
      console.warn(`[OP-SQLite] Failed to parse embedding for user ${item.id}:`, err.message);
    }
  }

  return users;
}

/**
 * Check if the employee registered an attendance in the last cooldown window (default 60s).
 */
export function checkRecentCooldown(employeeId, cooldownMs = 60000) {
  const database = getDb();
  const cutoff = Date.now() - cooldownMs;
  const result = querySync(
    database,
    `SELECT timestamp FROM attendance_logs WHERE employee_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 1`,
    [employeeId, cutoff]
  );
  const rows = extractRows(result);

  if (rows && rows.length > 0) {
    const lastTime = rows[0].timestamp;
    const remainingSeconds = Math.ceil((cooldownMs - (Date.now() - lastTime)) / 1000);
    console.log(`[OP-SQLite] Cooldown check for ${employeeId}: ACTIVE (${remainingSeconds}s remaining)`);
    return { inCooldown: true, remainingSeconds };
  }

  return { inCooldown: false, remainingSeconds: 0 };
}

/**
 * Record an attendance event with initial 'PENDING' sync status.
 * Phase 5: Captures type (IN/OUT), similarityScore, margin, device_id, model_id, liveness_passed.
 * Offline-first: stored in SQLite before background cloud sync. Never stores images.
 */
export function logAttendance(user, similarityScore, options = {}) {
  const database = getDb();
  const logId = `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const timestamp = Date.now();
  const type = options.type || 'IN';
  const margin = options.margin != null ? Number(options.margin) : 0.0;
  const deviceId = options.deviceId || 'kiosk_pos_terminal';
  const modelId = options.modelId || 'edgeface_s_g05_fp32_v1';
  const livenessPassed = options.livenessPassed != null ? (options.livenessPassed ? 1 : 0) : 1;

  console.log(
    `[OP-SQLite] Logging attendance for ${user.name} (${user.employeeId}) | Type: ${type} | Score: ${similarityScore.toFixed(3)} | Margin: ${margin.toFixed(3)}`
  );

  querySync(
    database,
    `INSERT INTO attendance_logs (
      id, user_id, employee_id, name, similarity_score, timestamp, sync_status,
      type, margin, device_id, model_id, liveness_passed, synced
    ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, 0)`,
    [
      logId,
      user.id || user.userId,
      user.employeeId,
      user.name,
      similarityScore,
      timestamp,
      type,
      margin,
      deviceId,
      modelId,
      livenessPassed,
    ]
  );

  try {
    querySync(
      database,
      `INSERT INTO attendance_records (id, user_id, employee_id, name, similarity_score, timestamp, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [logId, user.id || user.userId, user.employeeId, user.name, similarityScore, timestamp]
    );
  } catch (recErr) {
    console.warn('[OP-SQLite] attendance_records insert warning:', recErr?.message);
  }

  console.log(`[OP-SQLite] Log record created: ${logId} (Status: PENDING)`);
  return { id: logId, timestamp, syncStatus: 'PENDING', type };
}

/**
 * Gets the most recent punch today for an employee to alternate IN/OUT.
 */
export function getLastPunchToday(employeeId) {
  const database = getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startTimestamp = startOfDay.getTime();
  const result = querySync(
    database,
    `SELECT id, user_id, employee_id, type, timestamp FROM attendance_logs 
     WHERE (employee_id = ? OR user_id = ?) AND timestamp >= ? 
     ORDER BY timestamp DESC LIMIT 1`,
    [String(employeeId), String(employeeId), startTimestamp]
  );
  const rows = extractRows(result);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Fetch all logs pending cloud synchronization.
 */
export function getPendingSyncLogs() {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT id, user_id, employee_id, name, similarity_score, timestamp, type, margin, device_id, model_id, liveness_passed, sync_status
     FROM attendance_logs WHERE sync_status = 'PENDING' OR synced = 0 ORDER BY timestamp ASC LIMIT 50`
  );
  return extractRows(result);
}

/**
 * Mark logs as SYNCED after successful server push.
 */
export function markLogsSynced(ids) {
  if (!ids || ids.length === 0) return;
  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  console.log(`[OP-SQLite] Marking ${ids.length} logs as SYNCED...`);
  querySync(
    database,
    `UPDATE attendance_logs SET sync_status = 'SYNCED', synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
  console.log(`[OP-SQLite] Logs updated to SYNCED.`);
}

/**
 * Get total enrolled users count (with valid biometric embeddings).
 */
export function getUsersCount() {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT COUNT(*) as count FROM users WHERE embedding IS NOT NULL AND embedding != '' AND (deleted IS NULL OR deleted = 0)`
  );
  const rows = extractRows(result);
  return rows && rows.length > 0 ? Number(rows[0].count) : 0;
}

/**
 * Get total attendance logs count.
 */
export function getAttendanceLogsCount() {
  const database = getDb();
  const result = querySync(database, `SELECT COUNT(*) as count FROM attendance_logs`);
  const rows = extractRows(result);
  return rows && rows.length > 0 ? Number(rows[0].count) : 0;
}

/**
 * Phase 3 & Phase 5: Fetches all templates from face_templates joined with employee info for matching.
 * Strict Model Versioning:
 * - Only includes templates matching CURRENT model_id ('edgeface_s_g05_fp32_v1') and pipeline_version ('v1.0').
 * - Filters out soft-deleted templates and users.
 * - Leaves embeddings (whether Base64 ciphertext or JSON string) for native Keystore decryption into RAM.
 */
export function getAllTemplatesForMatching() {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT t.id, t.user_id, t.pose_tag, t.embedding, t.quality_score, u.employee_id, u.name
     FROM face_templates t
     JOIN users u ON t.user_id = u.id
     WHERE t.embedding IS NOT NULL AND t.embedding != ''
       AND (t.deleted IS NULL OR t.deleted = 0)
       AND (u.deleted IS NULL OR u.deleted = 0)
       AND (t.model_id IS NULL OR t.model_id = 'edgeface_s_g05_fp32_v1')
       AND (t.pipeline_version IS NULL OR t.pipeline_version = 'v1.0')`
  );
  const rawList = extractRows(result);
  const templates = [];

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || !item.embedding) continue;
    templates.push({
      id: item.id,
      userId: item.user_id,
      employeeId: item.employee_id,
      name: item.name,
      poseTag: item.pose_tag,
      embedding: item.embedding,
      qualityScore: item.quality_score,
    });
  }

  return templates;
}

/**
 * Phase 5 DPDP: Record biometric consent timestamp
 */
export function saveUserConsent(userId, consentVersion = 'DPDP-2023-v1') {
  const database = getDb();
  const now = Date.now();
  querySync(
    database,
    `UPDATE users SET consent_timestamp = ?, consent_version = ?, updated_at = ?, synced = 0 WHERE id = ?`,
    [now, consentVersion, now, userId]
  );
  return { userId, consentTimestamp: now, consentVersion };
}

/**
 * Phase 5 DPDP: Retrieve biometric consent status
 */
export function getUserConsent(userId) {
  const database = getDb();
  const res = querySync(
    database,
    `SELECT id, name, employee_id, consent_timestamp, consent_version FROM users WHERE id = ?`,
    [userId]
  );
  const rows = extractRows(res);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Phase 5 DPDP: Delete Biometrics Action
 * Soft-deletes templates locally and queues cloud deletion (deleted=1, synced=0).
 * Removes templates from active matching pool.
 */
export function deleteBiometrics(userId) {
  const database = getDb();
  const now = Date.now();
  console.log(`[OP-SQLite] Deleting biometric templates for user ${userId}...`);
  querySync(
    database,
    `UPDATE face_templates SET deleted = 1, synced = 0, updated_at = ? WHERE user_id = ?`,
    [now, userId]
  );
  querySync(
    database,
    `UPDATE users SET embedding = NULL, synced = 0, updated_at = ? WHERE id = ?`,
    [now, userId]
  );
  return { success: true, userId, timestamp: now };
}

/**
 * Phase 5 Cloud Sync: Fetch pending templates for Supabase push
 */
export function getPendingSyncTemplates() {
  const database = getDb();
  const res = querySync(
    database,
    `SELECT id, user_id, pose_tag, embedding, quality_score, luma, blur_variance, yaw, pitch,
            model_id, pipeline_version, quality_json, session_id, created_at, updated_at, deleted
     FROM face_templates WHERE synced = 0 LIMIT 50`
  );
  return extractRows(res);
}

/**
 * Phase 5 Cloud Sync: Mark templates as synced
 */
export function markTemplatesSynced(ids) {
  if (!ids || ids.length === 0) return;
  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  querySync(
    database,
    `UPDATE face_templates SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

/**
 * Phase 5 Cloud Sync: Fetch pending users for Supabase push
 */
export function getPendingSyncUsers() {
  const database = getDb();
  const res = querySync(
    database,
    `SELECT id, name, employee_id, consent_timestamp, consent_version, re_enroll_required, deleted, created_at, updated_at
     FROM users WHERE synced = 0 LIMIT 50`
  );
  return extractRows(res);
}

/**
 * Phase 5 Cloud Sync: Mark users as synced
 */
export function markUsersSynced(ids) {
  if (!ids || ids.length === 0) return;
  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  querySync(
    database,
    `UPDATE users SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

/**
 * Phase 5 Cloud Sync: Upsert remote template with Last-Write-Wins and Model Versioning check
 */
export function upsertRemoteTemplate(remote) {
  const database = getDb();
  const currentModelId = 'edgeface_s_g05_fp32_v1';
  const currentPipelineVer = 'v1.0';

  // Check model versioning
  if (remote.model_id !== currentModelId || remote.pipeline_version !== currentPipelineVer) {
    console.warn(`[OP-SQLite] Remote template ${remote.id} has mismatched model (${remote.model_id}/${remote.pipeline_version}). Flagging user for re-enrollment.`);
    querySync(
      database,
      `UPDATE users SET re_enroll_required = 1 WHERE id = ?`,
      [remote.user_id]
    );
    return { status: 'VERSION_MISMATCH_IGNORED', templateId: remote.id };
  }

  // Check last-write-wins against local updated_at
  const localRes = querySync(
    database,
    `SELECT updated_at FROM face_templates WHERE id = ?`,
    [remote.id]
  );
  const localRows = extractRows(localRes);
  if (localRows.length > 0 && localRows[0].updated_at >= (remote.updated_at || 0)) {
    // Local version is newer or equal
    return { status: 'LOCAL_NEWER', templateId: remote.id };
  }

  querySync(
    database,
    `INSERT INTO face_templates (
      id, user_id, pose_tag, embedding, quality_score, luma, blur_variance, yaw, pitch,
      model_id, pipeline_version, quality_json, session_id, created_at, updated_at, deleted, synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      pose_tag = excluded.pose_tag,
      embedding = excluded.embedding,
      quality_score = excluded.quality_score,
      luma = excluded.luma,
      blur_variance = excluded.blur_variance,
      yaw = excluded.yaw,
      pitch = excluded.pitch,
      model_id = excluded.model_id,
      pipeline_version = excluded.pipeline_version,
      quality_json = excluded.quality_json,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at,
      deleted = excluded.deleted,
      synced = 1`,
    [
      remote.id,
      remote.user_id,
      remote.pose_tag || 'frontal',
      remote.embedding,
      remote.quality_score || 1.0,
      remote.luma,
      remote.blur_variance,
      remote.yaw,
      remote.pitch,
      remote.model_id,
      remote.pipeline_version,
      remote.quality_json,
      remote.session_id,
      remote.created_at || Date.now(),
      remote.updated_at || Date.now(),
      remote.deleted ? 1 : 0,
    ]
  );

  return { status: 'UPSERTED', templateId: remote.id };
}

/**
 * Phase 5 Cloud Sync: Upsert remote user with Last-Write-Wins
 */
export function upsertRemoteUser(remote) {
  const database = getDb();
  const localRes = querySync(
    database,
    `SELECT updated_at FROM users WHERE id = ?`,
    [remote.id]
  );
  const localRows = extractRows(localRes);
  if (localRows.length > 0 && localRows[0].updated_at >= (remote.updated_at || 0)) {
    return { status: 'LOCAL_NEWER', userId: remote.id };
  }

  querySync(
    database,
    `INSERT INTO users (
      id, name, employee_id, created_at, updated_at, consent_timestamp, consent_version,
      re_enroll_required, deleted, synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      employee_id = excluded.employee_id,
      updated_at = excluded.updated_at,
      consent_timestamp = COALESCE(excluded.consent_timestamp, users.consent_timestamp),
      consent_version = COALESCE(excluded.consent_version, users.consent_version),
      re_enroll_required = excluded.re_enroll_required,
      deleted = excluded.deleted,
      synced = 1`,
    [
      remote.id,
      remote.name,
      remote.employee_id,
      remote.created_at || Date.now(),
      remote.updated_at || Date.now(),
      remote.consent_timestamp,
      remote.consent_version,
      remote.re_enroll_required ? 1 : 0,
      remote.deleted ? 1 : 0,
    ]
  );

  return { status: 'UPSERTED', userId: remote.id };
}

/**
 * Fetches all templates for a specific user.
 */
export function getTemplatesForUser(userId) {
  const database = getDb();
  const result = querySync(
    database,
    `SELECT id, user_id, pose_tag, quality_score, luma, blur_variance, yaw, pitch, created_at
     FROM face_templates WHERE user_id = ?`,
    [userId]
  );
  return extractRows(result);
}

/**
 * Permanently deletes all registered users.
 */
export function clearAllUsers() {
  const database = getDb();
  querySync(database, `DELETE FROM face_templates`);
  querySync(database, `DELETE FROM users`);
  console.log('[OP-SQLite] All users and templates deleted.');
}

/**
 * Clean SQLite DB Reset: Purges all corrupted user templates for fresh enrollment.
 */
export function resetCorruptedUsersTable() {
  const database = getDb();
  querySync(database, `DELETE FROM face_templates;`);
  querySync(database, `DELETE FROM users;`);
  console.log('[OP-SQLite] Successfully purged users and face_templates tables. Ready for clean enrollment.');
}

/**
 * Purge all attendance logs.
 */
export function purgeAttendanceLogs() {
  const database = getDb();
  querySync(database, `DELETE FROM attendance_logs`);
  console.log('[OP-SQLite] All attendance logs purged.');
}

/**
 * Synchronous Settings / KV storage helpers.
 */
export function getSettingSync(key) {
  const database = getDb();
  const result = querySync(database, `SELECT value FROM app_settings WHERE key = ?`, [key]);
  const rows = extractRows(result);
  return rows && rows.length > 0 ? rows[0].value : null;
}

export function setSettingSync(key, value) {
  const database = getDb();
  querySync(
    database,
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`,
    [key, String(value)]
  );
}

export function removeSettingSync(key) {
  const database = getDb();
  querySync(database, `DELETE FROM app_settings WHERE key = ?`, [key]);
}

