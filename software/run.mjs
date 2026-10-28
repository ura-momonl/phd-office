import fs from 'node:fs';
import { read, input } from '../automation/files.mjs';
export async function run(action, argument) {
  const apps = read('software/catalog.json').apps;
  const detail = a => ({...a, executable_present:a.executable ? fs.existsSync(a.executable) : null});
  if (action === 'list') {
    if (argument && argument !== 'full') throw new Error('software list [full]；单项详情用 software show <id>');
    if (argument === 'full') console.log(JSON.stringify(apps.map(detail), null, 2));
    else console.log(apps.map(a => {
      const present = detail(a).executable_present;
      return `${a.id} (${a.name}) | operator=${a.operator} | cwd=${a.working_directory} | connector=${a.connector || '脚本/CLI/UI，见 show'} | requires_running=${a.requires_running ?? '按路线'} | executable=${present === null ? '未登记' : present ? '存在' : '缺失'} | verification=${a.verification?.result || '未验证'} | verified_at=${a.verified_at || '未验证'}`;
    }).join('\n'));
  }
  else if (action === 'show') {
    const app = apps.find(a => a.id === argument);
    if (!app) throw new Error('Unknown software id；software list 查看已登记软件');
    console.log(JSON.stringify(detail(app), null, 2));
  }
  else if (action === 'plan') {
    const request = input(argument); const app = apps.find(a=>a.id === request.app);
    if (!app || !request.goal) throw new Error('Known app and task goal required');
    console.log(JSON.stringify({app,goal:request.goal,inputs:request.inputs||[],outputs:request.outputs||[],
      steps:['查看相关项目与输入','连接活动软件或指定脚本','按明确目标执行','核对实际结果并保存交付和来源'],
      executed:false, note:'这是可复用的软件工作计划；当前不会启动软件、关闭现有文档或操作仪器。'}, null, 2));
  } else throw new Error('software: list [full], show <id>, plan <request.json>');
}
