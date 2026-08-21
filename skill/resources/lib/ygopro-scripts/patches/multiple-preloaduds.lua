AuxiliaryMetatable = {}
setmetatable(Auxiliary, AuxiliaryMetatable)

local PRELOAD_KEY = "PreloadUds"
local preload_uds = {}

local function already_added(f)
  for i = 1, #preload_uds do
    if preload_uds[i] == f then return true end
  end
  return false
end

local function run_preload_uds(...)
  local snapshot = {}
  for i = 1, #preload_uds do snapshot[i] = preload_uds[i] end

  for _, ud in ipairs(snapshot) do
    ud(...)
  end
end

function AuxiliaryMetatable.__index(t, k)
  if k == PRELOAD_KEY then
    return run_preload_uds
  end
  return nil
end

function AuxiliaryMetatable.__newindex(t, k, v)
  if k == PRELOAD_KEY then
    if v == nil then
      preload_uds = {}
      return
    end
    assert(type(v) == "function", "PreloadUds must be a function")
    if not already_added(v) then
      preload_uds[#preload_uds+1] = v
    end
    return
  end
  rawset(t, k, v)
end
