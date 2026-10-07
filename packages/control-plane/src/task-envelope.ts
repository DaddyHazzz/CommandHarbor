export type TaskPrincipalKind = "human" | "worker" | "service";
export type ResourceMode = "shared" | "exclusive";
export type ResourceKind =
  | "device" | "desktop" | "browser_session" | "repository" | "filesystem_path"
  | "process_session" | "application" | "network_destination" | "paid_capability";

export interface TaskPrincipal { kind: TaskPrincipalKind; id: string; }
export interface TaskResourceRequest { kind: ResourceKind; id: string; mode: ResourceMode; }
export interface DestinationBudget { destination: string; maxRequests: number; maxConcurrent: number; }
export interface TaskBudget {
  maxDurationMs: number;
  maxToolCalls: number;
  maxConcurrentOperations: number;
  maxNetworkRequests: number;
  maxSpendMicrousd: number;
  maxHumanApprovals: number;
  destinations: DestinationBudget[];
}
export type ApprovalPolicy =
  | { mode: "none" }
  | { mode: "mutation"; remaining: number }
  | { mode: "always"; remaining: number };
export type SuccessPredicate =
  | { type: "file_exists"; path: string }
  | { type: "file_sha256"; path: string; sha256: string }
  | { type: "process_exit"; sessionId: string; exitCode: number }
  | { type: "git_head"; repository: string; sha: string }
  | { type: "url_equals"; url: string }
  | { type: "capability_result"; capability: string; jsonPointer: string; equals: unknown };

export interface TaskEnvelope {
  schemaVersion: 1;
  taskId: string;
  createdAtMs: number;
  expiresAtMs: number;
  principal: TaskPrincipal;
  originWorkerId: string | null;
  objective: string;
  allowedCapabilities: string[];
  resources: TaskResourceRequest[];
  budget: TaskBudget;
  approval: ApprovalPolicy;
  success: SuccessPredicate[];
}

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE=/^[0-9a-f]{64}$/i;
const GIT_SHA_RE=/^[0-9a-f]{40,64}$/i;
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
function rec(v:unknown,e:string):Record<string,unknown>{if(typeof v!=="object"||v===null||Array.isArray(v))throw new Error(e);return v as Record<string,unknown>;}
function exact(v:Record<string,unknown>,keys:string[],e:string){const a=Object.keys(v).sort(),b=[...keys].sort();if(a.length!==b.length||a.some((x,i)=>x!==b[i]))throw new Error(e);}
function str(v:unknown,min:number,max:number,e:string){if(typeof v!=="string")throw new Error(e);const x=v.trim();if(x.length<min||x.length>max)throw new Error(e);return x;}
function int(v:unknown,min:number,max:number,e:string){if(!Number.isInteger(v)||Number(v)<min||Number(v)>max)throw new Error(e);return Number(v);}
function uniqueStrings(v:unknown,max:number,e:string){if(!Array.isArray(v)||v.length>max)throw new Error(e);const x=v.map(i=>str(i,1,128,e));if(new Set(x).size!==x.length)throw new Error(e);return x;}

