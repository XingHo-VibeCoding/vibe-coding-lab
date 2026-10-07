/* ============================================================
   云函数：/api/health —— Day 15 第 3 周的第一个公网接口
   ============================================================
   作用：回答"这个服务活着吗"。一次请求确认三件事：
     1. 服务在线（请求本身能到达并返回）
     2. 部署的是哪个版本（version 字段，和 package.json 同步）
     3. 返回是不是现算的（time 字段每次调用都不同 —— 证明不是缓存的旧响应）

   为什么第一个接口是它而不是"取笔记"：
   以后 Day 16-20 每接一个真接口，出问题时先打一下 health，
   就能分清"是我这个接口坏了"还是"整个服务挂了"——
   体检基准要先立起来，其他的病才有的查。

   调用方式：HTTP 访问服务（云接入）把函数映射到
   https://<环境ID>.service.tcloudbase.com/api/health
   ============================================================ */

const pkg = require('./package.json');

// CloudBase 云函数的标准入口。
// event   = 触发信息（HTTP 访问时含请求参数、headers 等，health 用不上）
// context = 运行环境信息（含所在环境标识，取出来放进返回值，方便核对
//           "我现在访问的到底是哪个环境" —— 公网上地址长得都差不多，认错环境是常事）
exports.main = async (event, context) => {
  return {
    ok: true,
    service: 'notelab',
    version: pkg.version,
    time: new Date().toISOString(),
    env: (context && (context.namespace || context.envId))
      || process.env.TCB_ENV
      || process.env.SCF_NAMESPACE
      || 'unknown'
  };
};
