function load_patch(name)
	local path = "patches/" .. name .. ".lua"
	Duel.LoadScript(path)
end

load_patch("multiple-preloaduds")
load_patch("spsummon-once-hint")
