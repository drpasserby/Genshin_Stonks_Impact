/**
 * 建一个本地专用的测试超级管理员（不动任何现有账号）
 * 用法：在 server/ 目录下 node tmp-mkroot.mjs
 * 账号：roletest_root / Test123456
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { sequelize, User } from './src/models/index.js';

const USERNAME = 'roletest_root';
const PASSWORD = 'Test123456';

const passwordHash = await bcrypt.hash(PASSWORD, 10);
const [row, created] = await User.findOrCreate({
  where: { username: USERNAME },
  defaults: {
    username: USERNAME,
    passwordHash,
    nickname: '权限测试超管',
    role: 'root',
    mora: 10000000,
  },
});
if (!created) {
  row.passwordHash = passwordHash;
  row.role = 'root';
  row.status = 1;
  await row.save();
}
console.log(`${created ? '已创建' : '已重置'} ${USERNAME}（id=${row.id}, role=${row.role}）密码 ${PASSWORD}`);
await sequelize.close();
