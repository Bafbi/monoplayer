package eu.monoplayer.gateb;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.pipeline.RenderTarget;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Loopback JSON driver for Gate B. This is test instrumentation: it reads
 * client state and invokes the same vanilla interaction calls the input path
 * uses. It never touches the network stack.
 */
public final class DriverServer {
    private static final int TIMEOUT_SECONDS = 10;

    private final Minecraft mc = Minecraft.getInstance();
    private final ServerSocket server;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1, r -> {
        Thread t = new Thread(r, "gate-b-driver-timer");
        t.setDaemon(true);
        return t;
    });

    public DriverServer(int port) throws IOException {
        this.server = new ServerSocket();
        this.server.setReuseAddress(true);
        this.server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
    }

    public void start() {
        Thread thread = new Thread(this::acceptLoop, "gate-b-driver");
        thread.setDaemon(true);
        thread.start();
        System.out.println("[gate-b-driver] listening on 127.0.0.1:" + server.getLocalPort());
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try (Socket socket = server.accept()) {
                socket.setTcpNoDelay(true);
                handle(socket);
            } catch (IOException e) {
                if (!server.isClosed()) {
                    System.err.println("[gate-b-driver] accept failed: " + e.getMessage());
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
                mc.execute(() -> mc.disconnectFromWorld(Component.literal("gate-b-driver")));
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
        out.addProperty("screen", mc.screen == null ? "none" : mc.screen.getClass().getName());
        out.addProperty("level", mc.level != null);
        out.addProperty("player", mc.player != null);
        out.addProperty("connected",
            mc.getConnection() != null && mc.getConnection().getConnection() != null
                && mc.getConnection().getConnection().isConnected());
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
            out.addProperty("renderedSections", mc.levelRenderer.countRenderedSections());
            out.addProperty("totalSections", mc.levelRenderer.getTotalSections());
        }
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
            String name = "gate-b-" + System.currentTimeMillis() + ".png";
            File file = new File(new File(mc.gameDirectory, "screenshots"), name);
            RenderTarget target = mc.getMainRenderTarget();
            Screenshot.grab(mc.gameDirectory, name, target, 1, component -> future.complete(file.getAbsolutePath()));
        });
        JsonObject out = new JsonObject();
        out.addProperty("path", future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS));
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
