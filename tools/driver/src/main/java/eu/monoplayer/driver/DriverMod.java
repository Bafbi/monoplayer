package eu.monoplayer.driver;

import net.fabricmc.api.ClientModInitializer;

import java.io.IOException;

public final class DriverMod implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        int port = Integer.getInteger("gateb.driver.port", 25599);
        try {
            new DriverServer(port).start();
        } catch (IOException e) {
            throw new RuntimeException("could not start the client driver on port " + port, e);
        }
    }
}
