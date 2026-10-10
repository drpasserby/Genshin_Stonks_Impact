import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { User, Stock } from '../models/index.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { roundPrice } from '../utils/money.js';
import { initDb } from '../scripts/initDb.js';
import { ensureSetting, SETTING_KEYS } from '../services/settingService.js';

/** 种子：建库 + 演示账号 + 初始角色股票 + 默认系统设置（幂等） */
async function seed() {
  await initDb();

  // ---- 账号 ----
  const seedAccounts = [
    { username: config.seed.rootUser, password: config.seed.rootPass, role: 'root', nickname: '超级管理员' },
    { username: config.seed.adminUser, password: config.seed.adminPass, role: 'admin', nickname: '天权管理员' },
    { username: config.seed.operatorUser, password: config.seed.operatorPass, role: 'operator', nickname: '凯瑟琳操作员' },
    { username: config.seed.userUser, password: config.seed.userPass, role: 'user', nickname: '旅行者' },
  ];
  for (const a of seedAccounts) {
    const [u, created] = await User.findOrCreate({
      where: { username: a.username },
      defaults: {
        username: a.username,
        passwordHash: await bcrypt.hash(a.password, 10),
        nickname: a.nickname,
        role: a.role,
      },
    });
    if (created) logger.info(`账号已创建: ${a.username} (${a.role})`);
    else if (u.role !== a.role) {
      u.role = a.role; // 修正历史角色
      await u.save();
      logger.info(`账号角色已修正: ${a.username} -> ${a.role}`);
    } else {
      logger.info(`账号已存在: ${a.username} (${u.role})`);
    }
  }

  // ---- 系统开关默认值（root 控制面板可改，存数据库）----
  // 需求：默认禁用自助注册（仅管理员可开通）；交易默认开放。
  // 使用 ensureSetting 幂等写入：重复部署/重跑 seed 不会覆盖管理员已修改的开关。
  const reg = await ensureSetting(
    SETTING_KEYS.allowRegistration, '0',
    '是否允许新用户自助注册（关闭后仅管理员可创建账号）'
  );
  const trd = await ensureSetting(
    SETTING_KEYS.tradingEnabled, '1',
    '是否允许交易（下单/撤单/撮合；关闭 = 全站暂停交易）'
  );
  logger.info(
    `系统开关: allow_registration=${reg.row.value}${reg.created ? '(新建)' : '(已存在,保留)'} ` +
    `trading_enabled=${trd.row.value}${trd.created ? '(新建)' : '(已存在,保留)'}`
  );

  // ---- 角色股票（提瓦特人气角色）----
  const stocks = [
    { code: 'TY0001', name: '钟离', price: 680.5, totalShares: 10000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_Zhongli.png' },
    { code: 'TY0002', name: '雷电将军', price: 990.25, totalShares: 8000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_RaidenShogun.png' },
    { code: 'TY0003', name: '胡桃', price: 520.8, totalShares: 6000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_Hutao.png' },
    { code: 'TY0004', name: '甘雨', price: 760.0, totalShares: 7000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_Ganyu.png' },
    { code: 'TY0005', name: '温迪', price: 430.15, totalShares: 9000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_Venti.png' },
    { code: 'TY0006', name: '纳西妲', price: 310.0, totalShares: 5000000, avatarUrl: 'https://upload-bbs.mihoyo.com/game_record/genshin/character_image_upload/UI_AvatarIcon_Nahida.png' },
  ];
  for (const s of stocks) {
    const exists = await Stock.findOne({ where: { code: s.code } });
    if (exists) { logger.info(`股票已存在: ${s.code} ${s.name}`); continue; }
    const p = roundPrice(s.price);
    await Stock.create({
      code: s.code, name: s.name, avatarUrl: s.avatarUrl,
      price: p, prevClose: p, open: p, high: p, low: p, volume: 0,
      totalShares: s.totalShares,
    });
    logger.info(`股票已创建: ${s.code} ${s.name} @${p}`);
  }
}

async function main() {
  await seed();
  logger.info(
    `种子数据初始化完成。默认账号: root/${config.seed.rootPass} admin/${config.seed.adminPass} ` +
    `operator/${config.seed.operatorPass} demo/${config.seed.userPass}（生产环境请修改 .env）`
  );
}

// 仅直接运行 `node src/seed/seed.js` 时执行，import 时不触发
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { logger.error('种子失败: ' + (err.stack || err.message)); process.exit(1); });
}
