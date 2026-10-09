--竜の骸歌
local s,id,o=GetID()
function s.initial_effect(c)
	--Activate
	local e1=Effect.CreateEffect(c)
	e1:SetDescription(aux.Stringid(id,0))
	e1:SetCategory(CATEGORY_SPECIAL_SUMMON+CATEGORY_TODECK+CATEGORY_GRAVE_ACTION)
	e1:SetType(EFFECT_TYPE_ACTIVATE)
	e1:SetCode(EVENT_FREE_CHAIN)
	e1:SetCountLimit(1,id)
	e1:SetTarget(s.target)
	e1:SetOperation(s.activate)
	c:RegisterEffect(e1)
	--to hand
	local e2=Effect.CreateEffect(c)
	e2:SetDescription(aux.Stringid(id,1))
	e2:SetCategory(CATEGORY_TOHAND)
	e2:SetType(EFFECT_TYPE_IGNITION)
	e2:SetRange(LOCATION_GRAVE)
	e2:SetCountLimit(1,id+o)
	e2:SetCost(s.thcost)
	e2:SetTarget(s.thtg)
	e2:SetOperation(s.thop)
	c:RegisterEffect(e2)
end
function s.mfilter(c)
	return c:GetLevel()>0 and c:IsRace(RACE_INSECT+RACE_DRAGON) and c:IsAbleToDeck()
end
function s.rfilter(c,e,tp,mg)
	if not c:IsRace(RACE_INSECT) or not c:IsType(TYPE_RITUAL)
		or not c:IsCanBeSpecialSummoned(e,SUMMON_TYPE_RITUAL,tp,false,true) then return false end
	local mg2=mg:Clone()
	if c.mat_filter then
		mg2=mg:Filter(c.mat_filter,nil,tp)
	end
	return mg2:CheckWithSumGreater(Card.GetRitualLevel,c:GetLevel(),c)
end
function s.target(e,tp,eg,ep,ev,re,r,rp,chk)
	if chk==0 then
		local mg=Duel.GetMatchingGroup(s.mfilter,tp,LOCATION_GRAVE,LOCATION_GRAVE,nil)
		return Duel.IsExistingMatchingCard(s.rfilter,tp,LOCATION_HAND,0,1,nil,e,tp,mg)
	end
	Duel.SetOperationInfo(0,CATEGORY_SPECIAL_SUMMON,nil,1,tp,LOCATION_HAND)
	Duel.SetOperationInfo(0,CATEGORY_TODECK,nil,0,tp,LOCATION_GRAVE)
end
function s.gcheck(g,mg)
	local res=false
	local lv=g:GetSum(Card.GetLevel)
	for tc in aux.Next(g) do
		if mg:CheckWithSumGreater(Card.GetRitualLevel,lv,tc) then
			return true
		end
	end
	return false
end
function s.rsgcheck(g,sg)
	local res=false
	local lv=sg:GetSum(Card.GetLevel)
	for tc in aux.Next(sg) do
		Duel.SetSelectedCard(g)
		if g:CheckWithSumGreater(Card.GetRitualLevel,lv,tc) then
			return true
		end
	end
	return false
end
function s.activate(e,tp,eg,ep,ev,re,r,rp)
	::cancel::
	local ft=Duel.GetLocationCount(tp,LOCATION_MZONE)
	if Duel.IsPlayerAffectedByEffect(tp,59822133) then ft=1 end
	if ft==0 then return end
	local mg=Duel.GetMatchingGroup(aux.NecroValleyFilter(s.mfilter),tp,LOCATION_GRAVE,LOCATION_GRAVE,nil)
	local tg=Duel.GetMatchingGroup(s.rfilter,tp,LOCATION_HAND,0,nil,e,tp,mg)
	if tg:GetCount()==0 then return end
	Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_SPSUMMON)
	local sg=tg:SelectSubGroup(tp,s.gcheck,false,1,ft,mg)
	if sg:GetCount()>0 then
		for tc in aux.Next(sg) do
			if tc.mat_filter then
				mg=mg:Filter(tc.mat_filter,tc,tp)
			else
				mg:RemoveCard(tc)
			end
		end
		Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_TODECK)
		local mat=mg:SelectSubGroup(tp,s.rsgcheck,true,1,99,sg)
		if not mat then goto cancel end
		for tc in aux.Next(sg) do
			tc:SetMaterial(mat)
		end
		Duel.HintSelection(mat)
		Duel.SendtoDeck(mat,nil,SEQ_DECKSHUFFLE,REASON_EFFECT+REASON_MATERIAL+REASON_RITUAL)
		Duel.BreakEffect()
		Duel.SpecialSummon(sg,SUMMON_TYPE_RITUAL,tp,tp,false,true,POS_FACEUP)
		for tc in aux.Next(sg) do
			tc:CompleteProcedure()
		end
	end
end
function s.cfilter(c)
	return c:IsFaceupEx() and c:IsRace(RACE_INSECT) and c:IsAbleToGraveAsCost()
end
function s.thcost(e,tp,eg,ep,ev,re,r,rp,chk)
	if chk==0 then return Duel.IsExistingMatchingCard(s.cfilter,tp,LOCATION_HAND+LOCATION_MZONE,0,1,nil) end
	Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_TOGRAVE)
	local g=Duel.SelectMatchingCard(tp,s.cfilter,tp,LOCATION_HAND+LOCATION_MZONE,0,1,1,nil)
	Duel.SendtoGrave(g,REASON_COST)
end
function s.thtg(e,tp,eg,ep,ev,re,r,rp,chk)
	if chk==0 then return e:GetHandler():IsAbleToHand() end
	Duel.SetOperationInfo(0,CATEGORY_TOHAND,e:GetHandler(),1,0,0)
end
function s.thop(e,tp,eg,ep,ev,re,r,rp)
	local c=e:GetHandler()
	if c:IsRelateToChain() and aux.NecroValleyFilter()(c) then
		Duel.SendtoHand(e:GetHandler(),nil,REASON_EFFECT)
	end
end
