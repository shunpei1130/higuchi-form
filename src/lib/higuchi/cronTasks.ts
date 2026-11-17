type WorkResult={processed:number;failed:number};
type CleanupResult={runs:number;sessions:number};
export type HiguchiCronTasks={jobs:()=>Promise<WorkResult>;preview:()=>Promise<WorkResult>;retention:()=>Promise<CleanupResult>};
/** Start independently and await all: provider work must not be abandoned after a sibling failure. */
export async function runHiguchiCronTasks(tasks:HiguchiCronTasks){
  const names=["jobs","preview","retention"] as const;
  const results=await Promise.allSettled([Promise.resolve().then(tasks.jobs),Promise.resolve().then(tasks.preview),Promise.resolve().then(tasks.retention)] as const);
  const failedTasks=names.filter((_,i)=>results[i].status==="rejected");
  const jobs=results[0].status==="fulfilled"?results[0].value:null;
  const preview=results[1].status==="fulfilled"?results[1].value:null;
  const retention=results[2].status==="fulfilled"?results[2].value:null;
  return {processed:jobs?.processed??0,failed:jobs?.failed??0,preview,retention,failedTasks};
}
