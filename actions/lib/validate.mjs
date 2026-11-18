// Minimal JSON Schema subset validator: type, enum, required, properties,
// additionalProperties:false, items, maxItems, maxLength. Enough for SCAFFOLD
// output schemas without a dependency; swap for ajv once there is a build step.
export function validate(schema, value, path = '$') {
  const errors = [];
  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected object`];
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    value.forEach((v, i) => errors.push(...validate(schema.items ?? {}, v, `${path}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of ${schema.enum.join(', ')}`);
  return errors;
}

// OpenAI strict structured outputs reject keywords like maxLength/maxItems;
// strip them for the request and enforce them locally with validate().
export function toStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['$schema', 'title', 'maxLength', 'maxItems'].includes(k)) continue;
    out[k] = toStrictSchema(v);
  }
  return out;
}
