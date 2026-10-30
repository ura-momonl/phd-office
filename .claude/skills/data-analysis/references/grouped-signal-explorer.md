# 分组信号查看器

适用于有多组测量、一个可比较条件变量及多个复数/成对分量通道的信号；不是任意表格分析器。输入是预处理器已准备的数据和当前数据族的本地适配器，查看器不决定相位参考、极性、拟合模型、处理窗口或跨组匹配规则。

生成一个可离线打开、含完整输入数据的 HTML：

```powershell
node .agents/skills/data-analysis/scripts/build-explorer.mjs prepared.json.gz adapter.js output.html
```

`prepared.json` 和 gzip 压缩的同一 JSON 均可。适配器是你信任的本地 JavaScript，会嵌入并在导出的页面里运行；测量数据作为压缩数据嵌入，不作为代码。不要把输出路径指向输入文件。浏览器需支持 `DecompressionStream('gzip')`，已实测本机 Edge；无需外网和服务器。

## 数据接口

```json
{
  "channels": ["sensor-x"],
  "default_channel": "sensor-x",
  "methods": [{"id": "chosen-method", "label": "本次处理", "description": "当前数据实际采用的处理定义"}],
  "preprocessing": "适配器/脚本、参数、单位与校准来源",
  "display_note": "这批数据的必要说明",
  "groups": [{
    "id": "g1", "source": "run-01.txt", "path": "完整来源路径", "sha256": "来源哈希",
    "config": "同一接法或配置", "condition": 1.0,
    "cols": ["drive", "read-x", "read-y"], "rows": [[1, 2, 3], [1, 2.1, 3.1]],
    "steps": [{"current": 1, "start": 0, "end": 1, "values": {"sensor-x": {"chosen-method": [2.05, 3.05]}}}]
  }]
}
```

- `rows` 保留逐行原始值；`cols` 是当前数据的实际列名。`source/path/sha256` 和说明供人回查来源；已知单位写在列名与 `preprocessing` 中。
- `condition` 是这组数据的可比较数值条件，不指定它必须是温度。`config` 划分接法或测量配置。
- `methods` 的名称、数量和定义由当前预处理器给；`steps` 是已经计算的数据段结果。`current` 是该段驱动值，`start/end` 为原始行号，`values[channel][method]` 前两项是处理后的两个分量，可另附离散度。不能产生某个处理结果时不伪造数值，可以省略该项；原始行仍在，页面显示当前处理结果覆盖的段数。仅查看逐点数据时，`steps` 可以为空。

## 适配器接口

```javascript
window.signalAdapter = {
  rows(group, channel, data) {
    // 根据 data 与 group.cols 做当前数据族的列映射/校准。
    return group.rows.map((row, i) => ({
      i, current: row[0], amplitude: Math.hypot(row[1], row[2]),
      phase: Math.atan2(row[2], row[1]) * 180 / Math.PI,
      rawx: row[1], rawy: row[2], x: row[1], y: row[2],
      delta: Math.atan2(row[2], row[1]) * 180 / Math.PI
    }));
  },
  details(group, channel, method, data) {
    // 可选：由当前分析提供跨组比较与说明，不由查看器补匹配规则。
    return {
      conditionRows: [{condition: 1, x: 2, y: 3}],
      conditionLabel: "条件及单位",
      conditionNote: "实际比较了哪些组、匹配条件与依据",
      finding: "从当前数据实际算出的信息及其含义"
    };
  }
};
```

没有 `details` 或没有 `conditionRows` 时不显示条件比较面，没有 `finding` 就不显示自动结论。不要为填展示区域而补出默认物理判断。页面可切换采集次序、驱动响应和复平面，条件比较仅在适配器提供时出现；切换组、通道和处理版本复用同一数据层。显示抽稀保留桶内 XY 极值和原始顺序，并标明绘图/源点数；完整数据仍在输出中，抽稀只影响绘图。
