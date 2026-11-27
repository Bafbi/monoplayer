package eu.monoplayer.driver;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.pipeline.RenderTarget;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.ErrorScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.PlayerSkin;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import io.netty.buffer.Unpooled;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Loopback JSON driver for the driver lane. This is test instrumentation: it reads
 * client state and invokes the same vanilla interaction calls the input path
 * uses. It never touches the network stack.
 */
public final class DriverServer {
    private static final int TIMEOUT_SECONDS = 10;
    // The entities op reads this far around the player it controls unless the
    // caller names a radius, and reports no more rows than this however large the
    // radius is, so one answer stays a payload a caller can read.
    private static final double DEFAULT_ENTITY_RADIUS = 64.0;
    private static final int MAX_ENTITY_ROWS = 1000;

    private final Minecraft mc = Minecraft.getInstance();
    private final ServerSocket server;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1, r -> {
        Thread t = new Thread(r, "monoplayer-driver-timer");
        t.setDaemon(true);
        return t;
    });

    public DriverServer(int port) throws IOException {
        this.server = new ServerSocket();
        this.server.setReuseAddress(true);
        this.server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
    }

    public void start() {
        Thread thread = new Thread(this::acceptLoop, "monoplayer-driver");
        thread.setDaemon(true);
        thread.start();
        System.out.println("[monoplayer-driver] listening on 127.0.0.1:" + server.getLocalPort());
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try (Socket socket = server.accept()) {
                socket.setTcpNoDelay(true);
                handle(socket);
            } catch (IOException e) {
                if (!server.isClosed()) {
                    System.err.println("[monoplayer-driver] accept failed: " + e.getMessage());
                }
            }
        }
    }

    private void handle(Socket socket) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        PrintWriter out = new PrintWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8), true);
        String line;
        while ((line = in.readLine()) != null) {
            JsonObject response;
            try {
                JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                response = dispatch(request);
            } catch (Exception e) {
                response = error(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            out.println(response);
        }
    }

    private JsonObject dispatch(JsonObject request) throws Exception {
        String expected = System.getProperty("gateb.driver.token");
        if (expected != null && !expected.isEmpty()) {
            String actual = request.has("token") ? request.get("token").getAsString() : "";
            if (!expected.equals(actual)) {
                return error("bad token");
            }
        }

        String op = request.has("op") ? request.get("op").getAsString() : "";
        switch (op) {
            case "status":
                return ok(mc.submit(this::status).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            case "screen":
                return ok(mc.submit(this::screenInfo).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            case "click": {
                String label = request.has("label") ? request.get("label").getAsString() : null;
                int index = request.has("index") ? request.get("index").getAsInt() : -1;
                JsonObject result = mc.submit(() -> clickButton(label, index))
                    .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
                if (result.get("clicked").getAsBoolean()) {
                    return ok(result);
                }
                // Not found: tell the caller what was available instead.
                JsonObject notFound = new JsonObject();
                notFound.addProperty("ok", false);
                notFound.addProperty("error", "no button matched: "
                    + (label == null ? "index " + index : label));
                notFound.add("labels", result.get("labels"));
                return notFound;
            }
            case "pause":
                return ok(mc.submit(() -> {
                    mc.gui.setScreen(new PauseScreen(true));
                    return screenInfo();
                }).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            case "move": {
                long ms = request.has("ms") ? request.get("ms").getAsLong() : 1000L;
                mc.execute(() -> mc.options.keyUp.setDown(true));
                scheduler.schedule(() -> mc.execute(() -> mc.options.keyUp.setDown(false)), ms, TimeUnit.MILLISECONDS);
                JsonObject result = new JsonObject();
                result.addProperty("movingMs", ms);
                return ok(result);
            }
            case "look": {
                float yaw = request.has("yaw") ? request.get("yaw").getAsFloat() : 0f;
                float pitch = request.has("pitch") ? request.get("pitch").getAsFloat() : 0f;
                mc.execute(() -> {
                    if (mc.player != null) {
                        mc.player.setYRot(yaw);
                        mc.player.setXRot(pitch);
                    }
                });
                JsonObject result = new JsonObject();
                result.addProperty("yaw", yaw);
                result.addProperty("pitch", pitch);
                return ok(result);
            }
            case "break": {
                long ms = request.has("ms") ? request.get("ms").getAsLong() : 1000L;
                return ok(breakBlock(request, ms).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            case "place": {
                long ms = request.has("ms") ? request.get("ms").getAsLong() : 150L;
                return ok(placeBlock(request, ms).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            case "screenshot":
                return ok(takeScreenshot());
            // Research instrumentation (#99): what skin the client resolved for
            // the player it controls and for every entry it holds, the camera
            // mode a screenshot would be taken from, and the second-person view
            // switch itself.
            case "skin":
                return ok(mc.submit(this::skinInfo).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            // #675: what the client's own level holds, read on the client thread.
            // skin reads the tab list, which is a listing; this reads the world,
            // which is a body. Neither answers for the other.
            case "entities": {
                double radius = request.has("radius")
                    ? Math.max(0.0, request.get("radius").getAsDouble())
                    : DEFAULT_ENTITY_RADIUS;
                return ok(mc.submit(() -> entityInfo(radius)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            case "perspective": {
                String mode = request.has("mode") ? request.get("mode").getAsString() : "third_back";
                return ok(mc.submit(() -> setPerspective(mode)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            // Delivers one clientbound player_info frame the caller encoded, by
            // decoding it with the client's own codec and handing it to the
            // client's own packet listener. The client validates it exactly as
            // it validates a frame from a server, so what it renders afterwards
            // is evidence about the client and not about this mod.
            case "inject_player_info": {
                String hex = request.has("hex") ? request.get("hex").getAsString() : "";
                return ok(mc.submit(() -> injectPlayerInfo(hex)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            case "respawn":
                return ok(mc.submit(() -> {
                    JsonObject result = new JsonObject();
                    if (mc.player == null) {
                        result.addProperty("respawned", false);
                    } else {
                        mc.player.respawn();
                        result.addProperty("respawned", true);
                    }
                    return result;
                }).get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            case "disconnect":
                mc.execute(() -> mc.disconnectFromWorld(Component.literal("monoplayer-driver")));
                return ok(new JsonObject());
            case "quit": {
                JsonObject result = new JsonObject();
                result.addProperty("quitting", true);
                scheduler.schedule(() -> {
                    mc.execute(() -> mc.stop());
                    scheduler.schedule(() -> System.exit(0), 500, TimeUnit.MILLISECONDS);
                }, 100, TimeUnit.MILLISECONDS);
                return ok(result);
            }
            default:
                return error("unknown op: " + op);
        }
    }

    private JsonObject status() {
        JsonObject out = new JsonObject();
        Screen current = mc.gui.screen();
        out.addProperty("screen", current == null ? "none" : current.getClass().getName());
        out.addProperty("screenTitle", current == null ? null : current.getTitle().getString());
        out.addProperty("screenNarration", current == null ? null : current.getNarrationMessage().getString());
        out.addProperty("level", mc.level != null);
        out.addProperty("player", mc.player != null);
        out.addProperty("connected",
            mc.getConnection() != null && mc.getConnection().getConnection() != null
                && mc.getConnection().getConnection().isConnected());
        // Which server this client actually joined. A lane that asks for one
        // endpoint and measures another is measuring nothing, so the parity
        // runner refuses a run whose client reports a different address.
        out.addProperty("server", remoteAddress());
        out.addProperty("fps", mc.getFps());

        if (mc.player != null) {
            out.addProperty("name", mc.player.getName().getString());
            out.addProperty("health", mc.player.getHealth());
            out.addProperty("yaw", mc.player.getYRot());
            out.addProperty("pitch", mc.player.getXRot());
            out.addProperty("selectedSlot", mc.player.getInventory().getSelectedSlot());
            JsonObject pos = new JsonObject();
            pos.addProperty("x", mc.player.getX());
            pos.addProperty("y", mc.player.getY());
            pos.addProperty("z", mc.player.getZ());
            out.add("pos", pos);
            ItemStack held = mc.player.getInventory().getSelectedItem();
            out.addProperty("held", held.isEmpty() ? "empty" : held.getItem().toString());
        }
        if (mc.level != null) {
            out.addProperty("dimension", mc.level.dimension().toString());
            out.addProperty("loadedChunks", mc.level.getChunkSource().getLoadedChunksCount());
        }
        if (mc.levelRenderer != null) {
            out.addProperty("renderedSections", mc.levelRenderer.visibleSections().size());
        }
        return out;
    }

    private String remoteAddress() {
        if (mc.getConnection() == null || mc.getConnection().getConnection() == null) {
            return null;
        }
        java.net.SocketAddress address = mc.getConnection().getConnection().getRemoteAddress();
        return address instanceof java.net.InetSocketAddress inet
            ? inet.getAddress().getHostAddress() + ":" + inet.getPort()
            : (address == null ? null : address.toString());
    }

    /**
     * Read the current screen: class, title, narration, buttons and, for
     * disconnect/connection screens, the reason as it is shown to the player.
     * The disconnect reason is private on DisconnectedScreen, so the narration
     * (which carries it) is reported instead.
     */
    private JsonObject screenInfo() {
        JsonObject out = new JsonObject();
        Screen screen = mc.gui.screen();
        String className;
        Component title;
        Component narration;
        if (screen == null) {
            className = "none";
            title = null;
            narration = null;
            out.add("buttons", new JsonArray());
        } else {
            className = screen.getClass().getName();
            title = screen.getTitle();
            narration = screen.getNarrationMessage();
            out.add("buttons", widgetRows(screen));
        }
        out.addProperty("screen", className);
        out.addProperty("title", stringOf(title));
        out.addProperty("narration", stringOf(narration));
        if (screen instanceof DisconnectedScreen || screen instanceof ConnectScreen
                || screen instanceof ErrorScreen) {
            // Public message only: the raw reason fields are private, and the
            // narration already spells the same text out for the player.
            out.addProperty("reason", stringOf(narration != null ? narration : title));
        }
        return out;
    }

    private static String stringOf(Component component) {
        return component == null ? null : component.getString();
    }

    private static JsonArray widgetRows(Screen screen) {
        JsonArray rows = new JsonArray();
        for (GuiEventListener child : screen.children()) {
            if (child instanceof AbstractWidget widget) {
                JsonObject row = new JsonObject();
                row.addProperty("label", widget.getMessage().getString());
                row.addProperty("active", widget.isActive());
                row.addProperty("visible", widget.visible);
                row.addProperty("x", widget.getX());
                row.addProperty("y", widget.getY());
                row.addProperty("width", widget.getWidth());
                row.addProperty("height", widget.getHeight());
                rows.add(row);
            }
        }
        return rows;
    }

    /**
     * Press a button on the current screen by case-insensitive label substring
     * (or by index) without window focus; the synthetic input is delivered
     * straight to the widget on the render thread. Returns the visible button
     * labels either way so the caller can pick a better match.
     */
    private JsonObject clickButton(String label, int index) {
        JsonObject out = new JsonObject();
        JsonArray labels = new JsonArray();
        List<AbstractButton> buttons = new ArrayList<>();
        Screen screen = mc.gui.screen();
        if (screen != null) {
            for (GuiEventListener child : screen.children()) {
                if (child instanceof AbstractButton button && button.visible) {
                    labels.add(button.getMessage().getString());
                    buttons.add(button);
                }
            }
        }
        out.add("labels", labels);
        out.addProperty("clicked", false);
        if (screen == null) {
            out.addProperty("error", "no screen");
            return out;
        }
        AbstractButton target = null;
        if (label != null) {
            String needle = label.toLowerCase(Locale.ROOT);
            for (AbstractButton button : buttons) {
                if (button.getMessage().getString().toLowerCase(Locale.ROOT).contains(needle)) {
                    target = button;
                    break;
                }
            }
        } else if (index >= 0 && index < buttons.size()) {
            target = buttons.get(index);
        }
        if (target == null) {
            return out;
        }
        Component targetLabel = target.getMessage();
        double centerX = target.getX() + target.getWidth() / 2.0;
        double centerY = target.getY() + target.getHeight() / 2.0;
        target.onPress(new MouseButtonEvent(centerX, centerY, new MouseButtonInfo(0, 0)));
        out.addProperty("clicked", true);
        out.addProperty("label", targetLabel.getString());
        out.addProperty("screen", mc.gui.screen() == null ? "none" : mc.gui.screen().getClass().getName());
        return out;
    }

    /**
     * Break through the normal input path: aim at the block, hold attack for
     * {@code ms}, then release. {@code MultiPlayerGameMode.destroyBlock} only
     * mutates the client level and never tells the server, so it cannot be used
     * for a multiplayer break.
     */
    private CompletableFuture<JsonObject> breakBlock(JsonObject request, long ms) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        mc.execute(() -> {
            try {
                requireWorld();
                // Default to the ground block in front, never the one directly
                // under the player: on void/thin maps that drops them into the
                // void. Callers that really want the footing pass coordinates.
                BlockPos pos = request.has("x")
                    ? new BlockPos(request.get("x").getAsInt(), request.get("y").getAsInt(), request.get("z").getAsInt())
                    : mc.player.blockPosition().below().relative(mc.player.getDirection());
                BlockState before = mc.level.getBlockState(pos);
                aimAt(pos);
                mc.options.keyAttack.setDown(true);
                scheduler.schedule(() -> mc.execute(() -> {
                    mc.options.keyAttack.setDown(false);
                    BlockState after = mc.level.getBlockState(pos);
                    JsonObject out = new JsonObject();
                    out.addProperty("x", pos.getX());
                    out.addProperty("y", pos.getY());
                    out.addProperty("z", pos.getZ());
                    out.addProperty("before", before.getBlock().toString());
                    out.addProperty("after", after.getBlock().toString());
                    out.addProperty("broke", after.isAir());
                    future.complete(out);
                }), ms, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        });
        return future;
    }

    private void aimAt(BlockPos pos) {
        aimAt(Vec3.atCenterOf(pos));
    }

    private void aimAt(Vec3 target) {
        Vec3 eye = mc.player.getEyePosition();
        double dx = target.x - eye.x;
        double dy = target.y - eye.y;
        double dz = target.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        mc.player.setYRot((float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
        mc.player.setXRot((float) -Math.toDegrees(Math.atan2(dy, horizontal)));
    }

    /**
     * Place through the normal input path: aim at the top face of the support
     * block and hold use for one or two ticks. The direct {@code useItemOn}
     * call predicts locally but can be rejected when the packet does not carry
     * a contact point the server accepts.
     */
    private CompletableFuture<JsonObject> placeBlock(JsonObject request, long ms) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        mc.execute(() -> {
            try {
                requireWorld();
                ItemStack held = mc.player.getInventory().getSelectedItem();
                if (held.isEmpty()) {
                    throw new IllegalStateException("selected hotbar slot is empty; run /give first");
                }
                boolean explicit = request.has("x");
                BlockPos base = explicit
                    ? new BlockPos(request.get("x").getAsInt(), request.get("y").getAsInt(), request.get("z").getAsInt())
                    : mc.player.blockPosition().below().relative(mc.player.getDirection());
                BlockPos target = base.above();
                BlockState baseBefore = mc.level.getBlockState(base);
                BlockState targetBefore = mc.level.getBlockState(target);
                aimAt(Vec3.atBottomCenterOf(target));
                mc.options.keyUse.setDown(true);
                scheduler.schedule(() -> mc.execute(() -> {
                    mc.options.keyUse.setDown(false);
                    BlockState targetAfter = mc.level.getBlockState(target);
                    JsonObject out = new JsonObject();
                    out.addProperty("baseX", base.getX());
                    out.addProperty("baseY", base.getY());
                    out.addProperty("baseZ", base.getZ());
                    out.addProperty("baseSource", explicit ? "explicit" : "front");
                    out.addProperty("baseBlock", baseBefore.getBlock().toString());
                    out.addProperty("targetBefore", targetBefore.getBlock().toString());
                    out.addProperty("targetBlock", targetAfter.getBlock().toString());
                    out.addProperty("placed", !targetAfter.isAir());
                    out.addProperty("held", held.getItem().toString());
                    future.complete(out);
                }), ms, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        });
        return future;
    }

    private JsonObject takeScreenshot() throws Exception {
        CompletableFuture<String> future = new CompletableFuture<>();
        mc.execute(() -> {
            String name = "driver-" + System.currentTimeMillis() + ".png";
            File file = new File(new File(mc.gameDirectory, "screenshots"), name);
            RenderTarget target = mc.gameRenderer.mainRenderTarget();
            Screenshot.grab(mc.gameDirectory, name, target, 1, component -> future.complete(file.getAbsolutePath()));
        });
        JsonObject out = new JsonObject();
        out.addProperty("path", future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        return out;
    }


    // --- skin and packet injection (#99) ---

    /**
     * The client's own view of the skin question: which texture the player it
     * controls renders, which texture every player_info entry resolves to, and
     * the textures properties those entries carry. A skin the client accepted
     * reports a skin texture path; one it rejected reports the default
     * (steve/alex) path, so the two are distinguishable without a screenshot.
     */
    private JsonObject skinInfo() {
        JsonObject out = new JsonObject();
        ClientPacketListener conn = mc.getConnection();
        out.addProperty("connected", conn != null);
        out.addProperty("camera", mc.options.getCameraType().name());
        if (mc.getUser() != null) {
            out.addProperty("sessionName", mc.getUser().getName());
            out.addProperty("sessionUuid", String.valueOf(mc.getUser().getProfileId()));
        }
        if (mc.player != null) {
            JsonObject self = new JsonObject();
            self.addProperty("uuid", mc.player.getUUID().toString());
            self.addProperty("name", mc.player.getName().getString());
            self.add("skin", describeSkin(mc.player.getSkin()));
            out.add("self", self);
        }
        JsonArray players = new JsonArray();
        if (conn != null) {
            List<String> listed = new ArrayList<>();
            for (PlayerInfo info : conn.getListedOnlinePlayers()) {
                listed.add(info.getProfile().id().toString());
            }
            for (PlayerInfo info : conn.getOnlinePlayers()) {
                GameProfile profile = info.getProfile();
                JsonObject row = new JsonObject();
                row.addProperty("uuid", profile.id().toString());
                row.addProperty("name", profile.name());
                row.addProperty("listed", listed.contains(profile.id().toString()));
                row.add("skin", describeSkin(info.getSkin()));
                row.add("textures", describeTextures(profile));
                players.add(row);
            }
        }
        out.add("players", players);
        return out;
    }

    private static JsonObject describeSkin(PlayerSkin skin) {
        if (skin == null) {
            return null;
        }
        JsonObject row = new JsonObject();
        row.addProperty("body", skin.body() == null ? null : skin.body().texturePath().toString());
        row.addProperty("cape", skin.cape() == null ? null : skin.cape().texturePath().toString());
        row.addProperty("model", skin.model() == null ? null : skin.model().getSerializedName());
        row.addProperty("secure", skin.secure());
        return row;
    }

    private static JsonArray describeTextures(GameProfile profile) {
        JsonArray rows = new JsonArray();
        for (Property property : profile.properties().get("textures")) {
            JsonObject row = new JsonObject();
            row.addProperty("name", property.name());
            row.addProperty("value", property.value());
            row.addProperty("signature", property.signature());
            row.addProperty("signed", property.hasSignature());
            rows.add(row);
        }
        return rows;
    }

    // --- the client's world, read on the client thread (#675) ---

    /**
     * One row per entity the client holds in its level, within {@code radius}
     * blocks of the player it controls: the client's own entity id, the registry
     * type, the UUID, the name the client draws, the position, whether it is the
     * local player, and for a player the skin the client resolved for that body.
     *
     * <p>This is the world, not the listing. {@link #skinInfo()} reads
     * {@code ClientPacketListener.getOnlinePlayers()}, so it can report a
     * {@code player_info} entry for a UUID whose body the client never draws. This
     * answers the other question: is a body standing in that client's world. A skin
     * row still says nothing about which textures property produced it, and neither
     * op says a person saw anything.
     *
     * <p>Read-only: it iterates the level's entity collection and touches no socket,
     * no packet handler, and no render target.
     */
    private JsonObject entityInfo(double radius) {
        requireWorld();
        Vec3 center = mc.player.position();
        double limit = radius * radius;
        int held = 0;
        List<Entity> near = new ArrayList<>();
        for (Entity entity : mc.level.entitiesForRendering()) {
            held++;
            if (entity.distanceToSqr(center) <= limit) {
                near.add(entity);
            }
        }
        // Nearest first, so a reader sees the bodies this client holds beside it
        // before the ones across the chunk.
        near.sort(Comparator.comparingDouble(entity -> entity.distanceToSqr(center)));
        boolean truncated = near.size() > MAX_ENTITY_ROWS;
        if (truncated) {
            near = near.subList(0, MAX_ENTITY_ROWS);
        }

        JsonObject out = new JsonObject();
        out.addProperty("dimension", mc.level.dimension().toString());
        out.addProperty("radius", radius);
        JsonObject centerRow = new JsonObject();
        centerRow.addProperty("x", center.x);
        centerRow.addProperty("y", center.y);
        centerRow.addProperty("z", center.z);
        out.add("center", centerRow);
        // How many the client held in this level before the radius filtered it: an
        // entity read of a world with a player in it is never empty of itself, so
        // zero says the read is wrong. Named for the level rather than "held",
        // which the status payload already uses for the held item. The local player
        // is the row with "local": true, so the payload carries it once.
        out.addProperty("inLevel", held);
        out.addProperty("truncated", truncated);
        JsonArray rows = new JsonArray();
        for (Entity entity : near) {
            rows.add(entityRow(entity, center));
        }
        out.add("entities", rows);
        return out;
    }

    private JsonObject entityRow(Entity entity, Vec3 center) {
        JsonObject row = new JsonObject();
        row.addProperty("id", entity.getId());
        row.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
        row.addProperty("uuid", entity.getUUID().toString());
        row.addProperty("name", entity.getName().getString());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", entity.getX());
        pos.addProperty("y", entity.getY());
        pos.addProperty("z", entity.getZ());
        row.add("pos", pos);
        row.addProperty("distance", Math.sqrt(entity.distanceToSqr(center)));
        row.addProperty("local", entity == mc.player);
        boolean player = entity instanceof AbstractClientPlayer;
        row.addProperty("player", player);
        row.add("skin", player ? describeSkin(((AbstractClientPlayer) entity).getSkin()) : null);
        return row;
    }

    private JsonObject setPerspective(String mode) {
        CameraType type = switch (mode) {
            case "first" -> CameraType.FIRST_PERSON;
            case "third_front" -> CameraType.THIRD_PERSON_FRONT;
            default -> CameraType.THIRD_PERSON_BACK;
        };
        mc.options.setCameraType(type);
        JsonObject out = new JsonObject();
        out.addProperty("camera", mc.options.getCameraType().name());
        return out;
    }

    /**
     * One clientbound player_info frame, as bytes, through the client's decoder
     * and its player_info handler. The caller builds the bytes with the same
     * protocol data the proxy uses, so the frame is the frame a server sends.
     *
     * An entry is only created when the client holds none for that UUID
     * (ClientPacketListener.handlePlayerInfoUpdate uses putIfAbsent), so an
     * injection for a player the client already knows changes nothing. The
     * response reports that case rather than pretending the frame did
     * something.
     */
    private JsonObject injectPlayerInfo(String hex) {
        requireWorld();
        ClientPacketListener conn = mc.getConnection();
        if (conn == null) {
            throw new IllegalStateException("not connected");
        }
        byte[] bytes = hexToBytes(hex);
        RegistryFriendlyByteBuf buf = new RegistryFriendlyByteBuf(
            Unpooled.wrappedBuffer(bytes), mc.level.registryAccess());
        ClientboundPlayerInfoUpdatePacket packet = ClientboundPlayerInfoUpdatePacket.STREAM_CODEC.decode(buf);
        if (buf.readableBytes() != 0) {
            throw new IllegalStateException("frame has " + buf.readableBytes() + " trailing bytes");
        }
        JsonObject out = new JsonObject();
        JsonArray actions = new JsonArray();
        for (ClientboundPlayerInfoUpdatePacket.Action action : packet.actions()) {
            actions.add(action.name());
        }
        out.add("actions", actions);
        JsonArray entries = new JsonArray();
        for (ClientboundPlayerInfoUpdatePacket.Entry entry : packet.entries()) {
            JsonObject row = new JsonObject();
            row.addProperty("uuid", entry.profileId().toString());
            row.addProperty("name", entry.profile() == null ? null : entry.profile().name());
            row.addProperty("listed", entry.listed());
            row.addProperty("entryExistedBefore", conn.getPlayerInfo(entry.profileId()) != null);
            if (entry.profile() != null) {
                row.add("textures", describeTextures(entry.profile()));
            }
            entries.add(row);
        }
        out.add("entries", entries);
        out.addProperty("bytes", bytes.length);
        packet.handle(conn);
        out.addProperty("delivered", true);
        return out;
    }

    private static byte[] hexToBytes(String hex) {
        String clean = hex == null ? "" : hex.trim();
        if (clean.isEmpty() || clean.length() % 2 != 0) {
            throw new IllegalArgumentException("hex must be an even-length string, got " + clean.length() + " chars");
        }
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int high = Character.digit(clean.charAt(i * 2), 16);
            int low = Character.digit(clean.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) {
                throw new IllegalArgumentException("hex has a non-hex digit at index " + (i * 2));
            }
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }

    private void requireWorld() {
        if (mc.player == null || mc.level == null || mc.gameMode == null) {
            throw new IllegalStateException("not in a world");
        }
    }

    private static JsonObject ok(JsonObject value) {
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.add("data", value);
        return out;
    }

    private static JsonObject error(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("ok", false);
        out.addProperty("error", message);
        return out;
    }
}
