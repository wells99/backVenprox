export function businessDate(instant:string,timeZone:string):string|undefined {
  if(timeZone!=='UTC'&&!/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(timeZone))return undefined;
  try{const parts=new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));
    const get=(type:string)=>parts.find((part)=>part.type===type)?.value;return `${get('year')}-${get('month')}-${get('day')}`;
  }catch{return undefined;}
}
