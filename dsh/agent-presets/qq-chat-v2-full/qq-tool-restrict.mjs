// re-export 壳：qq-tool-restrict 的权威实现只有一份，在
// plugins/qq-agent-presets/qq-tool-restrict.mjs（bundle 内，preset 行按包名引用）。
//
// DSH 0.1.7 起 ~/.dsh/.agent-presets/<preset>/ 不再被读取，这个路径本身也不再是
// 「装进 DSH 的东西」；保留它只是为了让仓库里按老路径 import/读文件的脚本
// （test-audit-setup-guards.mjs 等）继续工作，并且明确指向唯一实现。
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict.mjs'
