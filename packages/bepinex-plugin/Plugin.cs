using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BazaarGameClient.Infra.SocketClient;
using BazaarGameShared.Domain.Core.Types;
using BazaarGameShared.Infra.Messages;
using BazaarGameShared.Infra.Messages.GameSimEvents;
using HarmonyLib;
using UnityEngine;
using TheBazaar;
using GameCard = BazaarGameClient.Domain.Models.Cards.Card;

namespace BazaarInfoPlugin
{
    [BepInPlugin("com.bazaarinfo.plugin", "BazaarInfo", "1.0.0")]
    public class Plugin : BaseUnityPlugin
    {
        internal static ManualLogSource Log;
        internal static ConfigEntry<string> EbsUrl;
        internal static ConfigEntry<string> ChannelId;
        internal static ConfigEntry<string> Secret;

        internal static Dictionary<string, CardInfo> PlayerBoard = new Dictionary<string, CardInfo>();
        internal static Dictionary<string, CardInfo> OpponentBoard = new Dictionary<string, CardInfo>();
        internal static List<ShopCardInfo> ShopCards = new List<ShopCardInfo>();
        internal static Dictionary<string, Guid> InstanceToTemplate = new Dictionary<string, Guid>();
        internal static Dictionary<string, ECardSize> InstanceToSize = new Dictionary<string, ECardSize>();
        internal static Dictionary<string, string> TemplateNames = new Dictionary<string, string>();
        internal static readonly object BoardLock = new object();

        // Item sockets (10 per side)
        internal static SocketLayout[] PlayerSockets;
        internal static SocketLayout[] OpponentSockets;
        internal static float CachedSocketW;
        internal static float CachedSocketH;

        // Skill sockets (up to 6 per side)
        internal static SocketLayout[] PlayerSkillSockets;
        internal static SocketLayout[] OpponentSkillSockets;
        internal static float SkillSocketW;
        internal static float SkillSocketH;
        internal static int CachedSkillSocketCount = 0;

        internal static bool LayoutReady = false;
        internal static volatile bool NeedsBroadcast = false;
        internal static volatile bool ShowOverlay = false;

        private Harmony _harmony;

        void Awake()
        {
            Log = Logger;

            EbsUrl = Config.Bind("EBS", "Url", "https://ebs.bazaarinfo.com",
                "EBS endpoint URL");
            ChannelId = Config.Bind("EBS", "ChannelId", "",
                "Twitch channel ID");
            Secret = Config.Bind("EBS", "Secret", "",
                "Companion secret for EBS auth");

            LoadCardDb();

            _harmony = new Harmony("com.bazaarinfo.plugin");
            _harmony.PatchAll();

            Log.LogInfo($"BazaarInfo loaded — {TemplateNames.Count} cards in DB");
        }

        void Update()
        {
            if (!LayoutReady)
                CacheSocketPositions();

            if (NeedsBroadcast && LayoutReady)
            {
                NeedsBroadcast = false;
                ReadSkillsFromBoard();
                DoSendBoard();
            }
        }

        void OnDestroy()
        {
            _harmony?.UnpatchSelf();
        }