function principal(v:unknown):TaskPrincipal{
  const x=rec(v,"invalid_task_principal");exact(x,["kind","id"],"invalid_task_principal");
  if(x.kind!=="human"&&x.kind!=="worker"&&x.kind!=="service")throw new Error("invalid_task_principal");
  const id=str(x.id,1,256,"invalid_task_principal");if(!ID_RE.test(id))throw new Error("invalid_task_principal");
  return {kind:x.kind,id};
}
function resources(v:unknown):TaskResourceRequest[]{
  if(!Array.isArray(v)||v.length>64)throw new Error("invalid_task_resources");
  const kinds:ResourceKind[]=["device","desktop","browser_session","repository","filesystem_path","process_session","application","network_destination","paid_capability"];
  const seen=new Set<string>();
  return v.map(item=>{const x=rec(item,"invalid_task_resource");exact(x,["kind","id","mode"],"invalid_task_resource");
    if(!kinds.includes(x.kind as ResourceKind)||(x.mode!=="shared"&&x.mode!=="exclusive"))throw new Error("invalid_task_resource");
    const id=str(x.id,1,1024,"invalid_task_resource"),key=String(x.kind)+"\0"+id;if(seen.has(key))throw new Error("duplicate_task_resource");seen.add(key);
    return {kind:x.kind as ResourceKind,id,mode:x.mode};});
}
function destinations(v:unknown):DestinationBudget[]{
  if(!Array.isArray(v)||v.length>64)throw new Error("invalid_destination_budgets");const seen=new Set<string>();
  return v.map(item=>{const x=rec(item,"invalid_destination_budget");exact(x,["destination","maxRequests","maxConcurrent"],"invalid_destination_budget");
    const destination=str(x.destination,1,512,"invalid_destination_budget");if(seen.has(destination))throw new Error("duplicate_destination_budget");seen.add(destination);
    return {destination,maxRequests:int(x.maxRequests,0,1_000_000,"invalid_destination_budget"),maxConcurrent:int(x.maxConcurrent,0,10_000,"invalid_destination_budget")};});
}
function budget(v:unknown):TaskBudget{
  const x=rec(v,"invalid_task_budget");exact(x,["maxDurationMs","maxToolCalls","maxConcurrentOperations","maxNetworkRequests","maxSpendMicrousd","maxHumanApprovals","destinations"],"invalid_task_budget");
  return {maxDurationMs:int(x.maxDurationMs,1,86_400_000,"invalid_task_budget"),maxToolCalls:int(x.maxToolCalls,0,100_000,"invalid_task_budget"),
    maxConcurrentOperations:int(x.maxConcurrentOperations,1,1_000,"invalid_task_budget"),maxNetworkRequests:int(x.maxNetworkRequests,0,1_000_000,"invalid_task_budget"),
    maxSpendMicrousd:int(x.maxSpendMicrousd,0,1_000_000_000_000,"invalid_task_budget"),maxHumanApprovals:int(x.maxHumanApprovals,0,1_000,"invalid_task_budget"),
    destinations:destinations(x.destinations)};
}
function approval(v:unknown):ApprovalPolicy{
  const x=rec(v,"invalid_approval_policy");
  if(x.mode==="none"){exact(x,["mode"],"invalid_approval_policy");return {mode:"none"};}
  if(x.mode==="mutation"||x.mode==="always"){exact(x,["mode","remaining"],"invalid_approval_policy");return {mode:x.mode,remaining:int(x.remaining,0,1_000,"invalid_approval_policy")};}
  throw new Error("invalid_approval_policy");
}
function success(v:unknown):SuccessPredicate[]{
  if(!Array.isArray(v)||v.length>32)throw new Error("invalid_success_predicates");
  return v.map(item=>{const x=rec(item,"invalid_success_predicate");
    if(x.type==="file_exists"){exact(x,["type","path"],"invalid_success_predicate");return {type:"file_exists",path:str(x.path,1,4096,"invalid_success_predicate")};}
    if(x.type==="file_sha256"){exact(x,["type","path","sha256"],"invalid_success_predicate");const sha256=str(x.sha256,64,64,"invalid_success_predicate");if(!SHA256_RE.test(sha256))throw new Error("invalid_success_predicate");return {type:"file_sha256",path:str(x.path,1,4096,"invalid_success_predicate"),sha256};}
    if(x.type==="process_exit"){exact(x,["type","sessionId","exitCode"],"invalid_success_predicate");return {type:"process_exit",sessionId:str(x.sessionId,1,256,"invalid_success_predicate"),exitCode:int(x.exitCode,-2147483648,2147483647,"invalid_success_predicate")};}
    if(x.type==="git_head"){exact(x,["type","repository","sha"],"invalid_success_predicate");const sha=str(x.sha,40,64,"invalid_success_predicate");if(!GIT_SHA_RE.test(sha))throw new Error("invalid_success_predicate");return {type:"git_head",repository:str(x.repository,1,1024,"invalid_success_predicate"),sha};}
    if(x.type==="url_equals"){exact(x,["type","url"],"invalid_success_predicate");const url=str(x.url,1,2048,"invalid_success_predicate");try{new URL(url);}catch{throw new Error("invalid_success_predicate");}return {type:"url_equals",url};}
    if(x.type==="capability_result"){exact(x,["type","capability","jsonPointer","equals"],"invalid_success_predicate");return {type:"capability_result",capability:str(x.capability,1,128,"invalid_success_predicate"),jsonPointer:str(x.jsonPointer,0,2048,"invalid_success_predicate"),equals:x.equals};}
    throw new Error("invalid_success_predicate");});
}

export function parseTaskEnvelope(value:unknown,nowMs:number=Date.now()):TaskEnvelope{
  const x=rec(value,"invalid_task_envelope");exact(x,["schemaVersion","taskId","createdAtMs","expiresAtMs","principal","originWorkerId","objective","allowedCapabilities","resources","budget","approval","success"],"invalid_task_envelope");
  if(x.schemaVersion!==1)throw new Error("unsupported_task_envelope_version");
  const taskId=str(x.taskId,36,36,"invalid_task_id");if(!UUID_RE.test(taskId))throw new Error("invalid_task_id");
  const createdAtMs=int(x.createdAtMs,0,Number.MAX_SAFE_INTEGER,"invalid_task_time"),expiresAtMs=int(x.expiresAtMs,0,Number.MAX_SAFE_INTEGER,"invalid_task_time");
  if(expiresAtMs<=createdAtMs||expiresAtMs<=nowMs)throw new Error("expired_task_envelope");if(expiresAtMs-createdAtMs>86_400_000)throw new Error("task_envelope_ttl_too_large");
  const originWorkerId=x.originWorkerId===null?null:str(x.originWorkerId,1,256,"invalid_origin_worker");if(originWorkerId!==null&&!ID_RE.test(originWorkerId))throw new Error("invalid_origin_worker");
  return {schemaVersion:1,taskId,createdAtMs,expiresAtMs,principal:principal(x.principal),originWorkerId,objective:str(x.objective,1,4096,"invalid_task_objective"),
    allowedCapabilities:uniqueStrings(x.allowedCapabilities,128,"invalid_allowed_capabilities"),resources:resources(x.resources),budget:budget(x.budget),approval:approval(x.approval),success:success(x.success)};
}
export function taskAllowsCapability(task:TaskEnvelope,capability:string){return task.allowedCapabilities.includes(capability);}
export function remainingTaskDurationMs(task:TaskEnvelope,nowMs:number=Date.now()){return Math.max(0,task.expiresAtMs-nowMs);}
