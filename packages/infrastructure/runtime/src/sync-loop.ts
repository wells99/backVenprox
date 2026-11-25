export function syncLoop(cycle:()=>Promise<void>,pollMs:number,onFailure:()=>void){
  let stopped=false,wake:(()=>void)|undefined,requested=false;
  const done=(async()=>{while(!stopped){requested=false;try{await cycle();}catch{onFailure();}if(stopped)break;if(requested)continue;await new Promise<void>((resolve)=>{const timer=setTimeout(resolve,pollMs);wake=()=>{clearTimeout(timer);resolve();};});wake=undefined;}})();
  return {wake:()=>{requested=true;wake?.();},stop:async()=>{stopped=true;wake?.();await done;}};
}
