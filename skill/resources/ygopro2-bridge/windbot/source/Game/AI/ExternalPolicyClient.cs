using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;
using YGOSharp.OCGWrapper.Enums;

namespace WindBot.Game.AI
{
    public sealed class ExternalPolicyClient : IDisposable
    {
        private readonly Duel _duel;
        private readonly string _episodeId;
        private readonly TcpClient _client;
        private readonly StreamReader _reader;
        private readonly StreamWriter _writer;
        private readonly JavaScriptSerializer _json;
        private int _step;
        private bool _terminalSent;

        public ExternalPolicyClient(Duel duel)
        {
            _duel = duel;
            _episodeId = Config.GetString("EpisodeId", Guid.NewGuid().ToString("N"));
            string host = Config.GetString("AgentHost", "127.0.0.1");
            int port = Config.GetInt("AgentPort", 23991);
            int timeout = Config.GetInt("AgentTimeoutMs", 30000);
            _client = new TcpClient { ReceiveTimeout = timeout, SendTimeout = timeout, NoDelay = true };
            _client.Connect(host, port);
            NetworkStream stream = _client.GetStream();
            _reader = new StreamReader(stream, new UTF8Encoding(false), false, 65536, true);
            _writer = new StreamWriter(stream, new UTF8Encoding(false), 65536, true) { AutoFlush = true };
            _json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        }

        public byte[] Decide(GameMessage message, byte[] body, int selectHint, out bool surrender)
        {
            byte[] payload = new byte[body.Length + 1];
            payload[0] = (byte)message;
            Buffer.BlockCopy(body, 0, payload, 1, body.Length);
            PolicyRequest request = new PolicyRequest
            {
                type = "decision",
                episodeId = _episodeId,
                step = _step++,
                message = message.ToString(),
                messageBase64 = Convert.ToBase64String(payload),
                selectHint = selectHint,
                state = CaptureState(),
            };
            _writer.WriteLine(_json.Serialize(request));
            string line = _reader.ReadLine();
            if (line == null) throw new IOException("External policy closed before returning a response.");
            PolicyResponse response = _json.Deserialize<PolicyResponse>(line);
            surrender = response != null && response.surrender;
            if (surrender) return new byte[0];
            if (response == null || String.IsNullOrEmpty(response.responseBase64))
                throw new InvalidDataException("External policy returned no responseBase64.");
            return Convert.FromBase64String(response.responseBase64);
        }

        public void NotifyTerminal(int result)
        {
            NotifyTerminal(result == 0 ? "win" : result == 2 ? "draw" : "loss");
        }

        public void NotifyCutoff()
        {
            NotifyTerminal("cutoff");
        }

        private void NotifyTerminal(string result)
        {
            if (_terminalSent) return;
            _terminalSent = true;
            _writer.WriteLine(_json.Serialize(new PolicyRequest
            {
                type = "terminal",
                episodeId = _episodeId,
                step = _step,
                result = result,
                state = CaptureState(),
            }));
        }

        private PolicyState CaptureState()
        {
            return new PolicyState
            {
                p0 = CapturePlayer(_duel.Fields[0]),
                p1 = CapturePlayer(_duel.Fields[1]),
                lp = new PolicyLifePoints { p0 = _duel.Fields[0].LifePoints, p1 = _duel.Fields[1].LifePoints },
                turn = _duel.Turn,
                turnPlayer = _duel.Player,
                phase = (int)_duel.Phase,
            };
        }

        private static PolicyPlayer CapturePlayer(ClientField field)
        {
            return new PolicyPlayer
            {
                hand = CardIds(field.Hand), deck = CardIds(field.Deck), extra = CardIds(field.ExtraDeck),
                mzone = CardIds(field.MonsterZone), szone = CardIds(field.SpellZone),
                grave = CardIds(field.Graveyard), banished = CardIds(field.Banished),
            };
        }

        private static int[] CardIds(IEnumerable<ClientCard> cards)
        {
            return cards == null ? new int[0] : cards.Where(card => card != null).Select(card => card.Id).ToArray();
        }

        public void Dispose()
        {
            try { _writer.Dispose(); } catch { }
            try { _reader.Dispose(); } catch { }
            try { _client.Close(); } catch { }
        }

        private sealed class PolicyRequest
        {
            public string type { get; set; }
            public string episodeId { get; set; }
            public int step { get; set; }
            public string message { get; set; }
            public string messageBase64 { get; set; }
            public int selectHint { get; set; }
            public string result { get; set; }
            public PolicyState state { get; set; }
        }

        private sealed class PolicyResponse
        {
            public string responseBase64 { get; set; }
            public bool surrender { get; set; }
        }
        private sealed class PolicyState
        {
            public PolicyPlayer p0 { get; set; }
            public PolicyPlayer p1 { get; set; }
            public PolicyLifePoints lp { get; set; }
            public int turn { get; set; }
            public int turnPlayer { get; set; }
            public int phase { get; set; }
        }
        private sealed class PolicyLifePoints { public int p0 { get; set; } public int p1 { get; set; } }
        private sealed class PolicyPlayer
        {
            public int[] hand { get; set; }
            public int[] deck { get; set; }
            public int[] extra { get; set; }
            public int[] mzone { get; set; }
            public int[] szone { get; set; }
            public int[] grave { get; set; }
            public int[] banished { get; set; }
        }
    }
}
