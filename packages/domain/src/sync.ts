// Canonicalização Venprox v1: JSON sem coerção/NFC, chaves UTF-16 ordenadas,
// arrays preservados, apenas inteiros seguros; sequências grandes são strings.
export function canonicalJson(value:unknown):string {
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))throw new Error('NON_CANONICAL_NUMBER');return String(value);}
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  throw new Error('NON_CANONICAL_VALUE');
}
export const validSequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
