const radix=1n<<128n;
export function idCursor(id:string):string {return BigInt(`0x${id.replaceAll('-','')}`).toString();}
export function cursorId(cursor:string):string|undefined {
  if(!/^(0|[1-9][0-9]{0,127})$/.test(cursor))return undefined;
  const value=BigInt(cursor);if(value>=radix)return undefined;
  const hex=value.toString(16).padStart(32,'0');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function movementCursor(at:string,id:string):string{return(BigInt(Date.parse(at))*radix+BigInt(idCursor(id))).toString();}
export function parseMovementCursor(cursor:string):{at:string;id:string}|undefined {
  if(!/^(0|[1-9][0-9]{0,127})$/.test(cursor))return undefined;
  const value=BigInt(cursor),millis=value/radix;if(millis>8640000000000000n)return undefined;
  const id=cursorId((value%radix).toString());return id?{at:new Date(Number(millis)).toISOString(),id}:undefined;
}
