/** 统一响应体：{ code: 0, message: 'ok', data: ... } */
export function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, message, data });
}

export function created(res, data = null, message = '创建成功') {
  res.status(201).json({ code: 0, message, data });
}

/** 处理 Sequelize 实例序列化：避免返回巨大对象时循环引用 */
export function plain(instance) {
  if (instance == null) return null;
  if (Array.isArray(instance)) return instance.map((i) => (i && i.toJSON ? i.toJSON() : i));
  return instance.toJSON ? instance.toJSON() : instance;
}