        void CacheSocketPositions()
        {
            var boardMgr = UnityEngine.Object.FindObjectOfType<BoardManager>();
            if (boardMgr == null) return;
            var cam = Camera.main;
            if (cam == null) return;

            // Item sockets
            var pSockets = boardMgr.playerItemSockets;
            var oSockets = boardMgr.opponentItemSockets;
            if (pSockets == null || pSockets.Length == 0) return;
            var col = pSockets[0]?.GetComponent<BoxCollider>();
            if (col == null) return;

            PlayerSockets = CacheSocketArray(pSockets, cam);
            OpponentSockets = CacheSocketArray(oSockets, cam);

            var bmin = cam.WorldToViewportPoint(col.bounds.min);
            var bmax = cam.WorldToViewportPoint(col.bounds.max);
            CachedSocketH = Math.Abs(bmax.y - bmin.y);

            // Derive socket width from actual spacing (collider bounds don't match visual width)
            if (PlayerSockets.Length > 1)
                CachedSocketW = (PlayerSockets[PlayerSockets.Length - 1].x - PlayerSockets[0].x) / (PlayerSockets.Length - 1);
            else
                CachedSocketW = Math.Abs(bmax.x - bmin.x);

            // Skill sockets — index by SocketNumber, not array index
            var pSkills = boardMgr.playerSkillSockets;
            var oSkills = boardMgr.opponentSkillSockets;
            if (pSkills != null && pSkills.Length > 0)
            {
                PlayerSkillSockets = CacheSkillSockets(pSkills, cam);
                OpponentSkillSockets = CacheSkillSockets(oSkills, cam);

                var skillCollider = pSkills[0]?.GetComponent<Collider>();
                if (skillCollider != null)
                {
                    var smin = cam.WorldToViewportPoint(skillCollider.bounds.min);
                    var smax = cam.WorldToViewportPoint(skillCollider.bounds.max);
                    SkillSocketW = Math.Abs(smax.x - smin.x);
                    SkillSocketH = Math.Abs(smax.y - smin.y);
                }

                if (SkillSocketW < 0.001f || SkillSocketH < 0.001f)
                {
                    SkillSocketW = CachedSocketW;
                    SkillSocketH = CachedSocketW;
                }

                CachedSkillSocketCount = pSkills.Length;

                for (int si = 0; si < PlayerSkillSockets.Length; si++)
                    Log.LogInfo($"Skill socket p[{si}]=({PlayerSkillSockets[si].x:F4},{PlayerSkillSockets[si].y:F4})");
                Log.LogInfo($"Skill sockets cached: {CachedSkillSocketCount}");
                Log.LogInfo($"Skill size: w={SkillSocketW:F4} h={SkillSocketH:F4}");

            }

            LayoutReady = true;

            Log.LogInfo($"Item sockets: w={CachedSocketW:F4} h={CachedSocketH:F4} " +
                $"player_y={PlayerSockets[0].y:F4} opponent_y={OpponentSockets[0].y:F4}");
        }

        void ReadSkillsFromBoard()
        {
            // no-op: skills use socket positions with fill-order mapping
        }

        // Hardcoded visual positions for 6 skill slots (viewport coords from THIS.png)
        // Collider positions are unreliable — these are the actual visual centers
        // Layout: 3 left of hero, 3 right of hero
        //   pos0 = outer left top,  pos1 = outer left bottom, pos2 = inner left
        //   pos3 = inner right,     pos4 = outer right bottom, pos5 = outer right top
        static readonly float[,] SkillVisualPos = {
            { 0.3413f, 0.8211f },  // pos 0 (user's #1)
            { 0.3794f, 0.8867f },  // pos 1 (user's #2)
            { 0.4182f, 0.8229f },  // pos 2 (user's #3)
            { 0.5839f, 0.8251f },  // pos 3 (user's #4)
            { 0.6183f, 0.8847f },  // pos 4 (user's #5)
            { 0.6572f, 0.8209f },  // pos 5 (user's #6)
        };

        // 6-skill grid layout (12 slots: 2 rows of 3 per side)
        // From THISQ.png annotation
        static readonly float[,] SkillGridPos = {
            { 0.3358f, 0.8130f },  // grid 0: top-left 1
            { 0.3800f, 0.8140f },  // grid 1: top-left 2
            { 0.4245f, 0.8142f },  // grid 2: top-left 3
            { 0.5743f, 0.8133f },  // grid 3: top-right 1
            { 0.6187f, 0.8130f },  // grid 4: top-right 2
            { 0.6624f, 0.8128f },  // grid 5: top-right 3
            { 0.3362f, 0.8888f },  // grid 6: bot-left 1
            { 0.3804f, 0.8898f },  // grid 7: bot-left 2
            { 0.4243f, 0.8913f },  // grid 8: bot-left 3
            { 0.5720f, 0.8880f },  // grid 9: bot-right 1
            { 0.6162f, 0.8894f },  // grid 10: bot-right 2
            { 0.6607f, 0.8878f },  // grid 11: bot-right 3
        };

        internal static int NextPlayerSkillSocket = 0;
        internal static int NextOpponentSkillSocket = 0;

        static SocketLayout[] CacheSocketArray(Component[] sockets, Camera cam)
        {
            var layout = new SocketLayout[sockets.Length];
            for (int i = 0; i < sockets.Length; i++)
            {
                if (sockets[i] == null) continue;
                var vp = cam.WorldToViewportPoint(sockets[i].transform.position);
                layout[i] = new SocketLayout { x = vp.x, y = 1f - vp.y };
            }
            return layout;
        }

