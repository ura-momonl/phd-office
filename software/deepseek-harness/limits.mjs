// deepseek-flash / deepseek-v4-pro 官方单次输出上限为 384K（api-docs.deepseek.com 模型细节，2026-10 核对）。
// 办公室默认用 64K：一次回复里「推理 + 一次大 JSON／大文件写入」放得下；按实际生成 token 计费，不按上限计费。
// 2026-10-23 文献试跑 701a83c1 用 8192，正好卡在写选文 JSON 的那一步，整轮被判 max-tokens 失败。
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 64000;
