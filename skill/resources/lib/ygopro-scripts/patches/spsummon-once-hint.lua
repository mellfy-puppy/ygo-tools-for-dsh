-- added client hint to monsters that special summons once per turn
local function init_spsummon_once(c)
	local e1=Effect.CreateEffect(c)
	e1:SetType(EFFECT_TYPE_SINGLE)
	e1:SetCode(11111111) -- meaningless code
	e1:SetProperty(EFFECT_FLAG_CANNOT_DISABLE+EFFECT_FLAG_UNCOPYABLE+EFFECT_FLAG_SET_AVAILABLE+EFFECT_FLAG_CLIENT_HINT)
	e1:SetDescription(aux.Stringid(47297616,0)) -- 不能特殊召唤

	local e2=Effect.CreateEffect(c)
	e2:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_GRANT)
	e2:SetProperty(EFFECT_FLAG_IGNORE_IMMUNE+EFFECT_FLAG_SET_AVAILABLE+EFFECT_FLAG_IGNORE_RANGE)
	local range=0xff-LOCATION_MZONE
	e2:SetTargetRange(range,range)
	e2:SetTarget(function(e,c)
		return c:IsType(TYPE_MONSTER) and not c:CheckSPSummonOnce(c:GetControler())
	end)
	e2:SetCondition(function(e,tp,eg,ep,ev,re,r,rp)
		return Duel.IsGlobalFlag(GLOBALFLAG_SPSUMMON_ONCE)
	end)
	e2:SetLabelObject(e1)
	Duel.RegisterEffect(e2,0)
end

local spsummononce_initialized=false
local original_SetSPSummonOnce=Card.SetSPSummonOnce
function Card.SetSPSummonOnce(c,...)
	if not spsummononce_initialized then
		spsummononce_initialized=true
		init_spsummon_once(c)
	end
	return original_SetSPSummonOnce(c,...)
end