        static SocketLayout[] CacheSkillSockets(SkillSocketController[] sockets, Camera cam)
        {
            // Find max socket number to size the array
            int maxIdx = 0;
            for (int i = 0; i < sockets.Length; i++)
            {
                if (sockets[i] == null) continue;
                int n = (int)sockets[i].SocketNumber;
                if (n > maxIdx) maxIdx = n;
            }
            var layout = new SocketLayout[maxIdx + 1];
            for (int i = 0; i < sockets.Length; i++)
            {
                if (sockets[i] == null) continue;
                int idx = (int)sockets[i].SocketNumber;
                if (idx < 0 || idx >= layout.Length) continue;
                var vp = cam.WorldToViewportPoint(sockets[i].transform.position);
                layout[idx] = new SocketLayout { x = vp.x, y = 1f - vp.y };
                Log.LogInfo($"  SkillSocket arr[{i}] SocketNumber={sockets[i].SocketNumber}({idx}) pos=({layout[idx].x:F4},{layout[idx].y:F4})");
            }
            return layout;
        }

        internal static void RequestBroadcast()
        {
            NeedsBroadcast = true;
        }

        void DoSendBoard()
        {
            if (string.IsNullOrEmpty(ChannelId.Value) || string.IsNullOrEmpty(Secret.Value))
                return;

            List<CardPayload> cards = new List<CardPayload>();
            List<ShopCardInfo> shop = new List<ShopCardInfo>();
            lock (BoardLock)
            {
                if (ShowOverlay)
                {
                    int pSkip = 0, oSkip = 0;
                    foreach (var kvp in PlayerBoard)
                    {
                        var payload = MakePayload(kvp.Value, "player");
                        if (payload != null) cards.Add(payload);
                        else pSkip++;
                    }

                    foreach (var kvp in OpponentBoard)
                    {
                        var payload = MakePayload(kvp.Value, "opponent");
                        if (payload != null) cards.Add(payload);
                        else oSkip++;
                    }
                    if (pSkip > 0 || oSkip > 0)
                        Log.LogInfo($"MakePayload skipped: p={pSkip} o={oSkip}");

                    shop = new List<ShopCardInfo>(ShopCards);
                }
            }

            var p = cards;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string json = SimpleJson(p);
                    string shopJson = ShopJson(shop);
                    string body = "{\"channelId\":\"" + ChannelId.Value +
                        "\",\"secret\":\"" + Secret.Value +
                        "\",\"cards\":" + json +
                        ",\"shop\":" + shopJson + "}";

                    var req = (HttpWebRequest)WebRequest.Create(EbsUrl.Value + "/detect");
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Timeout = 5000;
                    byte[] data = Encoding.UTF8.GetBytes(body);
                    req.ContentLength = data.Length;
                    using (var stream = req.GetRequestStream())
                        stream.Write(data, 0, data.Length);
                    using (var res = (HttpWebResponse)req.GetResponse())
                        Log.LogInfo($"Broadcast {p.Count} cards (p:{PlayerBoard.Count} o:{OpponentBoard.Count}) -> {(int)res.StatusCode}");
                }
                catch (Exception ex)
                {
                    Log.LogWarning($"Send failed: {ex.Message}");
                }
            });
        }

        static CardPayload MakePayload(CardInfo info, string owner)
        {
            bool isSkill = info.CardType == "Skill";

            if (isSkill)
            {
                int socketNum = info.Socket;
                float vx, vy;

                // Count player skills to detect layout mode
                int totalSkills = 0;
                lock (BoardLock)
                {
                    foreach (var kvp in (owner == "player" ? PlayerBoard : OpponentBoard))
                        if (kvp.Value.CardType == "Skill") totalSkills++;
                }

                if (totalSkills >= 6)
                {
                    // Grid layout (12 slots) — socket N maps to grid position N
                    int gridIdx = socketNum;
                    if (gridIdx < 0 || gridIdx >= SkillGridPos.GetLength(0)) return null;
                    vx = SkillGridPos[gridIdx, 0];
                    vy = (owner == "player") ? SkillGridPos[gridIdx, 1] : (1f - SkillGridPos[gridIdx, 1]);
                }
                else
                {
                    // Triangle layout (up to 5 skills) — socket N maps to position N
                    if (socketNum < 0 || socketNum >= SkillVisualPos.GetLength(0)) return null;
                    vx = SkillVisualPos[socketNum, 0];
                    vy = (owner == "player") ? SkillVisualPos[socketNum, 1] : (1f - SkillVisualPos[socketNum, 1]);
                }

                float sw = SkillSocketW;
                float sh = SkillSocketH;
                // Grid skills are smaller
                if (totalSkills >= 6) { sw *= 0.7f; sh *= 0.7f; }
                return new CardPayload
                {
                    title = info.Title,
                    tier = info.Tier,
                    x = vx - sw / 2f,
                    y = vy - sh / 2f,
                    w = sw,
                    h = sh,
                    owner = owner,
                    cardType = info.CardType,
                    enchantment = info.Enchantment,
                    attrs = info.Attributes
                };
            }

            var sockets = owner == "player" ? PlayerSockets : OpponentSockets;
            float socketW = CachedSocketW;
            float socketH = CachedSocketH;

            if (sockets == null || info.Socket < 0 || info.Socket >= sockets.Length)
                return null;

            var sl = sockets[info.Socket];
            int size = (int)info.Size;
            int endSocket = Math.Min(info.Socket + size - 1, sockets.Length - 1);
            float w = (endSocket > info.Socket)
                ? sockets[endSocket].x - sl.x + socketW
                : socketW;
            float h = socketH;

            return new CardPayload
            {
                title = info.Title,
                tier = info.Tier,
                x = sl.x - socketW / 2f,
                y = sl.y - h / 2f,
                w = w,
                h = h,
                owner = owner,
                cardType = info.CardType,
                enchantment = info.Enchantment,
                attrs = info.Attributes
            };
        }

        void LoadCardDb()
        {
            var path = Path.Combine(Application.streamingAssetsPath, "cards.json");
            if (!File.Exists(path))
            {
                Log.LogWarning($"cards.json not found: {path}");
                return;
            }

            var text = File.ReadAllText(path);
            int i = 0;
            while (i < text.Length)
            {
                int idIdx = text.IndexOf("\"Id\":", i);
                if (idIdx < 0) break;

                string id = ExtractStringValue(text, idIdx);
                if (id == null) { i = idIdx + 5; continue; }

                int searchEnd = Math.Min(idIdx + 2000, text.Length);
                int titleIdx = text.IndexOf("\"Title\":", idIdx);
                string title = null;
                if (titleIdx >= 0 && titleIdx < searchEnd)
                {
                    int textIdx = text.IndexOf("\"Text\":", titleIdx);
                    if (textIdx >= 0 && textIdx < searchEnd)
                        title = ExtractStringValue(text, textIdx);
                }

                if (title == null)
                {
                    int nameIdx = text.IndexOf("\"InternalName\":", idIdx);
                    if (nameIdx >= 0 && nameIdx < searchEnd)
                        title = ExtractStringValue(text, nameIdx);
                }

                if (title != null)
                    TemplateNames[id.ToLowerInvariant()] = title;

                i = idIdx + 5;
            }
        }

        static string ExtractStringValue(string text, int keyIdx)
        {
            int colon = text.IndexOf(':', keyIdx);
            if (colon < 0) return null;
            int quote1 = text.IndexOf('"', colon + 1);
            if (quote1 < 0 || quote1 > colon + 10) return null;
            int quote2 = text.IndexOf('"', quote1 + 1);
            if (quote2 < 0) return null;
            return text.Substring(quote1 + 1, quote2 - quote1 - 1);
        }

        internal static string ResolveName(string instanceId, Guid templateId)
        {
            var key = templateId.ToString().ToLowerInvariant();
            if (TemplateNames.TryGetValue(key, out var name))
                return name;
            return instanceId;
        }

        static string JsonEscape(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        static string SimpleJson(List<CardPayload> cards)
        {
            var ic = System.Globalization.CultureInfo.InvariantCulture;
            var sb = new StringBuilder("[");
            for (int i = 0; i < cards.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var c = cards[i];
                sb.Append("{\"title\":\"").Append(JsonEscape(c.title))
                  .Append("\",\"tier\":\"").Append(c.tier)
                  .Append("\",\"owner\":\"").Append(c.owner)
                  .Append("\",\"type\":\"").Append(JsonEscape(c.cardType))
                  .Append("\",\"x\":").Append(c.x.ToString("F4", ic))
                  .Append(",\"y\":").Append(c.y.ToString("F4", ic))
                  .Append(",\"w\":").Append(c.w.ToString("F4", ic))
                  .Append(",\"h\":").Append(c.h.ToString("F4", ic));

                if (c.enchantment != null)
                    sb.Append(",\"enchantment\":\"").Append(c.enchantment).Append("\"");

                if (c.attrs != null && c.attrs.Count > 0)
                {
                    sb.Append(",\"attrs\":{");
                    bool first = true;
                    foreach (var attr in c.attrs)
                    {
                        if (!first) sb.Append(",");
                        sb.Append("\"").Append(attr.Key).Append("\":").Append(attr.Value);
                        first = false;
                    }
                    sb.Append("}");
                }

                sb.Append("}");
            }
            sb.Append("]");
            return sb.ToString();
        }

        static string ShopJson(List<ShopCardInfo> shop)
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < shop.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var s = shop[i];
                sb.Append("{\"title\":\"").Append(JsonEscape(s.Title))
                  .Append("\",\"type\":\"").Append(s.CardType)
                  .Append("\",\"tier\":\"").Append(s.Tier)
                  .Append("\",\"size\":\"").Append(s.Size)
                  .Append("\"}");
            }
            sb.Append("]");
            return sb.ToString();
        }
    }

    internal struct SocketLayout
    {
        public float x;
        public float y;
    }

    internal class CardPayload
    {
        public string title;
        public string tier;
        public string owner;
        public string cardType;
        public string enchantment;
        public Dictionary<string, int> attrs;
        public float x, y, w, h;
    }

    internal class CardInfo
    {
        public string Title;
        public string Tier;
        public int Socket;
        public ECardSize Size;
        public string CardType;
        public string Enchantment;
        public Dictionary<string, int> Attributes = new Dictionary<string, int>();
        public float ScreenX = -1f;
        public float ScreenY = -1f;
    }

    internal class ShopCardInfo
    {
        public string Title;
        public string CardType;
        public string Tier;
        public string Size;
    }

    [HarmonyPatch(typeof(SocketClient), "ProcessMessage")]
    static class ProcessMessagePatch
    {
        // States where the overlay should be HIDDEN
        static readonly HashSet<BazaarGameShared.Domain.Runs.ERunState> HiddenStates = new HashSet<BazaarGameShared.Domain.Runs.ERunState>
        {
            BazaarGameShared.Domain.Runs.ERunState.NewRun,
            BazaarGameShared.Domain.Runs.ERunState.EndRunDefeat,
            BazaarGameShared.Domain.Runs.ERunState.EndRunVictory,
            BazaarGameShared.Domain.Runs.ERunState.Shutdown,
        };

        static void Postfix(INetMessage message)
        {
            try
            {
                Plugin.Log.LogInfo($"MSG: {message.GetType().Name}");
                if (message is NetMessageGameStateSync sync)
                    HandleStateSync(sync);
                else if (message is NetMessageGameSim sim)
                    HandleGameSim(sim);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"Patch error: {ex}");
            }
        }

        static CardInfo CardFromSnapshot(CardSnapshotDTO card)
        {
            var info = new CardInfo
            {
                Title = Plugin.ResolveName(card.InstanceId, card.TemplateId),
                Tier = card.Tier.ToString(),
                Socket = (int)card.Socket.Value,
                Size = card.Size,
                CardType = card.Type.ToString(),
                Enchantment = card.Enchantment?.ToString()
            };

            if (card.Attributes != null)
            {
                foreach (var attr in card.Attributes)
                    info.Attributes[attr.Key.ToString()] = attr.Value;
            }

            return info;
        }

        static void HandleStateSync(NetMessageGameStateSync sync)
        {
            int skipped = 0;
            int playerSkillIdx = 0;
            int opponentSkillIdx = 0;
            lock (Plugin.BoardLock)
            {
                Plugin.PlayerBoard.Clear();
                Plugin.OpponentBoard.Clear();
                Plugin.InstanceToTemplate.Clear();
                Plugin.NextPlayerSkillSocket = 0;
                Plugin.NextOpponentSkillSocket = 0;

                Plugin.ShopCards.Clear();

                foreach (var card in sync.Data.Cards)
                {
                    Plugin.InstanceToTemplate[card.InstanceId] = card.TemplateId;
                    Plugin.InstanceToSize[card.InstanceId] = card.Size;

                    // Skills: have Owner but null Section/Socket
                    if (card.Type == ECardType.Skill && card.Owner.HasValue)
                    {
                        var info = new CardInfo
                        {
                            Title = Plugin.ResolveName(card.InstanceId, card.TemplateId),
                            Tier = card.Tier.ToString(),
                            Size = ECardSize.Small,
                            CardType = "Skill"
                        };
                        if (card.Attributes != null)
                            foreach (var attr in card.Attributes)
                                info.Attributes[attr.Key.ToString()] = attr.Value;

                        if (card.Owner == ECombatantId.Player && playerSkillIdx < 12)
                        {
                            info.Socket = playerSkillIdx++;
                            Plugin.PlayerBoard[card.InstanceId] = info;
                        }
                        else if (card.Owner == ECombatantId.Opponent && opponentSkillIdx < 12)
                        {
                            info.Socket = opponentSkillIdx++;
                            Plugin.OpponentBoard[card.InstanceId] = info;
                        }
                        Plugin.Log.LogInfo($"Sync skill: {info.Title} socket={info.Socket} owner={card.Owner}");
                        continue;
                    }

                    if (!card.Socket.HasValue || card.Section != EInventorySection.Hand)
                    {
                        // Track unplaced items/skills as shop cards
                        if (!card.Socket.HasValue && !card.Owner.HasValue &&
                            (card.Type == ECardType.Item || card.Type == ECardType.Skill))
                        {
                            Plugin.ShopCards.Add(new ShopCardInfo
                            {
                                Title = Plugin.ResolveName(card.InstanceId, card.TemplateId),
                                CardType = card.Type.ToString(),
                                Tier = card.Tier.ToString(),
                                Size = card.Size.ToString()
                            });
                        }
                        skipped++;
                        continue;
                    }

                    var itemInfo = CardFromSnapshot(card);

                    if (card.Owner == ECombatantId.Player)
                        Plugin.PlayerBoard[card.InstanceId] = itemInfo;
                    else if (card.Owner == ECombatantId.Opponent)
                        Plugin.OpponentBoard[card.InstanceId] = itemInfo;
                }
                Plugin.NextPlayerSkillSocket = playerSkillIdx;
                Plugin.NextOpponentSkillSocket = opponentSkillIdx;
            }
            Plugin.ShowOverlay = true;
            Plugin.Log.LogInfo($"State sync: p:{Plugin.PlayerBoard.Count} o:{Plugin.OpponentBoard.Count} skills:p{playerSkillIdx}/o{opponentSkillIdx} (skipped:{skipped})");
            Plugin.RequestBroadcast();
        }

        static Dictionary<string, CardInfo> GetBoard(ECombatantId owner)
        {
            return owner == ECombatantId.Player ? Plugin.PlayerBoard : Plugin.OpponentBoard;
        }

        static void HandleGameSim(NetMessageGameSim sim)
        {
            bool changed = false;

            // Log event summary
            Plugin.Log.LogInfo($"  GameSim: {sim.Data.Events.Count} events, {sim.Data.Cards.Count} card updates");

            lock (Plugin.BoardLock)
            {
                foreach (var evt in sim.Data.Events)
                {
                    if (evt is GameSimEventCardSold sold)
                    {
                        if (Plugin.PlayerBoard.Remove(sold.InstanceId) ||
                            Plugin.OpponentBoard.Remove(sold.InstanceId))
                            changed = true;
                    }
                    else if (evt is GameSimEventCardDisposed disposed)
                    {
                        if (Plugin.PlayerBoard.Remove(disposed.InstanceId) ||
                            Plugin.OpponentBoard.Remove(disposed.InstanceId))
                            changed = true;
                    }
                    else if (evt is GameSimEventCardSpawned spawned)
                    {
                        if (spawned.Section == EInventorySection.Hand &&
                            spawned.Socket.HasValue)
                        {
                            var tid = Guid.TryParse(spawned.TemplateId, out var g) ? g : Guid.Empty;
                            Plugin.InstanceToTemplate[spawned.InstanceId] = tid;
                            ECardSize spawnSize = ECardSize.Medium;
                            Plugin.InstanceToSize.TryGetValue(spawned.InstanceId, out spawnSize);
                            var info = new CardInfo
                            {
                                Title = Plugin.ResolveName(spawned.InstanceId, tid),
                                Tier = "Bronze",
                                Socket = (int)spawned.Socket.Value,
                                Size = spawnSize,
                                CardType = spawned.Type.ToString()
                            };
                            GetBoard(spawned.CombatantId)[spawned.InstanceId] = info;
                            changed = true;
                        }
                    }
                    else if (evt is GameSimEventCardDealt dealt)
                    {
                        var tid = Guid.TryParse(dealt.TemplateId, out var g) ? g : Guid.Empty;
                        Plugin.InstanceToTemplate[dealt.InstanceId] = tid;
                        var name = Plugin.ResolveName(dealt.InstanceId, tid);
                        Plugin.ShopCards.Add(new ShopCardInfo
                        {
                            Title = name,
                            CardType = dealt.Type.ToString(),
                            Tier = "Bronze",
                            Size = "Medium"
                        });
                        Plugin.Log.LogInfo($"Shop dealt: {name} ({dealt.Type})");
                        changed = true;
                    }
                    else if (evt is GameSimEventCardPurchased purchased)
                    {
                        // Remove from shop
                        var pTid = Guid.Empty;
                        Plugin.InstanceToTemplate.TryGetValue(purchased.InstanceId, out pTid);
                        var pName = Plugin.ResolveName(purchased.InstanceId, pTid);
                        Plugin.ShopCards.RemoveAll(s => s.Title == pName);

                        // Add to board if we have socket info
                        if (purchased.Section == EInventorySection.Hand &&
                            purchased.LeftSocketId.HasValue &&
                            purchased.CombatantId.HasValue)
                        {
                            Plugin.PlayerBoard.Remove(purchased.InstanceId);
                            Plugin.OpponentBoard.Remove(purchased.InstanceId);

                            var board = GetBoard(purchased.CombatantId.Value);
                            ECardSize pSize = ECardSize.Small;
                            Plugin.InstanceToSize.TryGetValue(purchased.InstanceId, out pSize);
                            var info = new CardInfo
                            {
                                Title = pName,
                                Tier = "Bronze",
                                Socket = (int)purchased.LeftSocketId.Value,
                                Size = pSize,
                                CardType = "Item"
                            };
                            board[purchased.InstanceId] = info;
                        }
                        Plugin.Log.LogInfo($"Purchased: {pName} socket={purchased.LeftSocketId} section={purchased.Section}");
                        changed = true;
                    }
                    else if (evt is GameSimEventPlayerSkillEquipped skillEquipped)
                    {
                        var tid = Guid.Empty;
                        Plugin.InstanceToTemplate.TryGetValue(skillEquipped.InstanceId, out tid);
                        var sName = Plugin.ResolveName(skillEquipped.InstanceId, tid);
                        var board = GetBoard(skillEquipped.Owner);

                        // Skip if already tracked (by InstanceId or by name)
                        if (board.ContainsKey(skillEquipped.InstanceId))
                        {
                            Plugin.Log.LogInfo($"Skill equipped (already tracked by id): {sName} owner={skillEquipped.Owner}");
                        }
                        else
                        {
                            // Check if same skill name already on this board (combat can reassign InstanceIds)
                            bool nameExists = false;
                            foreach (var kvp in board)
                            {
                                if (kvp.Value.CardType == "Skill" && kvp.Value.Title == sName)
                                {
                                    nameExists = true;
                                    break;
                                }
                            }

                            if (nameExists)
                            {
                                Plugin.Log.LogInfo($"Skill equipped (already tracked by name): {sName} owner={skillEquipped.Owner}");
                            }
                            else
                            {
                                int socketIdx;
                                if (skillEquipped.Owner == ECombatantId.Player)
                                    socketIdx = Plugin.NextPlayerSkillSocket++;
                                else
                                    socketIdx = Plugin.NextOpponentSkillSocket++;

                                if (socketIdx < 12)
                                {
                                    var info = new CardInfo
                                    {
                                        Title = sName,
                                        Tier = "Bronze",
                                        Socket = socketIdx,
                                        Size = ECardSize.Small,
                                        CardType = "Skill"
                                    };
                                    board[skillEquipped.InstanceId] = info;
                                    changed = true;
                                }
                                Plugin.Log.LogInfo($"Skill equipped: {sName} socket={socketIdx} owner={skillEquipped.Owner}");
                            }
                        }
                    }
                    else if (evt is GameSimEventStateTransitioned stateTransition)
                    {
                        Plugin.Log.LogInfo($"State: -> {stateTransition.ToState}");
                        if (stateTransition.ToState == BazaarGameShared.Domain.Runs.ERunState.Choice)
                        {
                            Plugin.ShopCards.Clear();
                        }

                        if (stateTransition.ToState == BazaarGameShared.Domain.Runs.ERunState.NewRun)
                        {
                            Plugin.PlayerBoard.Clear();
                            Plugin.OpponentBoard.Clear();
                            Plugin.ShopCards.Clear();
                            Plugin.InstanceToTemplate.Clear();
                            Plugin.NextPlayerSkillSocket = 0;
                            Plugin.NextOpponentSkillSocket = 0;
                        }

                        if (HiddenStates.Contains(stateTransition.ToState))
                        {
                            Plugin.ShowOverlay = false;
                            changed = true;
                        }
                        else
                        {
                            Plugin.ShowOverlay = true;
                            changed = true;
                        }
                    }
                }

                foreach (var kvp in sim.Data.Cards)
                {
                    var update = kvp.Value;
                    if (update.Size.HasValue)
                        Plugin.InstanceToSize[update.InstanceId] = update.Size.Value;
                    if (update.Placement != null)
                    {
                        if (update.Placement.Section == EInventorySection.Hand &&
                            update.Placement.Socket.HasValue &&
                            update.Placement.Owner.HasValue)
                        {
                            // Preserve existing card data if moving
                            CardInfo prev = null;
                            Plugin.PlayerBoard.TryGetValue(update.InstanceId, out prev);
                            if (prev == null)
                                Plugin.OpponentBoard.TryGetValue(update.InstanceId, out prev);

                            Plugin.PlayerBoard.Remove(update.InstanceId);
                            Plugin.OpponentBoard.Remove(update.InstanceId);

                            var board = GetBoard(update.Placement.Owner.Value);
                            var templateId = Guid.Empty;
                            Plugin.InstanceToTemplate.TryGetValue(update.InstanceId, out templateId);

                            var info = new CardInfo
                            {
                                Title = Plugin.ResolveName(update.InstanceId, templateId),
                                Tier = update.Tier?.ToString() ?? prev?.Tier ?? "Bronze",
                                Socket = (int)update.Placement.Socket.Value,
                                Size = update.Size ?? prev?.Size ?? ECardSize.Medium,
                                CardType = prev?.CardType ?? "Item",
                                Enchantment = update.Enchantment?.ToString() ?? prev?.Enchantment
                            };

                            // Carry over existing attributes, then apply deltas
                            if (prev != null)
                                foreach (var a in prev.Attributes)
                                    info.Attributes[a.Key] = a.Value;

                            if (update.Attributes != null)
                                foreach (var attr in update.Attributes)
                                    info.Attributes[attr.Key.ToString()] = attr.Value.Value;

                            board[update.InstanceId] = info;
                            changed = true;
                        }
                        else
                        {
                            // Don't remove skills — they have Placement with null section/socket
                            CardInfo maybeSkill = null;
                            Plugin.PlayerBoard.TryGetValue(update.InstanceId, out maybeSkill);
                            if (maybeSkill == null)
                                Plugin.OpponentBoard.TryGetValue(update.InstanceId, out maybeSkill);
                            if (maybeSkill == null || maybeSkill.CardType != "Skill")
                            {
                                if (Plugin.PlayerBoard.Remove(update.InstanceId) ||
                                    Plugin.OpponentBoard.Remove(update.InstanceId))
                                    changed = true;
                            }
                        }
                    }

                    CardInfo existing = null;
                    if (Plugin.PlayerBoard.TryGetValue(update.InstanceId, out existing) ||
                        Plugin.OpponentBoard.TryGetValue(update.InstanceId, out existing))
                    {
                        if (update.Size.HasValue) { existing.Size = update.Size.Value; changed = true; }
                        if (update.Tier.HasValue) { existing.Tier = update.Tier.Value.ToString(); changed = true; }
                        if (update.Enchantment.HasValue) { existing.Enchantment = update.Enchantment.Value.ToString(); changed = true; }
                        if (update.Attributes != null)
                        {
                            foreach (var attr in update.Attributes)
                            {
                                existing.Attributes[attr.Key.ToString()] = attr.Value.Value;
                                changed = true;
                            }
                        }
                    }
                }
            }

            if (changed)
            {
                Plugin.Log.LogInfo($"GameSim: p:{Plugin.PlayerBoard.Count} o:{Plugin.OpponentBoard.Count}");
                Plugin.RequestBroadcast();
            }
        }
    }
}
