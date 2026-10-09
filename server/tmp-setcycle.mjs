const models = await import('./src/models/index.js');
const s = (await import('./src/services/settingService.js'));
await s.setSetting('cycle_minutes', process.argv[2] || '1', null);
console.log('cycle_minutes =', s.getRuntime().cycleMinutes, '| fund_influence_weight =', s.getRuntime().fundInfluenceWeight);
await models.sequelize.close();
