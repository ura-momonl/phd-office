# Rescript 本地音频＋字幕剪辑

安装入口：`D:\Zoom-recordings\Rescript\Rescript.exe`，v1.2.4。
官方：https://github.com/wassgha/rescript/releases/tag/v1.2.4
许可为 PolyForm Noncommercial；非商业个人用途，不是无条件商业授权。

## 使用已有转录，不再转录

1. 打开 Rescript，点右上角 `Whisper Base` 下拉菜单。
2. 选 **导入转录文本 → SRT / VTT / JSON**，选择录音同名 `.srt`。
3. 确认下拉入口显示所选字幕文件，再拖入配套 `.flac` 音频。不要选择 Whisper/Parakeet 重新转录，不需下载模型或 API。
4. 用转录文字定位；结合播放和下方波形调整剪切边界。现有 SRT 只有句子级时间，文字的细分边界不是逐词实测，须回听。
5. 导出新音频和同一编辑状态的字幕，另存新文件，不覆盖原录音或原字幕。保留片段前后语境和对应原文件时间范围。

## 保存与空间

- 原始录音和自动转录仍在 `D:\Zoom-recordings\YYYY-MM-DD\`，旧测试文件留在根目录。
- 剪辑导出位置由保存对话框选择，例如原日期目录下新建 `clips`。
- 官方提供 WAV/M4A/MP3 音频导出，不保证直接导出 FLAC。WAV 可能比原 FLAC 更大；M4A/MP3 是有损，不能等同未改动的原始录音。
- 保存片段不会自动节省原文件占用空间。
- 录音、转录程序和已有模型已集中到 `D:\Zoom-recordings\quiet-recorder\`；模型在其中的 `models` 子目录。Rescript 用户设置仍由 Windows 存在 AppData。

## 隐私与已知状态

- 「帮助改进应用」（匿名使用统计和崩溃报告）已在设置中关闭，偏好文件 `AppData\Roaming\rescript\telemetry.json` 为 `{"enabled":false}`。软件仍可能检查更新，不保证零网络；未调用付费 API。安装包无 Authenticode 签名（SHA256 与官方发布资产一致）。
- **文字／波形关联剪辑及音频／字幕导出尚未验证**：自动化文件选择接口导入 SRT 后未显示转录，正常文件选择是否可用待人工用同名短音频与 SRT 确认；无效时先停止，不改安装包内部实现、不删除原件。
