--時空鎖
local s,id,o=GetID()
function s.initial_effect(c)
	--Activate
	local e1=Effect.CreateEffect(c)
	e1:SetDescription(aux.Stringid(id,0))
	e1:SetCategory(CATEGORY_REMOVE)
	e1:SetType(EFFECT_TYPE_ACTIVATE)
	e1:SetCode(EVENT_BE_BATTLE_TARGET)
	e1:SetCondition(s.condition)
	e1:SetTarget(s.target)
	e1:SetOperation(s.activate)
	c:RegisterEffect(e1)
	--disable
	local e2=Effect.CreateEffect(c)
	e2:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
	e2:SetCode(EVENT_CHAIN_SOLVING)
	e2:SetRange(LOCATION_SZONE)
	e2:SetCondition(s.discon)
	e2:SetOperation(s.disop)
	c:RegisterEffect(e2)
	--search
	local e3=Effect.CreateEffect(c)
	e3:SetDescription(aux.Stringid(id,2))
	e3:SetCategory(CATEGORY_TOHAND+CATEGORY_SEARCH)
	e3:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_TRIGGER_O)
	e3:SetCode(EVENT_PREDRAW)
	e3:SetCountLimit(1)
	e3:SetRange(LOCATION_SZONE)
	e3:SetCondition(s.thcon)
	e3:SetCost(s.thcost)
	e3:SetTarget(s.thtg)
	e3:SetOperation(s.thop)
	c:RegisterEffect(e3)
end
function s.condition(e,tp,eg,ep,ev,re,r,rp)
	local tc=eg:GetFirst()
	return tc and tc:IsControler(tp)
end
function s.target(e,tp,eg,ep,ev,re,r,rp,chk)
	local a=Duel.GetAttacker()
	local d=a:GetBattleTarget()
	if chk==0 then return Duel.IsPlayerCanRemove(tp) and Duel.IsPlayerCanRemove(tp,a) and Duel.IsPlayerCanRemove(tp,d) end
	e:SetLabelObject(d)
	local c=e:GetHandler()
	c:SetTurnCounter(0)
	--destroy
	local e1=Effect.CreateEffect(c)
	e1:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
	e1:SetProperty(EFFECT_FLAG_CANNOT_DISABLE)
	e1:SetCode(EVENT_PHASE+PHASE_STANDBY)
	e1:SetCountLimit(1)
	e1:SetRange(LOCATION_SZONE)
	e1:SetCondition(s.descon)
	e1:SetOperation(s.desop)
	e1:SetReset(RESET_EVENT+RESETS_STANDARD+RESET_PHASE+PHASE_STANDBY+RESET_OPPO_TURN,2)
	c:RegisterEffect(e1)
end
function s.descon(e,tp,eg,ep,ev,re,r,rp)
	return tp~=Duel.GetTurnPlayer()
end
function s.desop(e,tp,eg,ep,ev,re,r,rp)
	local c=e:GetHandler()
	local ct=c:GetTurnCounter()
	ct=ct+1
	c:SetTurnCounter(ct)
	if ct==2 then
		Duel.Destroy(c,REASON_RULE)
	end
end
function s.activate(e,tp,eg,ep,ev,re,r,rp)
	local c=e:GetHandler()
	local a=Duel.GetAttacker()
	if not a then return end
	local d=Duel.GetAttackTarget()
	local g=Group.CreateGroup()
	if a:IsRelateToBattle() then g:AddCard(a) end
	if d and d:IsRelateToBattle() then g:AddCard(d) end
	if g:GetCount()==0 then return end
	g:KeepAlive()
	local ac=a:GetAttackAnnouncedCount()
	local afid=a:GetRealFieldID()
	local dfid=d and d:GetRealFieldID() or 0
	local e1=Effect.CreateEffect(c)
	e1:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
	e1:SetCode(EVENT_DAMAGE_STEP_END)
	e1:SetLabel(c:GetFieldID(),ac,afid,dfid)
	e1:SetLabelObject(g)
	e1:SetOperation(s.rmop)
	e1:SetReset(RESET_PHASE+PHASE_DAMAGE)
	Duel.RegisterEffect(e1,tp)
	for tc in aux.Next(g) do
		local e2=Effect.CreateEffect(c)
		e2:SetType(EFFECT_TYPE_SINGLE)
		e2:SetCode(EFFECT_INDESTRUCTABLE_BATTLE)
		e2:SetLabel(ac,afid,dfid)
		e2:SetValue(s.indes)
		e2:SetReset(RESET_EVENT+RESETS_STANDARD+RESET_PHASE+PHASE_DAMAGE)
		tc:RegisterEffect(e2)
	end
end
function s.indes(e,c)
	local ac,afid,dfid=e:GetLabel()
	local a=Duel.GetAttacker()
	local d=Duel.GetAttackTarget()
	if not a or a:GetAttackAnnouncedCount()~=ac or a:GetRealFieldID()~=afid then return false end
	if dfid~=0 then
		if not d or d:GetRealFieldID()~=dfid then return false end
	elseif d then
		return false
	end
	local tc=e:GetHandler()
	return tc==a or tc==d
