import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const source=resolve(process.env.ADMIN_DB_PATH ?? resolve(root,'data/admin.sqlite'));
if (!process.argv[2]) throw new Error('请指定新的备份文件路径：npm run admin:backup -- /安全目录/admin-backup.sqlite');
const target=resolve(process.argv[2]);
if (target===source || existsSync(target)) throw new Error('备份目标已存在，请使用新的文件名');
if (!existsSync(source)) throw new Error('后台数据库不存在，请检查 ADMIN_DB_PATH');
mkdirSync(dirname(target),{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try { await backup(db,target); chmodSync(target,0o600); console.log(`数据库备份完成：${target}`); }
finally { db.close(); }
