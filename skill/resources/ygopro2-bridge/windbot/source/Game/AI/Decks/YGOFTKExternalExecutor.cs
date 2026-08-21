using WindBot.Game;

namespace WindBot.Game.AI.Decks
{
    [Deck("YGOFTKExternal", "AI_YGOFTK", "Test")]
    public class YGOFTKExternalExecutor : DefaultExecutor
    {
        public YGOFTKExternalExecutor(GameAI ai, Duel duel) : base(ai, duel)
        {
        }
    }
}
