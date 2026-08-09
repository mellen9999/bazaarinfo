# bepinex-plugin

Not shipped. The product ships `packages/companion` (python, reads `Player.log`), which
never touches the game process. This plugin exists for one reason: `Player.log` carries
no tier or enchantment data, ever, and reading it in-process is the only way to get it.

## status: does not compile against the live game

As of the 2026-08-06 build (steam buildid 24570932) `Plugin.cs` fails to build:

```
error CS0234: The type or namespace name 'Infra' does not exist in the namespace 'BazaarGameClient'
error CS0246: The type or namespace name 'SocketClient' could not be found
```

A patch deleted `BazaarGameClient.Infra.SocketClient`, which is what the Harmony patch
hooks. The whole `BazaarGameClient.Infra.*` namespace is gone. The plugin would not load
today even if it were built.

What survived, confirmed by dumping the current assemblies:

| what | where it is now |
| --- | --- |
| the message types | `BazaarGameShared.Infra.Messages.NetMessage*` — unchanged, still in `BazaarGameShared.dll` |
| the handler interface | `BazaarGameShared.Infra.Messages.INetMessageHandler` (six `Handle` overloads) |
| the likely new hook | `TheBazaar.GameMessageHandler\`1` in `TheBazaarRuntime.dll` — methods `Handle`, `HandleMessage`, `IsMessageHandled`, `LogMessage` |

Re-targeting means patching a generic type, so the Harmony attribute needs the closed
generic (or a `TargetMethods()` that enumerates the constructed types).

To re-check after any patch, dump the assemblies rather than guessing — `PEReader` +
`MetadataReader` over `TheBazaar_Data/Managed/*.dll` is enough, no decompiler needed.

## build

```
dotnet build -c Release -p:GameDir="$HOME/.local/share/Steam/steamapps/common/The Bazaar"
```

Output goes to `bin/Release/netstandard2.1/BazaarInfoPlugin.dll`; BepInEx loads it from
`<game>/BepInEx/plugins/`.

## fix these before it ever runs again

Three hot spots. All of them bill to the game's own CPU, because the plugin lives inside
the game process — which means they are invisible in task manager and look like the game
getting slower.

1. **`Update()` calls `FindObjectOfType<BoardManager>()` every frame** until the socket
   layout caches, and `Camera.main` with it. In menus, loading, or any scene without a
   `BoardManager`, `LayoutReady` never flips and this runs at full framerate forever.
   `FindObjectOfType` walks every loaded object. Poll on an interval, or hook a scene
   load, instead of polling per frame.

2. **`ProcessMessagePatch.Postfix` logs every single net message** (`MSG: {name}`), and
   `HandleGameSim` logs per message on top of that. During combat the sim streams
   continuously, so this is string interpolation plus a synchronised disk write on the
   main thread, per message. Gate it behind a debug config entry.

3. **`DoSendBoard()` has no in-flight guard and no rate limit.** `RequestBroadcast()`
   sets a flag and `Update()` acts on it, so the ceiling is one HTTP POST per frame.
   Each one is a blocking `HttpWebRequest` on a threadpool thread, and .NET's default
   `ServicePointManager.DefaultConnectionLimit` is 2 — so once posts outpace responses
   the queue grows without bound and the threadpool injects threads to sit blocked on
   it. Coalesce like the companion does (`should_flush` in `logwatch.py`: send once the
   stream goes quiet, or once a change is overdue) and drop a send while one is in
   flight.
