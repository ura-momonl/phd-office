import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const [name, action = 'status', argument] = process.argv.slice(2);
if (!name || name === 'help') {
  const topic = process.argv[3];
  if (config.topics[topic]) {
    console.log(config.topics[topic]);
  } else if (config.modules[topic]) {
    console.log(`${topic}: ${config.modules[topic].actions.join(', ')}`);
    console.log(config.modules[topic].usage ?? '');
    console.log('带 <JSON文件路径> 的参数是一个 JSON 文件的路径：先把内容写成文件，再把路径传进去。');
  } else {
    console.log('工作自动化：普通程序运行；AI 判断按需在当前会话完成。');
    console.log('入口：node automation/run.mjs <模块> <动作> [参数]；某个模块的参数格式：node automation/run.mjs help <模块>；格式说明：help handoff、card、review');
    for (const [id, module] of Object.entries(config.modules)) console.log(`${id}: ${module.actions.join(', ')}`);
  }
} else {
  const module = config.modules[name];
  if (!module || !module.actions.includes(action)) throw new Error('未知模块/动作；使用 help 查看已安装功能');
  const { run } = await import(new URL(module.entry, import.meta.url));
  if (typeof run !== 'function') throw new Error('模块须导出 run(action, argument)');
  await run(action, argument);
}
