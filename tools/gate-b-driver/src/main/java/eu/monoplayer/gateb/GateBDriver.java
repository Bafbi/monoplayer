package eu.monoplayer.gateb;

import net.fabricmc.api.ClientModInitializer;

import java.io.IOException;

public final class GateBDriver implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        int port = Integer.getInteger("gateb.driver.port", 25599);
        try {
            new DriverServer(port).start();
        } catch (IOException e) {
            throw new RuntimeException("could not start Gate B driver on port " + port, e);
        }
    }
}
