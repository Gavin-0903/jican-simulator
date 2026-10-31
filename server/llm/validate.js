// 轻量 JSON Schema 子集校验（type / required / properties / min/maxLength / minimum / maximum / enum）。

const typeOk = (type, v) => {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    default: return true;
  }
};

export function validate(schema, value, path = '$') {
  const errors = [];
  if (schema.type && !typeOk(schema.type, value)) return [`${path} 应为 ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} 不在枚举范围内`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} 过短`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} 过长`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} 小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} 大于 ${schema.maximum}`);
  }
  if (schema.type === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k} 缺失`);
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) errors.push(...validate(sub, value[k], `${path}.${k}`));
    }
  }
  return errors;
}

/** 从模型输出中提取第一个 JSON 对象（容忍前后多余文字或代码块）。 */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith('{')) return s;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}
