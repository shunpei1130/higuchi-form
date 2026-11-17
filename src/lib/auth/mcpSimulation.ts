/** Preserve plugin identity, endpoints, schema and inferred APIs; only suppress its startup seed. */
export function isolateMcpResourceSeeds<T extends {options:{resources?:unknown[]}}>(plugin:T,mode:string|undefined,allowLegacySeeds=true):T{
  // oauth-provider.init closes over this same options object. No resource inputs
  // means it returns before making adapter calls; all live policy is unchanged.
  if(mode==="simulation"||!allowLegacySeeds)plugin.options.resources=[];
  return plugin;
}