end
function s.samebattler(c,g,fid)
	if not c or not g:IsContains(c) then return false end
	if c:IsOnField() then return c:GetRealFieldID()==fid end
	return true
end
function s.rmop(e,tp,eg,ep,ev,re,r,rp)
	local g=e:GetLabelObject()
	if not g then return end
	local fid,ac,afid,dfid=e:GetLabel()
	local a=Duel.GetAttacker()
	local d=Duel.GetAttackTarget()
	local attacker_same=s.samebattler(a,g,afid) and (not a:IsOnField() or a:GetAttackAnnouncedCount()==ac)
	local defender_same=(dfid==0 and not d) or (dfid~=0 and s.samebattler(d,g,dfid))
	if attacker_same and defender_same then
		for rc in aux.Next(g) do
			if (rc==a or rc==d) and rc:IsOnField() and rc:IsRelateToBattle()
				and Duel.Remove(rc,0,REASON_EFFECT+REASON_TEMPORARY)~=0
				and rc:IsLocation(LOCATION_REMOVED) then
				rc:RegisterFlagEffect(id,RESET_EVENT+RESETS_STANDARD+RESET_PHASE+PHASE_END,EFFECT_FLAG_CLIENT_HINT,5,fid,aux.Stringid(id,4))
				local rep=rc:GetPreviousControler()
				local e1=Effect.CreateEffect(e:GetHandler())
				e1:SetDescription(aux.Stringid(id,3))
				e1:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
				e1:SetCode(EVENT_PHASE+PHASE_STANDBY)
				e1:SetLabelObject(rc)
				e1:SetCountLimit(1)
				e1:SetCondition(s.retcon)
				e1:SetOperation(s.retop)
				if Duel.GetTurnPlayer()==rep then
					e1:SetReset(RESET_PHASE+PHASE_STANDBY+RESET_SELF_TURN,3)
					e1:SetLabel(Duel.GetTurnCount()+4,fid)
				else
					e1:SetReset(RESET_PHASE+PHASE_STANDBY+RESET_SELF_TURN,2)
					e1:SetLabel(Duel.GetTurnCount()+3,fid)
				end
				Duel.RegisterEffect(e1,rep)
			end
		end
	end
	g:DeleteGroup()
	e:SetLabelObject(nil)
end
function s.retcon(e,tp,eg,ep,ev,re,r,rp)
	local dt,fid=e:GetLabel()
	if Duel.GetTurnPlayer()~=tp or Duel.GetTurnCount()~=dt then return false end
	return e:GetLabelObject():GetFlagEffectLabel(id)==fid
end
function s.retop(e,tp,eg,ep,ev,re,r,rp)
	local tc=e:GetLabelObject()
	Duel.ReturnToField(tc)
	tc:ResetFlagEffect(id)
end
function s.cfilter(c,rc,fid)
	local code1,code2=rc:GetOriginalCodeRule()
	return c:IsFaceup() and c:IsOriginalCodeRule(code1,code2)
		and c:GetFlagEffectLabel(id)==fid
end
function s.discon(e,tp,eg,ep,ev,re,r,rp)
	local rc=re:GetHandler()
	return rc and re:IsActiveType(TYPE_MONSTER)
		and Duel.IsExistingMatchingCard(s.cfilter,tp,LOCATION_REMOVED,LOCATION_REMOVED,1,nil,rc,e:GetHandler():GetFieldID())
end
function s.disop(e,tp,eg,ep,ev,re,r,rp)
	Duel.NegateEffect(ev)
end
function s.thcon(e,tp,eg,ep,ev,re,r,rp)
	return tp==Duel.GetTurnPlayer()
end
function s.thcost(e,tp,eg,ep,ev,re,r,rp,chk)
	if chk==0 then return aux.IsPlayerCanNormalDraw(tp) end
	aux.GiveUpNormalDraw(e,tp,EFFECT_FLAG_OATH)
end
function s.thfilter(c)
	return c:IsType(TYPE_MONSTER) and c:IsAbleToHand()
end
function s.thtg(e,tp,eg,ep,ev,re,r,rp,chk)
	if chk==0 then return Duel.IsExistingMatchingCard(s.thfilter,tp,LOCATION_DECK,0,1,nil) end
	Duel.SetOperationInfo(0,CATEGORY_TOHAND,nil,1,tp,LOCATION_DECK)
end
function s.thop(e,tp,eg,ep,ev,re,r,rp)
	Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_ATOHAND)
	local g=Duel.SelectMatchingCard(tp,s.thfilter,tp,LOCATION_DECK,0,1,1,nil)
	if g:GetCount()>0 then
		Duel.SendtoHand(g,nil,REASON_EFFECT)
		Duel.ConfirmCards(1-tp,g)
	end
end
