// Upgrade-only cleanup for the retired seven-day automatic-login feature.
// Keep ordinary sessions, account passwords and business data unchanged. There is
// deliberately no API here to issue, find or rotate a persistent login token.
export function retireRememberedLogins(database) {
  const hasLegacyDevices = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_remember_devices'").get();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM admin_sessions WHERE remember_device_id IS NOT NULL').run();
    if (hasLegacyDevices) database.exec('DELETE FROM admin_remember_devices');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
