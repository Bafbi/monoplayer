package eu.monoplayer.observer;

import com.comphenix.protocol.PacketType;
import com.comphenix.protocol.ProtocolLibrary;
import com.comphenix.protocol.events.ListenerPriority;
import com.comphenix.protocol.events.PacketAdapter;
import com.comphenix.protocol.events.PacketContainer;
import com.comphenix.protocol.events.PacketEvent;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerResourcePackStatusEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.BufferedWriter;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The server transparency observer (#12).
 *
 * <p>Records what the server knows about a joining client: identity, address,
 * brand, client information, chat session presence, transfer intent, the
 * configuration gate, and resource pack status. One JSONL record per join, in
 * {@code plugins/MonoplayerObserver/views.jsonl}.
 *
 * <p>Read-only by construction: listeners run at MONITOR priority and never
 * cancel or edit a packet, so the observer cannot change what the server or the
 * client does.
 */
public final class ObserverPlugin extends JavaPlugin implements Listener {

    private static final String BRAND_CHANNEL = "minecraft:brand";

    private final Map<String, View> views = new ConcurrentHashMap<>();
    private BufferedWriter out;

    @Override
    public void onEnable() {
        try {
            Path dir = getDataFolder().toPath();
            Files.createDirectories(dir);
            out = Files.newBufferedWriter(dir.resolve("views.jsonl"), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException error) {
            getLogger().severe("cannot open the view log: " + error.getMessage());
            return;
        }
        getServer().getPluginManager().registerEvents(this, this);
        if (getServer().getPluginManager().getPlugin("ProtocolLib") == null) {
            getLogger().warning("ProtocolLib is absent: brand, skin parts, chat session, transfer intent and the configuration gate are unobserved");
            return;
        }
        registerPacketListeners();
        getLogger().info("wire listeners registered");
    }

    @Override
    public void onDisable() {
        try {
            if (out != null) out.close();
        } catch (IOException ignored) {
            // nothing left to flush to
        }
    }

    private void registerPacketListeners() {
        // The wire fields Bukkit does not expose. MONITOR, never editing.
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Handshake.Client.SET_PROTOCOL) {
                    @Override
                    public void onPacketReceiving(PacketEvent event) {
                        Object nextState = read(event.getPacket(), 3);
                        if (nextState instanceof Integer value && value == 3) {
                            viewFor(event).transferred = true;
                        }
                    }
                });
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Configuration.Client.CLIENT_INFORMATION) {
                    @Override
                    public void onPacketReceiving(PacketEvent event) {
                        View view = viewFor(event);
                        // 26.x exposes the whole settings packet as one value
                        // object: measured on the gate Paper, "settings fields 1:
                        // 0=ClientInformation[language=fr_fr, viewDistance=8,
                        // ..., modelCustomisation=96, mainHand=LEFT, ...]". So the
                        // fields are that object's members, not the packet's. A
                        // shape that still carries them flat is read by index, and
                        // a member that is not there stays unobserved.
                        Object settings = read(event.getPacket(), 0);
                        Object locale = firstNonNull(called(settings, "language", "locale"), read(event.getPacket(), 0));
                        Object distance = firstNonNull(called(settings, "viewDistance"), read(event.getPacket(), 1));
                        Object skin = firstNonNull(called(settings, "modelCustomisation", "skinParts"), read(event.getPacket(), 4));
                        Object hand = firstNonNull(called(settings, "mainHand"), read(event.getPacket(), 5));
                        if (locale instanceof String value) view.locale = value;
                        // The wire types are narrow (i8 distance, u8 skin parts);
                        // ProtocolLib boxes them at different widths, so accept any
                        // Number and narrow where the field is unsigned.
                        if (distance instanceof Number value) view.viewDistance = value.intValue();
                        if (skin instanceof Number value) view.skinParts = value.intValue() & 0xff;
                        if (hand instanceof Number value) view.mainHand = value.intValue() == 0 ? "left" : "right";
                        else if (hand instanceof String || hand instanceof Enum<?>) view.mainHand = handName(hand);
                    }
                });
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Configuration.Client.CUSTOM_PAYLOAD) {
                    @Override
                    public void onPacketReceiving(PacketEvent event) {
                        // Same value-object shape as the settings packet: measured
                        // on the gate Paper, the payload reads
                        // "DiscardedPayload[id=minecraft:brand, data=[B@...]", with
                        // nothing at index 1. Both shapes are read, and the payload
                        // object is preferred when it names the channel.
                        Object payload = read(event.getPacket(), 0);
                        Object channel = payload instanceof String value ? value : called(payload, "id", "channel");
                        Object data = firstNonNull(read(event.getPacket(), 1), called(payload, "data", "payload", "bytes"));
                        if (data instanceof byte[] bytes && BRAND_CHANNEL.equals(String.valueOf(channel))) {
                            viewFor(event).brand = decodeBrand(bytes);
                        }
                    }
                });
        // #21: the configuration gate. The gate itself is clientbound (the
        // server asked) and the acceptance is serverbound (the client
        // answered). Both are configuration-phase frames, so both carry the
        // connection's view, not the joined player's.
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Configuration.Server.CODE_OF_CONDUCT) {
                    @Override
                    public void onPacketSending(PacketEvent event) {
                        viewFor(event).codeOfConduct = true;
                    }
                });
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Configuration.Client.ACCEPT_CODE_OF_CONDUCT) {
                    @Override
                    public void onPacketReceiving(PacketEvent event) {
                        viewFor(event).codeOfConductAccepted = true;
                    }
                });
        ProtocolLibrary.getProtocolManager().addPacketListener(
                new PacketAdapter(this, ListenerPriority.MONITOR, PacketType.Play.Client.CHAT_SESSION_UPDATE) {
                    @Override
                    public void onPacketReceiving(PacketEvent event) {
                        // The session key arrives after the join, so the view is
                        // written again: the record at join cannot carry it, and a
                        // field observed late must not read as a default.
                        View view = viewFor(event);
                        view.chatSession = true;
                        write(view);
                    }
                });
    }

    // A named member of a packet's value object, by accessor or field name. The
    // object is the server's own type, so nothing here links against an NMS class;
    // a name that is not there returns null and the field stays unobserved rather
    // than guessed.
    private static Object called(Object target, String... names) {
        if (target == null) return null;
        Class<?> type = target.getClass();
        for (String name : names) {
            for (String candidate : new String[] { name, getterName(name) }) {
                Method method = declaredMethod(type, candidate);
                if (method != null) {
                    try {
                        return method.invoke(target);
                    } catch (ReflectiveOperationException | RuntimeException ignored) {
                        // fall through to the field of the same name
                    }
                }
            }
            Field field = declaredField(type, name);
            if (field != null) {
                try {
                    return field.get(target);
                } catch (ReflectiveOperationException | RuntimeException ignored) {
                    // a member the observer cannot read is a field it did not see
                }
            }
        }
        return null;
    }

    private static String getterName(String name) {
        return "get" + Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }

    private static Method declaredMethod(Class<?> type, String name) {
        try {
            Method found = type.getDeclaredMethod(name);
            found.setAccessible(true);
            return found;
        } catch (NoSuchMethodException | RuntimeException absent) {
            return null;
        }
    }

    private static Field declaredField(Class<?> type, String name) {
        try {
            Field found = type.getDeclaredField(name);
            found.setAccessible(true);
            return found;
        } catch (NoSuchFieldException | RuntimeException absent) {
            return null;
        }
    }

    private static Object firstNonNull(Object first, Object second) {
        return first != null ? first : second;
    }

    // The main hand as the report names it. The wire carries an enum on 26.x
    // ("RIGHT", "LEFT") and a VarInt on the shapes before it.
    private static String handName(Object hand) {
        String name = String.valueOf(hand).toUpperCase(Locale.ROOT);
        if (name.contains("LEFT")) return "left";
        if (name.contains("RIGHT")) return "right";
        return null;
    }

    // A packet's field by index, whatever its declared type. The observer reads
    // a handful of fields and never writes one.
    private static Object read(PacketContainer packet, int index) {
        try {
            return packet.getModifier().read(index);
        } catch (RuntimeException absent) {
            return null;
        }
    }

    // One view per connection, keyed by the client's address. Measured on 26.2:
    // the handshake and configuration frames carry a player object already (the
    // handshake one logs as UNKNOWN[<address>]), so the key is the same address the
    // join uses. A frame the server attributes to no address keys a view under
    // "null", and such a view is never written, because only the join and the
    // packet handlers write, and a join always has an address.
    private View viewFor(PacketEvent event) {
        Player player = event.getPlayer();
        InetSocketAddress address = player == null ? null : player.getAddress();
        return views.computeIfAbsent(String.valueOf(address), key -> new View());
    }

    // The brand payload is the vanilla string type: a VarInt length, then UTF-8.
    static String decodeBrand(byte[] data) {
        if (data == null || data.length == 0) return null;
        int length = 0;
        int shift = 0;
        int index = 0;
        while (index < data.length) {
            int value = data[index++] & 0xff;
            length |= (value & 0x7f) << shift;
            if ((value & 0x80) == 0) break;
            shift += 7;
            if (shift > 35) return null;
        }
        if (length < 0 || index + length > data.length) return null;
        return new String(data, index, length, StandardCharsets.UTF_8);
    }

    // The resource-pack status is the one field that always arrives after the
    // join, so a join alone cannot carry it. The view stays in the map and is
    // written again when that status lands: one record per observation of one
    // connection, and the report merges the records that share an address.
    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        String key = String.valueOf(player.getAddress());
        View view = views.computeIfAbsent(key, ignored -> new View());
        view.player = player.getName();
        view.uuid = player.getUniqueId().toString();
        view.address = key;
        if (view.locale == null) view.locale = player.locale().toString();
        if (view.viewDistance == null) view.viewDistance = player.getClientViewDistance();
        if (view.mainHand == null) view.mainHand = player.getMainHand() == org.bukkit.inventory.MainHand.LEFT ? "left" : "right";
        view.transferred = view.transferred != null && view.transferred;
        view.chatSession = view.chatSession != null && view.chatSession;
        write(view);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onResourcePack(PlayerResourcePackStatusEvent event) {
        String key = String.valueOf(event.getPlayer().getAddress());
        View view = views.get(key);
        // No view means the join was not recorded for this connection, so there is
        // nothing to add a field to.
        if (view == null) return;
        view.resourcePack = event.getStatus().name().toLowerCase();
        write(view);
    }

    // A reconnect from the same source address must not inherit the last session's
    // observations, so the view leaves with the player.
    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        views.remove(String.valueOf(event.getPlayer().getAddress()));
    }

    private synchronized void write(View view) {
        if (out == null) return;
        try {
            out.write(view.toJson());
            out.newLine();
            out.flush();
            getLogger().info("client_view " + view.player + " " + view.toJson());
        } catch (IOException error) {
            getLogger().severe("cannot write the view log: " + error.getMessage());
        }
    }

    /** What the server knows about one client. Null fields were not observed. */
    private static final class View {
        String player;
        String uuid;
        String address;
        String brand;
        String locale;
        Integer viewDistance;
        String mainHand;
        Integer skinParts;
        Boolean chatSession;
        Boolean transferred;
        Boolean codeOfConduct;
        Boolean codeOfConductAccepted;
        String resourcePack;

        String toJson() {
            StringBuilder json = new StringBuilder("{");
            json.append("\"event\":\"client_view\"");
            append(json, "player", player);
            append(json, "uuid", uuid);
            append(json, "address", address);
            append(json, "brand", brand);
            append(json, "locale", locale);
            append(json, "viewDistance", viewDistance);
            append(json, "mainHand", mainHand);
            append(json, "skinParts", skinParts);
            append(json, "chatSession", chatSession);
            append(json, "transferred", transferred);
            append(json, "codeOfConduct", codeOfConduct);
            append(json, "codeOfConductAccepted", codeOfConductAccepted);
            append(json, "resourcePack", resourcePack);
            json.append('}');
            return json.toString();
        }

        private static void append(StringBuilder json, String name, Object value) {
            if (value == null) return;
            json.append(",\"").append(name).append("\":");
            if (value instanceof Number || value instanceof Boolean) json.append(value);
            else json.append('"').append(escape(String.valueOf(value))).append('"');
        }

        private static String escape(String value) {
            StringBuilder out = new StringBuilder(value.length());
            for (char c : value.toCharArray()) {
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    default -> out.append(c);
                }
            }
            return out.toString();
        }
    }
}
